import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftError, DraftStore, type DraftChecker } from "./store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-drafts-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-10-24T10:00:00.000Z");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const store = (checker?: DraftChecker, audit?: (e: Record<string, unknown>) => Promise<void>) => new DraftStore(dir, { ...(checker ? { checker } : {}), ...(audit ? { audit } : {}), now: () => NOW });
const base = { workflow: "email", slug: "umrah-follow-up", kind: "email" as const, author: "agent:run_1" };

describe("DraftStore.save", () => {
  it("writes v1 then v2 and never overwrites an earlier version", async () => {
    const s = store();
    const v1 = await s.save({ ...base, text: "first draft" });
    const v2 = await s.save({ ...base, text: "second draft" });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(await readFile(join(dir, "drafts", "email", "umrah-follow-up", "v1.md"), "utf8")).toBe("first draft");
    expect(await readFile(join(dir, "drafts", "email", "umrah-follow-up", "v2.md"), "utf8")).toBe("second draft");
  });

  it("records the SHA-256 of the exact text, its size, kind, author and time", async () => {
    const v = await store().save({ ...base, text: "مرحبا بك\nSecond line" });
    expect(v.sha256).toBe(sha("مرحبا بك\nSecond line"));
    expect(v.bytes).toBe(Buffer.byteLength("مرحبا بك\nSecond line", "utf8"));
    expect(v).toMatchObject({ workflow: "email", slug: "umrah-follow-up", kind: "email", author: "agent:run_1", created_at: NOW.toISOString() });
  });

  it("gives two saves at the same moment two different versions", async () => {
    const s = store();
    const [a, b, c] = await Promise.all([s.save({ ...base, text: "a" }), s.save({ ...base, text: "b" }), s.save({ ...base, text: "c" })]);
    expect(new Set([a.version, b.version, c.version]).size).toBe(3);
    expect((await readdir(join(dir, "drafts", "email", "umrah-follow-up"))).filter((f) => f.endsWith(".md")).sort()).toEqual(["v1.md", "v2.md", "v3.md"]);
  });

  it("refuses names that could leave the drafts folder, empty text, huge text and unknown kinds", async () => {
    const s = store();
    for (const slug of ["../escape", "a/b", "A-Upper", "-lead", "x".repeat(80), "", "con.d", "a b", "con", "nul", "com1"]) {
      await expect(s.save({ ...base, slug, text: "x" }), `slug ${slug}`).rejects.toBeInstanceOf(DraftError);
    }
    await expect(s.save({ ...base, workflow: "../w", text: "x" })).rejects.toBeInstanceOf(DraftError);
    await expect(s.save({ ...base, text: "   " })).rejects.toThrow(/empty/);
    await expect(s.save({ ...base, text: "x".repeat(100_001) })).rejects.toThrow(/too large/);
    await expect(s.save({ ...base, text: "a\0b" })).rejects.toThrow(/null/);
    await expect(s.save({ ...base, kind: "script" as never, text: "x" })).rejects.toThrow(/kind/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("DraftStore copy check", () => {
  const checker: DraftChecker = (text) => (text.includes("guaranteed") ? { status: "fail", errors: 1, warnings: 0, rules: ["claims.unverified"] } : { status: "pass", errors: 0, warnings: 1, rules: ["slop.filler"] });

  it("checks customer-facing kinds and records the result with the version", async () => {
    const s = store(checker);
    const bad = await s.save({ ...base, text: "A guaranteed visa" });
    expect(bad.check).toMatchObject({ status: "fail", errors: 1, rules: ["claims.unverified"], checked_at: NOW.toISOString() });
    const good = await s.save({ ...base, text: "A calm note" });
    expect(good.check).toMatchObject({ status: "pass", errors: 0, warnings: 1 });
    for (const kind of ["ad", "post", "landing_page"] as const) expect((await s.save({ ...base, slug: `k-${kind.replace("_", "-")}`, kind, text: "guaranteed" })).check.status).toBe("fail");
  });

  it("does not check internal notes and reports", async () => {
    const s = store(checker);
    expect((await s.save({ ...base, kind: "internal", text: "guaranteed" })).check.status).toBe("not_applicable");
    expect((await s.save({ ...base, slug: "weekly", kind: "report", text: "guaranteed" })).check.status).toBe("not_applicable");
  });

  it("says not_checked, never pass, when customer-facing text could not be checked", async () => {
    expect((await store().save({ ...base, text: "anything" })).check.status).toBe("not_checked");
  });
});

describe("DraftStore read, list, verify, diff, revert", () => {
  it("reads the latest or a given version, and notices a file edited outside Medjay", async () => {
    const s = store();
    await s.save({ ...base, text: "one" });
    await s.save({ ...base, text: "two" });
    expect((await s.read("email", "umrah-follow-up")).text).toBe("two");
    expect((await s.read("email", "umrah-follow-up", 1)).text).toBe("one");
    expect((await s.read("email", "umrah-follow-up", 2)).intact).toBe(true);
    await writeFile(join(dir, "drafts", "email", "umrah-follow-up", "v2.md"), "two, quietly changed", "utf8");
    const changed = await s.read("email", "umrah-follow-up", 2);
    expect(changed.intact).toBe(false);
    expect(await s.verify()).toEqual([{ workflow: "email", slug: "umrah-follow-up", version: 2, problem: "content no longer matches the saved SHA-256" }]);
    await expect(s.read("email", "umrah-follow-up", 9)).rejects.toThrow(/no version 9/);
    await expect(s.read("email", "nothing-here")).rejects.toThrow(/no draft/);
  });

  it("lists drafts with their latest version, count and check status", async () => {
    const s = store(() => ({ status: "pass", errors: 0, warnings: 0, rules: [] }));
    await s.save({ ...base, text: "a" });
    await s.save({ ...base, text: "b" });
    await s.save({ workflow: "reports", slug: "weekly", kind: "report", text: "r", author: "cli:omar" });
    const all = await s.list();
    expect(all.map((d) => `${d.workflow}/${d.slug}`)).toEqual(["email/umrah-follow-up", "reports/weekly"]);
    expect(all[0]).toMatchObject({ latest: 2, versions: 2, kind: "email", check: "pass" });
    expect((await s.list("reports")).map((d) => d.slug)).toEqual(["weekly"]);
    expect(await store().list("nothing")).toEqual([]);
  });

  it("shows what changed between two versions", async () => {
    const s = store();
    await s.save({ ...base, text: "Dear guest\nWe hope you are well\nBest" });
    await s.save({ ...base, text: "Dear guest\nWe hope you are very well\nBest\nP.S. soon" });
    const d = await s.diff("email", "umrah-follow-up", 1, 2);
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    expect(d.text).toContain("- We hope you are well");
    expect(d.text).toContain("+ We hope you are very well");
    expect(d.text).toContain("+ P.S. soon");
  });

  it("reverts by saving the old text as a NEW version that remembers where it came from", async () => {
    const s = store();
    await s.save({ ...base, text: "keep me" });
    await s.save({ ...base, text: "oops" });
    const r = await s.revert("email", "umrah-follow-up", 1, "cli:omar");
    expect(r).toMatchObject({ version: 3, reverted_from: 1, author: "cli:omar" });
    expect((await s.read("email", "umrah-follow-up")).text).toBe("keep me");
    expect((await s.read("email", "umrah-follow-up", 2)).text).toBe("oops");
  });
});

describe("DraftStore audit", () => {
  it("reports each save with the hash and size, never the text", async () => {
    const events: Record<string, unknown>[] = [];
    await store(undefined, async (e) => void events.push(e)).save({ ...base, text: "secret words" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "draft.saved", workflow: "email", slug: "umrah-follow-up", version: 1, bytes: 12, check: "not_checked" });
    expect(JSON.stringify(events)).not.toContain("secret words");
    expect(String(events[0]!.sha256)).toHaveLength(64);
  });
});
