import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyLedger } from "../audit/ledger.js";
import { VERSION } from "../version.js";
import { initWorkspace } from "./init.js";
import { findWorkspace, loadWorkspace, WorkspaceError } from "./load.js";
import { SCHEMA_VERSION } from "./schema.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-ws-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (path: string) => stat(path).then(() => true, () => false);

async function make(name = "ws", over: Partial<Parameters<typeof initWorkspace>[0]> = {}) {
  const dir = join(root, name);
  await initWorkspace({ dir, id: name, businessType: "high_ticket_hybrid", ...over });
  return dir;
}

async function edit(dir: string, change: (config: Record<string, any>) => void) {
  const path = join(dir, "workspace.yaml");
  const config = parse(await readFile(path, "utf8"));
  change(config);
  await writeFile(path, stringify(config));
}

const issuesOf = async (dir: string) => ((await loadWorkspace(dir).catch((e) => e)) as WorkspaceError).issues ?? [];
const failing = async (dir: string) => (await loadWorkspace(dir).catch((e) => e)) as WorkspaceError;

describe("initWorkspace (schema 1.0.0)", () => {
  it("creates the documented layout, a loadable workspace.yaml and a verifiable genesis ledger entry", async () => {
    const dir = await make("etlaala-ksa", { name: "Etlaala KSA", timezone: "Asia/Riyadh", baseCurrency: "SAR" });
    for (const rel of [
      "workspace.yaml",
      "shield.policy.yaml",
      "context/brand-voice.md",
      "context/unit-economics.md",
      "context/offer-matrix.md",
      "context/seasonal-calendar.md",
      "context/claims.md",
      "tactics",
      "data/imports",
      "plans",
      ".medjay/audit-log.jsonl",
    ]) {
      expect(await exists(join(dir, rel)), rel).toBe(true);
    }
    const { config } = await loadWorkspace(dir);
    expect(config.schema_version).toBe(SCHEMA_VERSION);
    expect(config.workspace).toMatchObject({
      id: "etlaala-ksa",
      name: "Etlaala KSA",
      business_type: "high_ticket_hybrid",
      timezone: "Asia/Riyadh",
      base_currency: "SAR",
    });
    expect(config.pillars.active).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10]);
    expect(config.models.slots.reasoning.primary).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(config.vault.promotion).toBe("off");

    expect(await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"))).toMatchObject({ ok: true, entries: 1 });
    const first = JSON.parse((await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).split("\n")[0]!);
    expect(first).toMatchObject({ event: "workspace.created", actor: "system" });
    expect(first.payload).toMatchObject({ medjay_version: VERSION, schema_version: SCHEMA_VERSION });
  });

  it("defaults the reasoning and creative slots to Sonnet and the fast slot to a local model", async () => {
    const { config } = await loadWorkspace(await make());
    expect(config.models.slots.fast.primary).toMatchObject({ provider: "ollama", model: "qwen2.5" });
    expect(config.models.slots.creative.primary.model).toBe("claude-sonnet-5-5");
  });

  it("applies model overrides", async () => {
    const dir = await make("ws", {
      models: { fast: "google/gemini-3.8-flash", reasoning: "anthropic/claude-haiku-5-5", creative: "anthropic/claude-sonnet-5-5" },
    });
    const { config } = await loadWorkspace(dir);
    expect(config.models.slots.fast.primary).toMatchObject({ provider: "google", model: "gemini-3.8-flash" });
    expect(config.models.slots.reasoning.primary.model).toBe("claude-haiku-5-5");
  });

  it("refuses an openai_compatible override that has no base_url to point at", async () => {
    await expect(make("ws2", { models: { creative: "openai_compatible/gpt-6-luna" } })).rejects.toThrow(/base_url/);
  });

  it.each([
    ["ecom", [1, 2, 3, 4, 6, 7, 8, 9, 10]],
    ["b2b_saas", [1, 3, 4, 5, 7, 8, 9, 10]],
    ["high_ticket_hybrid", [1, 2, 3, 4, 5, 6, 8, 9, 10]],
    ["agency", [1, 2, 3, 4, 8, 9, 10]],
    ["local_leadgen", [1, 3, 4, 5, 8, 9, 10]],
  ] as const)("maps business_type %s to its default pillars (never pillar 11)", async (type, pillars) => {
    const { config } = await loadWorkspace(await make(`ws-${type}`, { businessType: type }));
    expect(config.pillars.active).toEqual(pillars);
  });

  it("refuses to overwrite an existing workspace", async () => {
    const dir = await make();
    await expect(initWorkspace({ dir, id: "ws", businessType: "agency" })).rejects.toThrow(/already/);
  });

  it("works in a folder with an Arabic name", async () => {
    const dir = await make("عميل-مصر");
    // ids are filesystem-safe ascii-or-unicode letters; Arabic letters are allowed
    expect((await loadWorkspace(dir)).config.workspace.id).toBe("عميل-مصر");
  });

  it("never writes secrets, phone numbers, approver lists or fixed-convention paths into workspace.yaml", async () => {
    const dir = await make();
    const text = (await readFile(join(dir, "workspace.yaml"), "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(text).not.toMatch(/api[_-]?key|secret|password|\+\d{8,}|authorized_senders|approvers|^paths:/im);
    expect(text).not.toMatch(/allow_voice|require_typed|display_currencies|server-filesystem/);
  });

  it("writes a shield policy with an empty approver list and the approver rules documented", async () => {
    const policy = parse(await readFile(join(await make(), "shield.policy.yaml"), "utf8"));
    expect(policy.whatsapp.approvers).toEqual([]);
  });
});

describe("loadWorkspace", () => {
  it("reports schema problems with their paths", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.workspace.business_type = "nonsense";
    });
    expect((await issuesOf(dir)).some((i) => i.path === "workspace.business_type")).toBe(true);
  });

  it("rejects the M0 business types with a pointer to the new ones", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.workspace.business_type = "services";
    });
    const error = await failing(dir);
    expect(error.issues.some((i) => i.path === "workspace.business_type")).toBe(true);
  });

  it("rejects a plaintext secret and a raw phone number without echoing them", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.vertical = "travel";
      c.note = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
      c.owner = "+201000000000";
    });
    const error = await failing(dir);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toMatch(/keychain|MEDJAY_/);
    expect(error.message).not.toContain("sk-ant-api03");
    expect(error.message).not.toContain("+201000000000");
    expect(error.issues.map((i) => i.path).sort()).toEqual(["note", "owner"]);
  });

  it("accepts the log_token_telemetry-style key names that used to trip the scanner", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.models.routing.log_usage = true;
    });
    await expect(loadWorkspace(dir)).resolves.toBeDefined();
  });

  it("rejects unknown keys and duplicate keys", async () => {
    const dir = await make();
    const path = join(dir, "workspace.yaml");
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}\nmystery: 1\n`);
    await expect(loadWorkspace(dir)).rejects.toBeInstanceOf(WorkspaceError);
    await writeFile(path, `${original}\nschema_version: "1.0.0"\n`);
    await expect(loadWorkspace(dir)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("explains that voice and confirmation rules are fixed, not configurable", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.command_bridge = { whatsapp: { enabled: false, allow_voice_for_strike: true, require_typed_confirmation: false } };
    });
    const messages = (await issuesOf(dir)).map((i) => i.message).join(" | ");
    expect(messages).toMatch(/engine invariant/i);
  });

  it("defaults the style block and refuses to make client copy or approvals terse", async () => {
    const dir = await make();
    const { config } = await loadWorkspace(dir);
    expect(config.style.caveman).toEqual({ internal: "full", whatsapp: "lite" });
    expect(config.style.slop.fail_on).toBe("error");
    await edit(dir, (c) => {
      c.style.caveman.client_copy = "ultra";
    });
    expect((await issuesOf(dir)).map((i) => i.message).join(" | ")).toMatch(/always plain/i);
  });

  it("explains that paths are fixed by convention", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.paths = { machine_state: { audit_ledger: "./elsewhere.jsonl" } };
    });
    expect((await issuesOf(dir)).map((i) => i.message).join(" | ")).toMatch(/fixed by convention/i);
  });

  it("explains that display_currencies is gone (no silent conversion)", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.workspace.display_currencies = ["SAR", "USD"];
    });
    expect((await issuesOf(dir)).map((i) => i.message).join(" | ")).toMatch(/currency conversion/i);
  });

  it("explains that approver lists belong in shield.policy.yaml", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.command_bridge = { whatsapp: { enabled: false, authorized_senders: ["abc"] } };
    });
    expect((await issuesOf(dir)).map((i) => i.message).join(" | ")).toMatch(/shield\.policy\.yaml/);
  });

  it("validates timezone as IANA and base_currency as ISO 4217", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.workspace.timezone = "Mars/Phobos";
      c.workspace.base_currency = "ZZZ";
    });
    const paths = (await issuesOf(dir)).map((i) => i.path);
    expect(paths).toContain("workspace.timezone");
    expect(paths).toContain("workspace.base_currency");
  });

  it("validates markets, topology and pillars", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.localization.primary_markets = ["SA", "ksa"];
      c.localization.conversion_topology = "carrier_pigeon";
      c.pillars = { active: [12, 3, 3], overrides: { "13": { default_slot: "fast" }, "2": { default_slot: "huge" } } };
    });
    const paths = (await issuesOf(dir)).map((i) => i.path);
    expect(paths.some((p) => p.startsWith("localization.primary_markets"))).toBe(true);
    expect(paths).toContain("localization.conversion_topology");
    expect(paths.some((p) => p.startsWith("pillars.active"))).toBe(true);
    expect(paths.some((p) => p.startsWith("pillars.overrides"))).toBe(true);
  });

  it("accepts pillar 11 and overrides, keeping the catalog out of the file", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.pillars = { active: [1, 8, 11], overrides: { "1": { default_slot: "fast" } } };
    });
    const { config } = await loadWorkspace(dir);
    expect(config.pillars.active).toEqual([1, 8, 11]);
    expect(config.pillars.overrides["1"]).toEqual({ default_slot: "fast" });
  });

  it("rejects an unpinned or write-capable filesystem MCP server", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.ingestion.mcp_servers = [
        { name: "filesystem-workspace", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "./"], version: "1.0.0" },
      ];
    });
    expect((await issuesOf(dir)).map((i) => i.message).join(" | ")).toMatch(/filesystem/i);
  });

  it("requires pinned versions for MCP servers launched through a package runner", async () => {
    const dir = await make();
    const server = (args: string[], version?: string) => ({
      name: "ga4", transport: "stdio", command: "npx", args, ...(version ? { version } : {}),
    });
    await edit(dir, (c) => {
      c.ingestion.mcp_servers = [server(["-y", "ga4-mcp"])];
    });
    expect((await issuesOf(dir)).length).toBeGreaterThan(0);
    await edit(dir, (c) => {
      c.ingestion.mcp_servers = [server(["-y", "ga4-mcp@1.4.2"], "1.4.2")];
    });
    const { config } = await loadWorkspace(dir);
    expect(config.ingestion.mcp_servers[0]).toMatchObject({ mode: "read_only", enabled: true });
  });

  it("keeps dropzone_dir inside the workspace and returns it resolved", async () => {
    const dir = await make();
    const loaded = await loadWorkspace(dir);
    expect(loaded.dropzoneDir).toBe(join(dir, "data", "imports"));
    await edit(dir, (c) => {
      c.ingestion.dropzone_dir = "../outside";
    });
    expect((await issuesOf(dir)).map((i) => i.path)).toContain("ingestion.dropzone_dir");
  });

  it("validates the WhatsApp bridge when enabled and keeps credentials as references", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.command_bridge = { whatsapp: { enabled: true, provider: "respond_io_webhook" } };
    });
    const paths = (await issuesOf(dir)).map((i) => i.path);
    expect(paths.some((p) => p.includes("channel_id") || p.includes("webhook_url") || p.includes("credentials") || p.includes("templates"))).toBe(true);

    await edit(dir, (c) => {
      c.command_bridge = {
        whatsapp: {
          enabled: true,
          provider: "whatsapp_cloud_api",
          channel_id: "109876543210987",
          webhook_url: "https://hooks.example.com/medjay/wa",
          credentials: {
            api_token: { keychain_ref: "wa_api_token", env_fallback: "MEDJAY_WA_API_TOKEN" },
            webhook_secret: { keychain_ref: "wa_webhook_secret", env_fallback: "MEDJAY_WA_WEBHOOK_SECRET" },
          },
          templates: { pulse: "medjay_pulse", approval_card: "medjay_approval", alert: "medjay_alert" },
        },
      };
    });
    await expect(loadWorkspace(dir)).resolves.toBeDefined();
  });

  it("accepts a generic_hmac relay with its own signature header, field pointers and a transport, and keeps the old provider names loading", async () => {
    const dir = await make();
    const bridge = (over: Record<string, unknown>) => ({
      whatsapp: {
        enabled: true,
        channel_id: "1",
        webhook_url: "https://hooks.example.com/wa",
        credentials: {
          api_token: { keychain_ref: "wa_api_token", env_fallback: "MEDJAY_WA_API_TOKEN" },
          webhook_secret: { keychain_ref: "wa_webhook_secret", env_fallback: "MEDJAY_WA_WEBHOOK_SECRET" },
        },
        templates: { pulse: "p", approval_card: "a", alert: "l" },
        ...over,
      },
    });
    await edit(dir, (c) => {
      c.command_bridge = bridge({
        provider: "generic_hmac",
        webhook: { signature_header: "X-CRM-Signature", signature_format: "base64", fields: { message_id: "id", sender_phone: "contact.phone", message_type: "kind", text: "body" }, type_map: { audio: ["ptt"] } },
        transport: { type: "generic_webhook", url: "https://relay.example.com/send" },
      });
    });
    const { config } = await loadWorkspace(dir);
    expect(config.command_bridge.whatsapp.webhook?.signature_format).toBe("base64");
    expect(config.command_bridge.whatsapp.transport?.type).toBe("generic_webhook");

    await edit(dir, (c) => {
      c.command_bridge = bridge({ provider: "respond_io_webhook" });
    });
    await expect(loadWorkspace(dir)).resolves.toBeDefined();
  });

  it("rejects a generic_hmac bridge with no webhook block, a bad signature format, and transports missing what they need", async () => {
    const dir = await make();
    const base = {
      enabled: true,
      channel_id: "1",
      webhook_url: "https://hooks.example.com/wa",
      credentials: {
        api_token: { keychain_ref: "wa_api_token", env_fallback: "MEDJAY_WA_API_TOKEN" },
        webhook_secret: { keychain_ref: "wa_webhook_secret", env_fallback: "MEDJAY_WA_WEBHOOK_SECRET" },
      },
      templates: { pulse: "p", approval_card: "a", alert: "l" },
    };
    const paths = async (over: Record<string, unknown>) => {
      await edit(dir, (c) => {
        c.command_bridge = { whatsapp: { ...base, ...over } };
      });
      return (await issuesOf(dir)).map((i) => i.path);
    };
    expect(await paths({ provider: "generic_hmac" })).toContain("command_bridge.whatsapp.webhook");
    expect((await paths({ provider: "generic_hmac", webhook: { signature_format: "md5" } })).join(",")).toMatch(/signature_format/);
    expect((await paths({ provider: "cloud_api", transport: { type: "generic_webhook" } })).join(",")).toMatch(/url/);
    expect((await paths({ provider: "cloud_api", transport: { type: "cloud_api" } })).join(",")).toMatch(/phone_number_id/);
    expect((await paths({ provider: "cloud_api", transport: { type: "generic_webhook", url: "http://insecure.example.com" } })).join(",")).toMatch(/url/);
  });

  it("requires https webhooks, MEDJAY_* env references and an acknowledgement for the unsupported bridge", async () => {
    const dir = await make();
    const base = {
      enabled: true,
      channel_id: "1",
      webhook_url: "http://hooks.example.com/wa",
      credentials: {
        api_token: { keychain_ref: "wa_api", env_fallback: "WHATSAPP_TOKEN" },
        webhook_secret: { keychain_ref: "wa_sec", env_fallback: "MEDJAY_WA_SECRET" },
      },
      templates: { pulse: "a", approval_card: "b", alert: "c" },
    };
    await edit(dir, (c) => {
      c.command_bridge = { whatsapp: { ...base, provider: "local_baileys" } };
    });
    const paths = (await issuesOf(dir)).map((i) => i.path);
    expect(paths.some((p) => p.endsWith("webhook_url"))).toBe(true);
    expect(paths.some((p) => p.endsWith("env_fallback"))).toBe(true);
    expect(paths.some((p) => p.endsWith("unsupported_acknowledged"))).toBe(true);
  });

  it("fails clearly when workspace.yaml is missing", async () => {
    await expect(loadWorkspace(root)).rejects.toThrow(/workspace\.yaml/);
  });
});

describe("findWorkspace", () => {
  it("walks up from a nested folder to the workspace root", async () => {
    const dir = await make();
    const nested = join(dir, "data", "imports");
    await mkdir(nested, { recursive: true });
    expect(await findWorkspace(nested)).toBe(dir);
  });

  it("returns null when no workspace exists above", async () => {
    expect(await findWorkspace(root)).toBeNull();
  });
});

describe("skills and plugins sections", () => {
  it("default to nothing linked and nothing opted in", async () => {
    const dir = await make();
    const { config } = await loadWorkspace(dir);
    expect(config.skills).toEqual({ paths: [], include_claude_global: false });
    expect(config.plugins).toEqual({ paths: [], include: [] });
  });

  it("accept linked roots with a trust level, defaulting to untrusted", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.skills = { paths: [{ path: "C:/hq/.claude/skills", trust: "owner", name: "hq" }, { path: "~/more" }], include_claude_global: true };
      c.plugins = { include: ["caveman@caveman"] };
    });
    const { config } = await loadWorkspace(dir);
    expect(config.skills.paths).toEqual([{ path: "C:/hq/.claude/skills", trust: "owner", name: "hq" }, { path: "~/more", trust: "untrusted" }]);
    expect(config.skills.include_claude_global).toBe(true);
    expect(config.plugins.include).toEqual(["caveman@caveman"]);
  });

  it("rejects an unknown trust level and stray keys", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.skills = { paths: [{ path: "x", trust: "friend" }], colour: "red" };
    });
    const issues = await issuesOf(dir);
    expect(issues.some((i) => i.path.startsWith("skills.paths"))).toBe(true);
    expect(issues.some((i) => i.path === "skills.colour")).toBe(true);
  });
});

describe("mounts section", () => {
  it("defaults to none, and accepts named read-only folders with a trust level", async () => {
    const dir = await make();
    expect((await loadWorkspace(dir)).config.mounts).toEqual([]);
    await edit(dir, (c) => {
      c.mounts = [{ name: "hq", path: "C:/hq", trust: "owner" }, { name: "swipe", path: "~/swipe" }];
    });
    expect((await loadWorkspace(dir)).config.mounts).toEqual([{ name: "hq", path: "C:/hq", trust: "owner" }, { name: "swipe", path: "~/swipe", trust: "untrusted" }]);
  });
  it("rejects a one-letter name (it would look like a drive), a duplicate name and a bad trust level", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.mounts = [{ name: "c", path: "x" }, { name: "zz", path: "y", trust: "friend" }];
    });
    const paths = (await issuesOf(dir)).map((i) => i.path);
    expect(paths.some((p) => p.startsWith("mounts[0]") || p.startsWith("mounts.0"))).toBe(true);
    expect(paths.some((p) => p.startsWith("mounts") && p.includes("trust"))).toBe(true);
  });
  it("rejects the same mount name twice", async () => {
    const dir = await make();
    await edit(dir, (c) => {
      c.mounts = [{ name: "hq", path: "a" }, { name: "hq", path: "b" }];
    });
    expect((await issuesOf(dir)).some((i) => /duplicate/i.test(i.message))).toBe(true);
  });
});
