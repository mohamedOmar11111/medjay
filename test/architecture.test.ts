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
  pillars: ["shared"],
  shield: ["shared"],
  store: ["shared"],
  workspace: ["models", "audit", "pillars", "shield", "shared"],
  doctor: ["workspace", "models", "audit", "pillars", "store", "shared"],
  cli: ["doctor", "workspace", "models", "audit", "pillars", "shield", "store", "shared", "root"],
  root: ["cli", "doctor", "workspace", "models", "audit", "pillars", "shield", "store", "shared"],
};

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const layerOf = (file: string) => {
  const parts = relative(SRC, file).split(sep);
  if (parts.length === 1) return parts[0] === "version.ts" || parts[0] === "constants.ts" ? "shared" : "root";
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
      if (rel === "models/credentials.ts" || rel === "workspace/secrets.ts") continue;
      if (/process\.env\b[^;\n]*API_KEY|\bAPI_KEY\b/.test(await readFile(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
