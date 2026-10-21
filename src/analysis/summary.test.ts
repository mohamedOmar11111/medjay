import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/db.js";
import { periodSummary } from "./summary.js";

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-psum-"));
  store = Store.open(join(dir, "m.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
function put(dimension: string, key: string, spend: number, conversions: number, clicks = 0, period = ["2026-09-01", "2026-09-30"]): void {
  const db = store.database();
  const source = `s${n++}`;
  db.prepare("INSERT INTO sources (source_id, mapping_id, kind, platform, file, sha256, rows, issues_json, period_start, period_end, ingested_at) VALUES (?, 'm', 'ad_summary', 'google', 'f', 'h', 1, '[]', ?, ?, 't')").run(source, period[0], period[1]);
  db.prepare("INSERT INTO fact_period (source_id, platform, period_start, period_end, dimension, key, spend, impressions, clicks, conversions, conv_value, currency) VALUES (?, 'google', ?, ?, ?, ?, ?, 0, ?, ?, 0, 'SAR')").run(source, period[0], period[1], dimension, key, spend, clicks, conversions);
}

describe("periodSummary", () => {
  it("returns null when no summary has been ingested", () => {
    expect(periodSummary(store)).toBeNull();
  });

  it("totals the campaigns, ranks them by spend and works out cost per conversion", () => {
    put("campaign", "georgia", 8450, 78);
    put("campaign", "Europe", 6682.09, 132);
    put("campaign", "Idle", 0, 0);
    const s = periodSummary(store)!;
    expect(s.currency).toBe("SAR");
    expect(s.period).toEqual({ start: "2026-09-01", end: "2026-09-30", days: 30 });
    expect(s.totals.spend).toBeCloseTo(15132.09, 2);
    expect(s.totals.conversions).toBe(210);
    expect(s.totals.cost_per_conversion).toBeCloseTo(72.06, 2);
    expect(s.campaigns.map((c) => c.name)).toEqual(["georgia", "Europe", "Idle"]);
    expect(s.campaigns[0]).toMatchObject({ spend: 8450, conversions: 78, share_of_spend: 0.558 });
    expect(s.campaigns[2]!.cost_per_conversion).toBeNull();
  });

  it("lists the search terms that spent money and never converted, biggest first", () => {
    put("campaign", "A", 100, 1);
    put("search_term", "thailand", 164.71, 0, 17);
    put("search_term", "paris", 20, 2, 3);
    put("search_term", "georgia tours", 153.42, 0, 12);
    put("search_term", "free", 0, 0, 0);
    expect(periodSummary(store)!.zero_conversion_terms).toEqual([
      { term: "thailand", spend: 164.71, clicks: 17 },
      { term: "georgia tours", spend: 153.42, clicks: 12 },
    ]);
  });

  it("splits spend by device and keeps the daily trend in date order", () => {
    put("campaign", "A", 100, 1);
    put("device", "Mobile phones", 90, 1, 30);
    put("device", "Computers", 10, 0, 5);
    put("day", "2026-09-02", 60, 1);
    put("day", "2026-09-01", 40, 0);
    const s = periodSummary(store)!;
    expect(s.devices.map((d) => d.device)).toEqual(["Mobile phones", "Computers"]);
    expect(s.daily.map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("uses the most recent period when files for two periods were ingested", () => {
    put("campaign", "old", 999, 9, 0, ["2026-08-01", "2026-08-31"]);
    put("campaign", "new", 100, 1);
    const s = periodSummary(store)!;
    expect(s.period.start).toBe("2026-09-01");
    expect(s.campaigns.map((c) => c.name)).toEqual(["new"]);
  });

  it("flags reports from the same period that do not add up", () => {
    put("campaign", "A", 1000, 10);
    put("device", "Mobile phones", 900, 8);
    const s = periodSummary(store)!;
    expect(s.notes.some((m) => /devices/i.test(m) && /10%/.test(m))).toBe(true);
  });
});
