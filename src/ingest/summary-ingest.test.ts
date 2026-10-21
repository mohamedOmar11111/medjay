import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../audit/ledger.js";
import { Store } from "../store/db.js";
import { ingestDropzone, type IngestDeps } from "./ingest.js";
import { parseMappings } from "./mapping.js";

const MAPPINGS = `version: 1
sources:
  - id: g-campaigns
    kind: ad_summary
    platform: google
    currency: SAR
    file: "Campaigns(*).csv"
    dimension: campaign
    columns: { key: Campaign Name, spend: Cost, conversions: Conversions }
  - id: g-terms
    kind: ad_summary
    platform: google
    currency: SAR
    file: "Searches(Search_*).csv"
    dimension: search_term
    columns: { key: Search, spend: Cost, clicks: Clicks, impressions: Impressions, conversions: Conversions }
attribution:
  source_aliases: {}
`;

let dir: string;
let store: Store;
let deps: IngestDeps;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-summary-"));
  const drop = join(dir, "imports");
  await mkdir(drop, { recursive: true });
  await writeFile(join(drop, "Campaigns(2026.09.01-2026.09.30).csv"), ["Campaign Name,Campaign Group Name,Campaign Status,Cost,Conversions,Cost / conv.", 'georgia,,Enabled,"SAR8,450.00",78.00,SAR108.33', 'Europe,,Enabled,"SAR6,682.09",132.00,SAR50.62'].join("\n"));
  await writeFile(join(drop, "Searches(Search_2026.09.01-2026.09.30).csv"), ["Search,Cost,Clicks,Impressions,Conversions", "thailand,SAR164.71,17,436,0.00", "paris,SAR20.00,3,90,2.00"].join("\n"));
  store = Store.open(join(dir, "m.db"));
  deps = { dropzoneDir: drop, workspaceId: "t", mappings: parseMappings(MAPPINGS), store, ledger: new Ledger(join(dir, "audit.jsonl")), now: () => new Date("2026-10-20T00:00:00Z"), actor: "test" };
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ingesting period summaries", () => {
  it("stores one row per key with the period from the file name, and reports it", async () => {
    const report = await ingestDropzone(deps);
    expect(report.files.map((f) => [f.mapping_id, f.status, f.rows, f.period])).toEqual([
      ["g-campaigns", "ingested", 2, { start: "2026-09-01", end: "2026-09-30" }],
      ["g-terms", "ingested", 2, { start: "2026-09-01", end: "2026-09-30" }],
    ]);
    const rows = store.database().prepare("SELECT dimension, key, spend, clicks, conversions, currency, period_start, period_end FROM fact_period ORDER BY dimension, key").all();
    expect(rows).toEqual([
      { dimension: "campaign", key: "Europe", spend: 6682.09, clicks: 0, conversions: 132, currency: "SAR", period_start: "2026-09-01", period_end: "2026-09-30" },
      { dimension: "campaign", key: "georgia", spend: 8450, clicks: 0, conversions: 78, currency: "SAR", period_start: "2026-09-01", period_end: "2026-09-30" },
      { dimension: "search_term", key: "paris", spend: 20, clicks: 3, conversions: 2, currency: "SAR", period_start: "2026-09-01", period_end: "2026-09-30" },
      { dimension: "search_term", key: "thailand", spend: 164.71, clicks: 17, conversions: 0, currency: "SAR", period_start: "2026-09-01", period_end: "2026-09-30" },
    ]);
  });

  it("re-ingesting an unchanged file does nothing, and a changed file replaces its rows", async () => {
    await ingestDropzone(deps);
    expect((await ingestDropzone(deps)).files.every((f) => f.status === "unchanged")).toBe(true);
    await writeFile(join(deps.dropzoneDir, "Campaigns(2026.09.01-2026.09.30).csv"), ["Campaign Name,Cost,Conversions", "georgia,SAR1.00,1"].join("\n"));
    await ingestDropzone(deps);
    const campaigns = store.database().prepare("SELECT key FROM fact_period WHERE dimension = 'campaign'").all();
    expect(campaigns).toEqual([{ key: "georgia" }]);
  });

  it("a file without a readable period is rejected and stores nothing", async () => {
    await writeFile(join(deps.dropzoneDir, "Campaigns(2026.09.01-2026.09.30).csv"), "x");
    await rm(join(deps.dropzoneDir, "Campaigns(2026.09.01-2026.09.30).csv"));
    await writeFile(join(deps.dropzoneDir, "Campaigns(nodates).csv"), ["Campaign Name,Cost,Conversions", "georgia,SAR1.00,1"].join("\n"));
    const report = await ingestDropzone(deps);
    const bad = report.files.find((f) => f.file === "Campaigns(nodates).csv");
    expect(bad).toMatchObject({ status: "rejected" });
    expect(bad?.issues.some((i) => i.kind === "no_period")).toBe(true);
    expect(store.database().prepare("SELECT COUNT(*) AS n FROM fact_period WHERE dimension = 'campaign'").get()).toEqual({ n: 0 });
  });
});
