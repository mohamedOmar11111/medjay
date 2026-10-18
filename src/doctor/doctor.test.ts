import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialResolver, defaultRef, type KeyStore } from "../models/credentials.js";
import { ModelCatalog } from "../models/catalog.js";
import { initWorkspace } from "../workspace/init.js";
import { runDoctor, type DoctorCheck } from "./checks.js";

function memoryStore(): KeyStore {
  const data = new Map<string, string>();
  return {
    async get(a) {
      return data.get(a) ?? null;
    },
    async set(a, s) {
      data.set(a, s);
    },
    async delete(a) {
      return data.delete(a);
    },
  };
}
const brokenStore: KeyStore = {
  async get() {
    throw new Error("no secret service");
  },
  async set() {
    throw new Error("no secret service");
  },
  async delete() {
    throw new Error("no secret service");
  },
};

type Routes = Record<string, Response | Error | ((init?: RequestInit) => Response)>;
/** Fake fetch keyed by URL. Unlisted URLs behave like a closed port. */
const fakeFetch = (routes: Routes) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const hit = routes[String(input)];
    if (hit === undefined) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? hit(init) : hit.clone();
  }) as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OLLAMA = "http://localhost:11434/v1/models";
const ollamaModels = (...ids: string[]) => json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "library" })) });
const healthyRoutes = (): Routes => ({ [OLLAMA]: ollamaModels("qwen2.5:latest") });

const CATALOG = {
  anthropic: { models: { "claude-sonnet-5-5": { id: "claude-sonnet-5-5" } } },
  google: { models: { "gemini-3.8-flash": { id: "gemini-3.8-flash" } } },
};

