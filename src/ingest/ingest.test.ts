import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILES } from "../../fixtures/generate-etlaala-ksa.js";
import { FIXTURE, setupIngest, type IngestHarness } from "../../test/helpers/ingest.js";
import { IngestRepo } from "./repo.js";

let h: IngestHarness;
beforeEach(async () => {
  h = await setupIngest();
});
afterEach(async () => {
  await h.cleanup();
});

const count = (table: string) => Number((h.store.database().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const sum = (sql: string) => Number((h.store.database().prepare(sql).get() as { v: number }).v);

describe("the committed etlaala-ksa fixture", () => {
  it("is exactly what the generator produces (so it cannot drift by hand)", async () => {
    for (const [rel, make] of Object.entries(FILES)) expect(await readFile(join(FIXTURE, rel), "utf8"), rel).toBe(make());
  });
});

describe("ingestDropzone", () => {
  it("reads all four exports with no errors and the expected row counts", async () => {
    const report = await h.ingest();
    expect(report.files.map((f) => [f.mapping_id, f.status, f.rows])).toEqual([
      ["meta_ads", "ingested", 28],
      ["google_ads", "ingested", 28],
      ["ga4", "ingested", 49],
      ["crm", "ingested", 172],
    ]);
    expect(report.files.flatMap((f) => f.issues.filter((i) => i.severity === "error"))).toEqual([]);
    expect(report.unmapped).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(count("fact_daily")).toBe(56);
    expect(count("leads")).toBe(172);
    expect(count("deals")).toBe(28);
  });

  it("flags the planted instructions in the Google campaign name and the CRM UTM cell, and keeps them as data", async () => {
    const report = await h.ingest();
    const flagged = report.files.flatMap((f) => f.issues.filter((i) => i.kind === "suspicious_text").map((i) => `${f.mapping_id}:${i.column}`));
    // the Google campaign name repeats on each of the 7 days; the CRM cell is one lead
    expect(flagged.filter((f) => f === "google_ads:Campaign")).toHaveLength(7);
    expect(flagged.filter((f) => f === "crm:utm.campaign")).toHaveLength(1);
    expect(flagged).toHaveLength(8);
  });

  it("totals match the fixture design", async () => {
    await h.ingest();
    expect(sum("SELECT ROUND(SUM(spend), 2) AS v FROM fact_daily WHERE platform = 'meta'")).toBe(14980);
    expect(sum("SELECT ROUND(SUM(spend), 2) AS v FROM fact_daily WHERE platform = 'google'")).toBe(11900);
    expect(sum("SELECT SUM(conversions) AS v FROM fact_daily")).toBe(275);
    expect(sum("SELECT SUM(value) AS v FROM deals")).toBeGreaterThan(150000);
  });

  it("is idempotent: a second run reads nothing again, and a changed file replaces rather than duplicates", async () => {
    await h.ingest();
    const again = await h.ingest();
    expect(again.files.every((f) => f.status === "unchanged")).toBe(true);
    expect(count("fact_daily")).toBe(56);

    const meta = join(h.deps.dropzoneDir, "meta-ads-2026-10-10_16.csv");
    await writeFile(meta, `${await readFile(meta, "utf8")}2026-10-16,KSA_Extra,x,10.00,100,5,1\n`, "utf8");
    const third = await h.ingest();
    expect(third.files.find((f) => f.mapping_id === "meta_ads")).toMatchObject({ status: "ingested", rows: 29 });
    expect(count("fact_daily")).toBe(57);
  });

  it("never lets a broken file replace good data already stored", async () => {
    await h.ingest();
    const meta = join(h.deps.dropzoneDir, "meta-ads-2026-10-10_16.csv");
    await writeFile(meta, "Day,Campaign name\n2026-10-10,A\n", "utf8");
    const report = await h.ingest();
    const file = report.files.find((f) => f.mapping_id === "meta_ads")!;
    expect(file.status).toBe("rejected");
    expect(file.issues.find((i) => i.severity === "error")).toMatchObject({ kind: "missing_column", column: "Amount spent (SAR)" });
    expect(count("fact_daily")).toBe(56);
  });

  it("lists files no mapping claims and mappings that found no file", async () => {
    await writeFile(join(h.deps.dropzoneDir, "notes.txt"), "hello", "utf8");
    await rm(join(h.deps.dropzoneDir, "ga4-landing-pages-2026-10-10_16.csv"));
    const report = await h.ingest();
    expect(report.unmapped).toEqual(["notes.txt"]);
    expect(report.missing).toEqual(["ga4"]);
  });

  it("stores phone numbers only as hashes", async () => {
    await h.ingest();
    const hashes = h.store.database().prepare("SELECT phone_hash FROM leads WHERE phone_hash IS NOT NULL").all() as { phone_hash: string }[];
    expect(hashes).toHaveLength(172);
    expect(hashes.every((r) => /^[0-9a-f]{64}$/.test(r.phone_hash))).toBe(true);
    expect(JSON.stringify(h.store.database().prepare("SELECT * FROM leads").all())).not.toContain("96655000");
  });

  it("writes one ledger entry with counts and file names, never cell contents or numbers", async () => {
    await h.ingest();
    const lines = (await readFile(join(h.dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe("ingest.completed");
    expect(entry.payload.files.find((f: { mapping: string }) => f.mapping === "google_ads")).toMatchObject({ rows: 28, suspicious: 7 });
    expect(lines[0]).not.toMatch(/SYSTEM NOTICE|96655000/);
  });

  it("keeps the issue list on the stored source for later reports", async () => {
    await h.ingest();
    const source = new IngestRepo(h.store).getSource("google_ads:google-ads-2026-10-10_16.csv")!;
    expect(source.issues.some((i) => i.kind === "suspicious_text")).toBe(true);
    expect(source).toMatchObject({ kind: "ad_platform", platform: "google", period_start: "2026-10-10", period_end: "2026-10-16" });
  });
});
