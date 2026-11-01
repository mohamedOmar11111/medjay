import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PILLARS } from "../pillars/catalog.js";
import { loadWorkspace } from "../workspace/load.js";
import { initWorkspace, PLACEHOLDER_NAME } from "../workspace/init.js";
import { ProfileError, ProfileStore } from "./profile.js";

let root: string;
let dir: string;
const events: Record<string, unknown>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-profile-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "my-business", name: PLACEHOLDER_NAME, businessType: "ecom" });
  events.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const store = () => new ProfileStore(dir, { audit: async (e) => void events.push(e) });
const yaml = () => readFile(join(dir, "workspace.yaml"), "utf8");
const who = { author: "agent:run_1", reason: "owner described the business" };

describe("propose", () => {
  it("lists each field that would change, from and to, with a diff, and writes nothing", async () => {
    const before = await yaml();
    const p = await store().propose({ name: "Etlaala Travel", base_currency: "SAR", language: "ar" });
    expect(p.changed).toBe(true);
    expect(p.changes).toEqual([
      { field: "name", from: PLACEHOLDER_NAME, to: "Etlaala Travel" },
      { field: "base_currency", from: "USD", to: "SAR" },
      { field: "language", from: "en", to: "ar" },
    ]);
    expect(p.diff).toContain("- name: My business");
    expect(p.diff).toContain("+ name: Etlaala Travel");
    expect(await yaml()).toBe(before);
    expect(events).toEqual([]);
  });

  it("says nothing changes when the values are already there", async () => {
    expect((await store().propose({ base_currency: "USD", language: "en" })).changed).toBe(false);
  });

  it("refuses an empty request and values the workspace schema would refuse, saying why", async () => {
    await expect(store().propose({})).rejects.toThrow(ProfileError);
    await expect(store().propose({ base_currency: "ZZZ" })).rejects.toThrow(/currency/i);
    await expect(store().propose({ base_currency: "sar" })).rejects.toThrow(/currency/i);
    await expect(store().propose({ timezone: "Mars/Base" })).rejects.toThrow(/timezone|IANA/i);
    await expect(store().propose({ business_type: "bakery" as never })).rejects.toThrow(/business_type|ecom/);
    await expect(store().propose({ name: "x".repeat(121) })).rejects.toThrow(/name/);
    await expect(store().propose({ name: "  " })).rejects.toThrow(/name/);
    await expect(store().propose({ language: "arabic" })).rejects.toThrow(/language/);
  });
});

describe("apply", () => {
  it("changes workspace.yaml, keeps its comments, and the workspace still loads", async () => {
    await store().apply({ name: "Etlaala Travel", business_type: "high_ticket_hybrid", base_currency: "SAR", timezone: "Asia/Riyadh", language: "ar", vertical: "umrah and travel packages" }, who);
    const text = await yaml();
    expect(text).toContain("# Medjay workspace");
    const { config } = await loadWorkspace(dir);
    expect(config.workspace).toMatchObject({ name: "Etlaala Travel", business_type: "high_ticket_hybrid", base_currency: "SAR", timezone: "Asia/Riyadh", vertical: "umrah and travel packages" });
    expect(config.localization.languages.primary).toBe("ar");
  });

  it("keeps the old file as a numbered version and tells the audit log which fields changed, not their values", async () => {
    const before = await yaml();
    const r = await store().apply({ name: "Etlaala Travel" }, who);
    expect(r.version).toBe(1);
    expect(await readFile(join(dir, ".medjay", "context-history", "workspace-profile", "v1.yaml"), "utf8")).toBe(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "workspace.profile_updated", author: "agent:run_1", fields: ["name"], version: 1, reason: who.reason });
    expect(JSON.stringify(events)).not.toContain("Etlaala");
  });

  it("does nothing, and logs nothing, when nothing would change", async () => {
    const r = await store().apply({ base_currency: "USD" }, who);
    expect(r.changed).toBe(false);
    expect(events).toEqual([]);
  });

  it("follows the business type with its default pillars, but leaves pillars the owner chose alone", async () => {
    await store().apply({ business_type: "agency" }, who);
    expect((await loadWorkspace(dir)).config.pillars.active).toEqual(DEFAULT_PILLARS.agency);
    const text = (await yaml()).replace(/active:[\s\S]*?(?=\n\S|$)/, "active:\n    - 1");
    await writeFile(join(dir, "workspace.yaml"), text, "utf8");
    await store().apply({ business_type: "b2b_saas" }, who);
    expect((await loadWorkspace(dir)).config.pillars.active).toEqual([1]);
  });

  it("moves an untouched unit-economics file to the new currency, and leaves one that already has numbers", async () => {
    await store().apply({ base_currency: "SAR" }, who);
    expect(await readFile(join(dir, "context", "unit-economics.md"), "utf8")).toMatch(/^currency: SAR$/m);
    const filled = "---\ncurrency: SAR\ncpc: { value: 2, low: 1.5, high: 3, source: owner }\n---\n";
    await writeFile(join(dir, "context", "unit-economics.md"), filled, "utf8");
    const r = await store().apply({ base_currency: "EGP" }, who);
    expect(await readFile(join(dir, "context", "unit-economics.md"), "utf8")).toBe(filled);
    expect(r.unit_economics).toMatch(/left as it is/);
  });

  it("writes through a temp file: no partial file is left behind", async () => {
    await store().apply({ name: "A" }, who);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("keeps the real file untouched when a value is refused", async () => {
    const before = await yaml();
    await expect(store().apply({ name: "Fine", base_currency: "ZZZ" }, who)).rejects.toThrow();
    expect(await yaml()).toBe(before);
  });
});
