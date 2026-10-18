import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, verifyLedger } from "../audit/ledger.js";
import { loadWorkspace } from "./load.js";
import { migrateV0Config, migrateWorkspaceFile } from "./migrate.js";
import { SCHEMA_VERSION, WorkspaceSchema } from "./schema.js";

const V0 = {
  workspace: "etlaala-ksa",
  business_type: "services",
  pillars: { active: [1, 3, 4, 5, 8, 9, 10] },
  locale: { primary: "ar", also: ["en", "fr"], dialects: ["khaleeji", "masri"], rtl_templates: true, currency: "SAR" },
  models: {
    fast: { provider: "ollama", model: "qwen2.5", timeoutMs: 120000, fallbacks: [{ provider: "google", model: "gemini-3.8-flash" }] },
    reasoning: { provider: "anthropic", model: "claude-sonnet-5-5" },
    creative: { provider: "openai-compatible", model: "gpt-6-luna", baseURL: "http://localhost:20128/v1", timeoutMs: 60000 },
  },
  connectors: {},
  channels: {},
  vault: { promotion: "ask", trust_vault_priors: false },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-migrate-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("migrateV0Config", () => {
  it("produces a config that validates against the 1.0.0 schema", () => {
    const { config } = migrateV0Config(V0);
    expect(WorkspaceSchema.safeParse(config).success).toBe(true);
    expect(config.schema_version).toBe(SCHEMA_VERSION);
  });

  it("restructures slots, renames fields and normalizes the provider id", () => {
    const { config } = migrateV0Config(V0);
    expect(config.models.slots.fast.primary).toMatchObject({ provider: "ollama", model: "qwen2.5", timeout_ms: 120000 });
    expect(config.models.slots.fast.fallbacks?.[0]).toMatchObject({ provider: "google", model: "gemini-3.8-flash" });
    expect(config.models.slots.creative.primary).toMatchObject({
      provider: "openai_compatible",
      base_url: "http://localhost:20128/v1",
      timeout_ms: 60000,
    });
  });

  it("maps identity, locale, currency and vault", () => {
    const { config } = migrateV0Config(V0);
    expect(config.workspace).toMatchObject({ id: "etlaala-ksa", name: "etlaala-ksa", base_currency: "SAR", timezone: "UTC" });
    expect(config.localization.languages).toEqual({ primary: "ar", secondary: "en" });
    expect(config.localization.arabic_dialects?.supported).toEqual(["khaleeji", "masri"]);
    expect(config.vault).toEqual({ promotion: "ask", trust_vault_priors: false });
    expect(config.pillars.active).toEqual([1, 3, 4, 5, 8, 9, 10]);
  });

  it.each([
    ["b2b", "b2b_saas"],
    ["b2c", "ecom"],
    ["ecommerce", "ecom"],
    ["app", "b2b_saas"],
    ["services", "agency"],
  ])("maps business_type %s to %s and says so", (from, to) => {
    const { config, notes } = migrateV0Config({ ...V0, business_type: from });
    expect(config.workspace.business_type).toBe(to);
    expect(notes.join(" ")).toContain(to);
  });

  it("records a note for everything it had to guess or drop", () => {
    const { notes } = migrateV0Config({ ...V0, channels: { whatsapp: { adapter: "cloud_api" } }, connectors: { google_ads: { via: "mcp" } } });
    const text = notes.join("\n");
    expect(text).toMatch(/timezone/i);
    expect(text).toMatch(/fr/); // dropped extra language
    expect(text).toMatch(/rtl_templates/);
    expect(text).toMatch(/connectors/);
    expect(text).toMatch(/channels/);
    expect(text).toMatch(/business_type/);
  });
});

describe("migrateWorkspaceFile and loading a version 0 workspace", () => {
  async function makeV0() {
    const dir = join(root, "ws");
    await new Ledger(join(dir, ".medjay", "audit-log.jsonl")).append({ actor: "system", event: "workspace.created", payload: { workspace: "etlaala-ksa" } });
    await writeFile(join(dir, "workspace.yaml"), `# old\n${stringify(V0)}`);
    return dir;
  }

  it("lets the loader read a v0 file in memory and flags it, without touching the file", async () => {
    const dir = await makeV0();
    const before = await readFile(join(dir, "workspace.yaml"), "utf8");
    const loaded = await loadWorkspace(dir);
    expect(loaded.migrated).toBe(true);
    expect(loaded.notes.length).toBeGreaterThan(0);
    expect(loaded.config.schema_version).toBe(SCHEMA_VERSION);
    expect(await readFile(join(dir, "workspace.yaml"), "utf8")).toBe(before);
  });

  it("rewrites the file, backs up the original, and records the change in the ledger", async () => {
    const dir = await makeV0();
    const result = await migrateWorkspaceFile(dir);
    expect(result.backup).toMatch(/workspace\.yaml\.v0\.bak$/);
    expect((await stat(result.backup)).isFile()).toBe(true);
    expect(parse(await readFile(result.backup, "utf8")).workspace).toBe("etlaala-ksa");

    const loaded = await loadWorkspace(dir);
    expect(loaded.migrated).toBe(false);
    expect(parse(await readFile(join(dir, "workspace.yaml"), "utf8")).schema_version).toBe(SCHEMA_VERSION);

    const ledger = await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"));
    expect(ledger).toMatchObject({ ok: true, entries: 2 });
    const last = JSON.parse((await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").pop()!);
    expect(last).toMatchObject({ event: "workspace.migrated", actor: "system" });
    expect(last.payload).toMatchObject({ from: "0", to: SCHEMA_VERSION });
  });

  it("refuses to migrate a file that is already current", async () => {
    const dir = await makeV0();
    await migrateWorkspaceFile(dir);
    await expect(migrateWorkspaceFile(dir)).rejects.toThrow(/already/);
  });
});