let root: string;
let ws: string;
let catalogFile: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-doctor-"));
  ws = join(root, "ws");
  catalogFile = join(root, "catalog.json");
  await initWorkspace({ dir: ws, id: "ws", businessType: "high_ticket_hybrid" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)!;
const catalogWith = (body: unknown | Error = CATALOG) =>
  new ModelCatalog({
    cacheFile: catalogFile,
    fetchFn: (async () => {
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
  });

async function edit(change: (config: Record<string, any>) => void) {
  const path = join(ws, "workspace.yaml");
  const config = parse(await readFile(path, "utf8"));
  change(config);
  await writeFile(path, stringify(config));
}

const run = (over: Partial<Parameters<typeof runDoctor>[0]> = {}, routes: Routes = healthyRoutes()) =>
  runDoctor({
    cwd: ws,
    env: { MEDJAY_ANTHROPIC_API_KEY: "k" },
    keystore: memoryStore(),
    fetchFn: fakeFetch(routes),
    catalog: catalogWith(),
    ...over,
  });

describe("runDoctor: basics", () => {
  it("passes a healthy setup", async () => {
    const report = await run();
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    for (const id of ["node", "keychain", "workspace", "credentials", "endpoints", "dropzone", "store", "ledger"]) {
      expect(byId(report.checks, id).status, id).toBe("pass");
    }
  });

  it("fails when a required cloud credential is missing and names the fix without printing secrets", async () => {
    const report = await run({ env: {} });
    const check = byId(report.checks, "credentials");
    expect(check.status).toBe("fail");
    expect(check.remedy).toMatch(/mdj auth set anthropic|MEDJAY_ANTHROPIC_API_KEY/);
    expect(report.ok).toBe(false);
  });

  it("honors per-target keychain_ref and env_fallback", async () => {
    await edit((c) => {
      c.models.slots.reasoning.primary.keychain_ref = "client_a";
      c.models.slots.reasoning.primary.env_fallback = "MEDJAY_CLIENT_A_KEY";
      c.models.slots.creative.primary.keychain_ref = "client_a";
      c.models.slots.creative.primary.env_fallback = "MEDJAY_CLIENT_A_KEY";
    });
    expect(byId((await run({ env: {} })).checks, "credentials").status).toBe("fail");
    expect(byId((await run({ env: { MEDJAY_CLIENT_A_KEY: "k" } })).checks, "credentials").status).toBe("pass");
    const store = memoryStore();
    await new CredentialResolver({ keystore: store, env: {} }).store("client_a", "k");
    expect(byId((await run({ env: {}, keystore: store })).checks, "credentials").status).toBe("pass");
  });

  it("accepts a default-reference credential held in the keychain", async () => {
    const store = memoryStore();
    await new CredentialResolver({ keystore: store, env: {} }).store(defaultRef("anthropic").keychainRef, "k");
    expect(byId((await run({ env: {}, keystore: store })).checks, "credentials").status).toBe("pass");
  });

  it("warns, not fails, when the OS keychain is unavailable (headless use)", async () => {
    const report = await run({ keystore: brokenStore });
    expect(byId(report.checks, "keychain").status).toBe("warn");
    expect(byId(report.checks, "keychain").remedy).toMatch(/MEDJAY_/);
    expect(byId(report.checks, "credentials").status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("detects a tampered ledger", async () => {
    const path = join(ws, ".medjay", "audit-log.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).replace("workspace.created", "workspace.deleted"));
    const check = byId((await run()).checks, "ledger");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/hash_mismatch/);
  });

  it("reports an invalid workspace.yaml with the failing path and skips dependent checks", async () => {
    await edit((c) => {
      c.workspace.business_type = "nonsense";
    });
    const report = await run();
    expect(byId(report.checks, "workspace").status).toBe("fail");
    expect(byId(report.checks, "workspace").detail).toMatch(/business_type/);
    expect(byId(report.checks, "credentials").status).toBe("skip");
  });

  it("skips workspace checks outside a workspace but still checks node and keychain", async () => {
    const report = await run({ cwd: root });
    expect(byId(report.checks, "workspace").status).toBe("skip");
    expect(byId(report.checks, "node").status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("warns about a version 0 workspace and points at mdj migrate", async () => {
    const path = join(ws, "workspace.yaml");
    const v0 = { workspace: "ws", business_type: "services", pillars: { active: [1] }, locale: { primary: "en", currency: "USD" },
      models: { fast: { provider: "ollama", model: "qwen2.5" }, reasoning: { provider: "ollama", model: "qwen2.5" }, creative: { provider: "ollama", model: "qwen2.5" } } };
    await writeFile(path, stringify(v0));
    const check = byId((await run()).checks, "workspace");
    expect(check.status).toBe("warn");
    expect(check.remedy).toMatch(/mdj migrate/);
  });
});

describe("runDoctor: local endpoints and models", () => {
  it("passes when /v1/models answers 200 and lists the configured model (qwen2.5 matches qwen2.5:latest)", async () => {
    const check = byId((await run()).checks, "endpoints");
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/qwen2\.5/);
  });

  it("fails when the model is not pulled and lists what is available", async () => {
    const check = byId((await run({}, { [OLLAMA]: ollamaModels("llama3.1:8b", "gemma4:latest") })).checks, "endpoints");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/qwen2\.5.*not (found|listed)/i);
    expect(check.detail).toMatch(/gemma4:latest/);
    expect(check.remedy).toMatch(/ollama pull qwen2\.5/);
  });

  it("fails on a wrong base path and hints at Ollama's /v1", async () => {
    await edit((c) => {
      c.models.slots.fast.primary.base_url = "http://127.0.0.1:11434/api";
    });
    const check = byId((await run({}, { "http://127.0.0.1:11434/api/models": new Response("nf", { status: 404 }) })).checks, "endpoints");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/404/);
    expect(check.remedy).toMatch(/\/v1/);
  });

  it("fails with a clean message when the endpoint refuses connections", async () => {
    const check = byId((await run({}, {})).checks, "endpoints");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("localhost:11434");
    expect(check.remedy).toMatch(/ollama serve|base_url/);
  });

  it("warns, not fails, when only a fallback endpoint is down", async () => {
    await edit((c) => {
      c.models.slots.fast.fallbacks = [{ provider: "openai_compatible", model: "gpt-6-luna", base_url: "http://127.0.0.1:20128/v1" }];
    });
    const check = byId((await run()).checks, "endpoints");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("127.0.0.1:20128");
  });

  it("reports upstream metadata for a local proxy and checks the model there", async () => {
    await edit((c) => {
      c.models.slots.creative.primary = { provider: "openai_compatible", model: "gpt-6-luna", base_url: "http://127.0.0.1:20128/v1" };
    });
    const proxy = json({ data: [{ id: "gpt-6-luna", owned_by: "openai", created: 1760000000 }, { id: "claude-haiku-5-5", owned_by: "anthropic" }] });
    const check = byId((await run({}, { ...healthyRoutes(), "http://127.0.0.1:20128/v1/models": proxy })).checks, "endpoints");
    expect(check.status).toBe("pass");
    expect(check.detail).toMatch(/127\.0\.0\.1:20128/);
    expect(check.detail).toMatch(/owned_by openai/);
    expect(check.detail).toMatch(/2 models/);
  });

  it("sends the proxy credential only to the configured proxy, and never prints it", async () => {
    await edit((c) => {
      c.models.slots.creative.primary = { provider: "openai_compatible", model: "gpt-6-luna", base_url: "http://127.0.0.1:20128/v1" };
    });
    let seenAuth: string | undefined;
    const proxy = (init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return json({ data: [{ id: "gpt-6-luna" }] });
    };
    const report = await run(
      { env: { MEDJAY_ANTHROPIC_API_KEY: "k", MEDJAY_OPENAI_COMPATIBLE_API_KEY: "proxy-secret-123" } },
      { ...healthyRoutes(), "http://127.0.0.1:20128/v1/models": proxy },
    );
    expect(seenAuth).toBe("Bearer proxy-secret-123");
    expect(JSON.stringify(report)).not.toContain("proxy-secret-123");
  });

  it("warns that a 401 endpoint needs a credential instead of calling it down", async () => {
    await edit((c) => {
      c.models.slots.creative.primary = { provider: "openai_compatible", model: "m", base_url: "http://127.0.0.1:20128/v1" };
    });
    const check = byId((await run({}, { ...healthyRoutes(), "http://127.0.0.1:20128/v1/models": new Response("no", { status: 401 }) })).checks, "endpoints");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/401|authentication|credential/i);
  });

  it("warns when the model list cannot be read", async () => {
    const check = byId((await run({}, { [OLLAMA]: new Response("<html>not json</html>", { status: 200 }) })).checks, "endpoints");
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/model list/i);
  });

  it("uses a custom healthcheck_path", async () => {
    await edit((c) => {
      c.models.slots.fast.primary.healthcheck_path = "/health/models";
    });
    const check = byId((await run({}, { "http://localhost:11434/v1/health/models": ollamaModels("qwen2.5") })).checks, "endpoints");
    expect(check.status).toBe("pass");
  });
});

describe("runDoctor: models, pillars, dropzone, store", () => {
  it("passes when every vendor model id is in the catalog", async () => {
    expect(byId((await run()).checks, "models").status).toBe("pass");
  });

  it("warns about a model id the catalog does not know (likely a typo)", async () => {
    await edit((c) => {
      c.models.slots.reasoning.primary.model = "claude-sonet-5-5";
    });
    const check = byId((await run()).checks, "models");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("claude-sonet-5-5");
  });

  it("skips the model-id check when the catalog is unavailable", async () => {
    const report = await run({ catalog: catalogWith(new TypeError("offline")) });
    expect(byId(report.checks, "models").status).toBe("skip");
    expect(report.ok).toBe(true);
  });

  it("warns that pillar 11 is stubbed until after M3", async () => {
    await edit((c) => {
      c.pillars.active = [1, 8, 11];
    });
    const check = byId((await run()).checks, "pillars");
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/11/);
  });

  it("warns when the dropzone folder does not exist yet", async () => {
    await rm(join(ws, "data", "imports"), { recursive: true });
    expect(byId((await run()).checks, "dropzone").status).toBe("warn");
  });

  it("fails when the machine-state database cannot be opened", async () => {
    await mkdir(join(ws, ".medjay", "experiments.db"), { recursive: true }); // a folder where the file should be
    expect(byId((await run()).checks, "store").status).toBe("fail");
  });
});
