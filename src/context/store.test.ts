import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { CONTEXT_FILES, ContextError, ContextStore, MAX_CONTEXT_BYTES } from "./store.js";

let root: string;
let dir: string;
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const events: Record<string, unknown>[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-context-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  events.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = () => new ContextStore(dir, { audit: async (e) => void events.push(e) });
const OFFERS = "---\nworkspace: ws\n---\n# Offers\n\nUmrah 7 nights, 4200 SAR, BNPL on request.\n";

describe("which files", () => {
  it("are exactly the four context files the guide asks for", () => {
    expect([...CONTEXT_FILES]).toEqual(["unit-economics", "offer-matrix", "brand-voice", "claims"]);
  });

  it("refuses every other name, including path tricks, other config and case changes", async () => {
    const listing = (await readdir(dir)).sort();
    const bad = [
      "../workspace",
      "..\\shield.policy",
      "workspace.yaml",
      "shield.policy.yaml",
      "shield.policy",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "context/offer-matrix",
      "offer-matrix.md",
      "Offer-Matrix",
      "UNIT-ECONOMICS",
      "seasonal-calendar",
      "offer-matrix\0",
      "offer-matrix ",
      "",
    ];
    for (const name of bad) {
      await expect(store().propose(name as never, OFFERS), name).rejects.toThrow(ContextError);
      await expect(store().apply(name as never, OFFERS, { author: "t", reason: "x" }), name).rejects.toThrow(ContextError);
    }
    expect((await readdir(dir)).sort()).toEqual(listing);
    await expect(readFile(join(dir, "workspace.yaml"), "utf8")).resolves.not.toContain("Umrah");
  });
});

describe("propose (what would change, no writing)", () => {
  it("returns the diff and both hashes and writes nothing", async () => {
    const before = await readFile(join(dir, "context", "offer-matrix.md"), "utf8");
    const p = await store().propose("offer-matrix", OFFERS);
    expect(p).toMatchObject({ file: "offer-matrix", changed: true, before_sha256: sha(before), after_sha256: sha(OFFERS) });
    expect(p.diff.added).toBeGreaterThan(0);
    expect(p.diff.text).toContain("+ Umrah 7 nights");
    expect(await readFile(join(dir, "context", "offer-matrix.md"), "utf8")).toBe(before);
    expect(events).toEqual([]);
  });

  it("says nothing changed when the text is the same", async () => {
    const same = await readFile(join(dir, "context", "offer-matrix.md"), "utf8");
    expect((await store().propose("offer-matrix", same)).changed).toBe(false);
  });
});

describe("apply", () => {
  it("replaces the file, keeps the old text as a numbered version and tells the audit log (hashes, never text)", async () => {
    const before = await readFile(join(dir, "context", "offer-matrix.md"), "utf8");
    const r = await store().apply("offer-matrix", OFFERS, { author: "agent:run_1", reason: "owner gave the offers" });
    expect(r).toMatchObject({ file: "offer-matrix", version: 1, before_sha256: sha(before), after_sha256: sha(OFFERS) });
    expect(await readFile(join(dir, "context", "offer-matrix.md"), "utf8")).toBe(OFFERS);
    expect(await readFile(join(dir, ".medjay", "context-history", "offer-matrix", "v1.md"), "utf8")).toBe(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "context.updated", author: "agent:run_1", file: "offer-matrix", version: 1, before_sha256: sha(before), after_sha256: sha(OFFERS), reason: "owner gave the offers" });
    expect(JSON.stringify(events)).not.toContain("Umrah");
  });

  it("numbers the history up on every change", async () => {
    await store().apply("offer-matrix", OFFERS, { author: "a", reason: "one" });
    const r = await store().apply("offer-matrix", `${OFFERS}\nMore.\n`, { author: "a", reason: "two" });
    expect(r.version).toBe(2);
    expect(await readFile(join(dir, ".medjay", "context-history", "offer-matrix", "v2.md"), "utf8")).toBe(OFFERS);
  });

  it("normalises line endings to LF and leaves no temp file behind", async () => {
    await store().apply("offer-matrix", OFFERS.replace(/\n/g, "\r\n"), { author: "a", reason: "x" });
    const text = await readFile(join(dir, "context", "offer-matrix.md"), "utf8");
    expect(text).toBe(OFFERS);
    expect((await readdir(join(dir, "context"))).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("does nothing, and logs nothing, when the text is the same", async () => {
    const same = await readFile(join(dir, "context", "offer-matrix.md"), "utf8");
    const r = await store().apply("offer-matrix", same, { author: "a", reason: "x" });
    expect(r.changed).toBe(false);
    expect(events).toEqual([]);
    await expect(readdir(join(dir, ".medjay", "context-history"))).rejects.toThrow();
  });

  it("refuses text over 20 KB, empty text and text with a null character", async () => {
    await expect(store().apply("offer-matrix", "a".repeat(MAX_CONTEXT_BYTES + 1), { author: "a", reason: "x" })).rejects.toThrow(/too large/);
    await expect(store().apply("offer-matrix", "   \n", { author: "a", reason: "x" })).rejects.toThrow(/empty/);
    await expect(store().apply("offer-matrix", "a\0b", { author: "a", reason: "x" })).rejects.toThrow(/null/);
  });
});

describe("checks the content before it can be saved", () => {
  const economics = (extra: string) => `---\ncurrency: SAR\n${extra}\n---\n# Unit economics\n`;
  const ranged = "cpc: { value: 2, low: 1.5, high: 3, source: last quarter }";

  it("accepts a partly filled unit-economics file (the owner fills it step by step)", async () => {
    await expect(store().apply("unit-economics", economics(ranged), { author: "a", reason: "x" })).resolves.toMatchObject({ changed: true });
  });

  it("refuses a bare number, a range where low is above the value, and a bad currency", async () => {
    await expect(store().apply("unit-economics", economics("cpc: 2"), { author: "a", reason: "x" })).rejects.toThrow(/bare number|low and high/);
    await expect(store().apply("unit-economics", economics("cpc: { value: 2, low: 3, high: 4, source: s }"), { author: "a", reason: "x" })).rejects.toThrow(/low <= value/);
    await expect(store().apply("unit-economics", economics(ranged).replace("SAR", "sar"), { author: "a", reason: "x" })).rejects.toThrow(/currency/);
    expect(await readFile(join(dir, "context", "unit-economics.md"), "utf8")).toContain("note: cost per click");
  });

  it("refuses front matter that is not valid YAML or not a mapping", async () => {
    await expect(store().apply("brand-voice", "---\nlanguages: [unclosed\n---\n# x\n", { author: "a", reason: "x" })).rejects.toThrow(/front matter/);
    await expect(store().apply("claims", "---\n- just\n- a list\n---\n# x\n", { author: "a", reason: "x" })).rejects.toThrow(/front matter/);
  });

  it("refuses claims that is not a list and forbidden_phrases that is not a list", async () => {
    await expect(store().apply("claims", "---\nclaims: nope\n---\n# x\n", { author: "a", reason: "x" })).rejects.toThrow(/claims/);
    await expect(store().apply("brand-voice", "---\nforbidden_phrases: nope\n---\n# x\n", { author: "a", reason: "x" })).rejects.toThrow(/forbidden_phrases/);
  });

  it("an owner-edited file that was already broken can still be replaced by a good one", async () => {
    await writeFile(join(dir, "context", "claims.md"), "not front matter at all", "utf8");
    await expect(store().apply("claims", "---\nclaims: []\n---\n# Claims\n", { author: "a", reason: "x" })).resolves.toMatchObject({ changed: true });
  });
});
