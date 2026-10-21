// Enforces the dependency rules from SPEC section 5 and the credential-handling rule:
// provider API keys are read in exactly one place.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

// layer -> layers it may import (besides itself and node:/npm packages)
// "shared" is src/version.ts and src/constants.ts: leaves any layer may import.
const ALLOWED: Record<string, string[]> = {
  shared: [],
  audit: ["shared"],
  models: ["shared"],
  ingest: ["store", "audit", "shared"],
  tactics: ["shared"],
  media: ["ingest", "shared"],
  tui: ["cli", "pillars", "analysis", "ingest", "plan", "audit", "shield", "store", "workspace", "shared"],
  shadow: ["ingest", "runtime", "shared"],
  vault: ["tactics", "audit", "ingest", "shared"],
  demo: ["bridge", "analysis", "ingest", "plan", "shield", "store", "audit", "tactics", "workspace", "models", "shared"],
  bridge: ["plan", "models", "shield", "store", "audit", "analysis", "ingest", "style", "tactics", "workspace", "shared"],
  analysis: ["ingest", "store", "audit", "shared"],
  pillars: ["shared"],
  shield: ["shared"],
  store: ["shared"],
  style: ["shared"],
  plan: ["shield", "store", "audit", "models", "ingest", "analysis", "shared"],
  runtime: ["shield", "audit", "style", "plan", "workspace", "store", "models", "shared"],
  workspace: ["models", "audit", "pillars", "shield", "style", "shared"],
  skills: ["shared"],
  doctor: ["workspace", "models", "audit", "pillars", "shield", "store", "style", "shared"],
  cli: ["tui", "media", "shadow", "vault", "demo", "bridge", "tactics", "analysis", "ingest", "doctor", "workspace", "models", "audit", "pillars", "shield", "store", "plan", "style", "runtime", "shared", "root"],
  root: ["cli", "tui", "media", "shadow", "vault", "demo", "bridge", "tactics", "analysis", "ingest", "doctor", "workspace", "models", "audit", "pillars", "shield", "store", "plan", "style", "runtime", "shared"],
};

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const layerOf = (file: string) => {
  const parts = relative(SRC, file).split(sep);
  if (parts.length === 1) return ["version.ts", "constants.ts", "run-events.ts"].includes(parts[0]!) ? "shared" : "root";
  return parts[0]!;
};

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;

describe("architecture", () => {
  it("keeps layers within their allowed dependencies", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const layer = layerOf(file);
      const allowed = ALLOWED[layer];
      if (!allowed) {
        violations.push(`${relative(SRC, file)}: unknown layer "${layer}" (add it to the architecture test)`);
        continue;
      }
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(IMPORT)) {
        const target = join(file, "..", match[1]!);
        const targetLayer = layerOf(target.replace(/\.js$/, ".ts"));
        if (targetLayer !== layer && !allowed.includes(targetLayer)) {
          violations.push(`${relative(SRC, file)} imports ${match[1]} (${layer} -> ${targetLayer})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("reads provider API keys only in models/credentials.ts (plus the secret scanner)", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (rel === "models/credentials.ts" || rel === "shield/secrets.ts") continue;
      if (/process\.env\b[^;\n]*API_KEY|\bAPI_KEY\b/.test(await readFile(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps agent tools unable to write, spawn, or execute plans", async () => {
    const offenders: string[] = [];
    const FORBIDDEN_MODULES = /^(?:node:)?(?:fs|fs\/promises|child_process|net|http|https|http2|dgram|tls|worker_threads|vm|cluster)$/;
    const FORBIDDEN_LOCAL = /\/(?:plan\/(?:strike|export|approve|files|propose|repo|signing)|audit\/ledger|store\/db)\.js$/;
    const IMPORT_ANY = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    // tools act on the world, and the context builder assembles prompts: neither may touch disk, processes or network
    const guarded = [...(await sourceFiles(join(SRC, "runtime", "tools"))), ...(await sourceFiles(join(SRC, "runtime", "context")))];
    for (const file of guarded) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(IMPORT_ANY)) {
        const spec = match[1]!;
        if (FORBIDDEN_MODULES.test(spec) || FORBIDDEN_LOCAL.test(spec)) offenders.push(`${relative(SRC, file)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the registry free of any write path to a platform or a process", async () => {
    const offenders: string[] = [];
    for (const name of ["registry.ts", "scope.ts", "env.ts"]) {
      const text = await readFile(join(SRC, "runtime", name), "utf8");
      if (/child_process|plan\/(?:strike|export|approve)/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
  it("keeps the agent loop unable to spawn processes or execute and approve plans", async () => {
    const offenders: string[] = [];
    const FORBIDDEN = /(?:^(?:node:)?child_process$)|\/plan\/(?:strike|export|approve|signing)\.js$/;
    const IMPORT_ANY = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    for (const file of await sourceFiles(join(SRC, "runtime", "loop"))) {
      for (const match of (await readFile(file, "utf8")).matchAll(IMPORT_ANY)) {
        if (FORBIDDEN.test(match[1]!)) offenders.push(`${relative(SRC, file)} imports ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("keeps the bridge unable to spawn processes, and lets only the handler approve or strike", async () => {
    const offenders: string[] = [];
    const IMPORT_ANY = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    for (const file of await sourceFiles(join(SRC, "bridge"))) {
      const rel = relative(SRC, file).split(sep).join("/");
      for (const match of (await readFile(file, "utf8")).matchAll(IMPORT_ANY)) {
        const spec = match[1]!;
        if (/^(?:node:)?(?:child_process|net|http|https|worker_threads|vm)$/.test(spec)) offenders.push(`${rel} imports ${spec}`);
        if (/\/plan\/(?:strike|approve)\.js$/.test(spec) && rel !== "bridge/handler.ts") offenders.push(`${rel} imports ${spec} (only handler.ts may)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

