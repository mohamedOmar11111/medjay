import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupIngest } from "../../test/helpers/ingest.js";
import { setupScout, type ScoutHarness } from "../../test/helpers/scout.js";
import { scout } from "./scout.js";

let h: ScoutHarness;
beforeEach(async () => {
  h = await setupScout();
});
afterEach(async () => {
  await h.cleanup();
});

describe("scout snapshot on the etlaala-ksa fixture", () => {
  it("covers the 7 days ending at the latest ad data and totals spend across channels", () => {
    const s = h.snapshot();
    expect(s.status).toBe("ok");
    expect(s.period).toEqual({ start: "2026-10-10", end: "2026-10-16", days: 7 });
    expect(s.totals).toMatchObject({ spend: 26880, platform_conversions: 275, leads: 172, deals: 28 });
    expect(s.platforms.map((p) => [p.platform, p.spend])).toEqual([["meta", 14980], ["google", 11900]]);
  });

  it("calculates Blended MER from CRM revenue won in the period, not from platform numbers", () => {
    const s = h.snapshot();
    expect(s.totals.blended_mer).toBe(7.46);
    const google = s.platforms.find((p) => p.platform === "google")!;
    expect(google.platform_roas).toBe(19.8);
    expect(s.platforms.find((p) => p.platform === "meta")!.platform_roas).toBeNull();
  });

  it("sets platform-reported conversions against CRM leads (calibration ratio)", () => {
    const s = h.snapshot();
    expect(s.platforms.find((p) => p.platform === "meta")).toMatchObject({ platform_conversions: 151, leads: 99, calibration_ratio: 1.53 });
    expect(s.platforms.find((p) => p.platform === "google")).toMatchObject({ platform_conversions: 124, leads: 59, calibration_ratio: 2.1 });
    const pmax = s.adsets.find((a) => a.campaign === "PMax_Trips_KSA")!;
    expect(pmax).toMatchObject({ platform_conversions: 61, leads: 9, deals: 1 });
  });

  it("shows the bleeding ad set: spend, platform results, no qualified lead and no deal", () => {
    const bleeding = h.snapshot().adsets.find((a) => a.adset === "UMRAH-ALL-Broad-Reels")!;
    expect(bleeding).toMatchObject({ spend: 3780, platform_conversions: 29, leads: 6, qualified: 0, deals: 0, active_days: 7, cost_per_deal: null });
  });

  it("always reports the match rate and lists every unmatched lead with its reason", () => {
    const { match } = h.snapshot();
    expect(match).toMatchObject({ matched: 158, unmatched: 14, matched_by_prefix: 6 });
    expect(match.rate).toBeCloseTo(158 / 172, 3);
    expect(match.unmatched_leads).toHaveLength(14);
    expect(match.unmatched_leads.filter((l) => l.reason === "no_utm")).toHaveLength(13);
    expect(match.unmatched_leads.filter((l) => l.reason === "unknown_source")).toHaveLength(1);
    expect(match.unmatched_leads.filter((l) => l.has_deal).length).toBe(3);
  });

  it("reports conversation health and carries the sources' flagged cells forward", () => {
    const s = h.snapshot();
    expect(s.conversations.median_first_response_seconds).toBe(125);
    expect(s.conversations.ghost_rate).toBeCloseTo(0.1628, 3);
    expect(s.suspicious_cells).toHaveLength(8);
    expect(s.suspicious_cells.every((c) => c.excerpt.length <= 80)).toBe(true);
  });

  it("a shorter window only counts those days", () => {
    const s = h.snapshot({ days: 3 });
    expect(s.period).toEqual({ start: "2026-10-14", end: "2026-10-16", days: 3 });
    expect(s.totals.spend).toBeLessThan(26880 / 2);
    expect(s.totals.leads).toBeLessThan(172);
  });

  it("marks a source stale once it is older than the freshness SLA", () => {
    expect(h.snapshot().sources.some((s) => s.stale)).toBe(false);
    const late = h.snapshot({ now: new Date("2026-10-20T07:00:00Z") });
    expect(late.sources.every((s) => s.stale)).toBe(true);
    expect(late.sources[0]!.age_days).toBe(4);
  });

  it("never converts currency: rows in another currency are excluded and counted", () => {
    h.store.database().prepare("UPDATE deals SET currency = 'USD' WHERE deal_id = 'd_2001'").run();
    h.store.database().prepare("UPDATE fact_daily SET currency = 'USD' WHERE campaign = 'KSA_Honeymoon_Maldives'").run();
    const s = h.snapshot();
    expect(s.excluded).toEqual({ ad_rows_other_currency: 7, deals_other_currency: 1 });
    expect(s.totals.spend).toBe(26880 - 2100);
    expect(s.totals.deals).toBe(27);
  });

  it("attributes a campaign through a shortened UTM only when the match is unique", () => {
    h.store.database().prepare("INSERT INTO fact_daily SELECT source_id, date, platform, 'Search_AlUla_Weekend_Two', adset, spend, impressions, clicks, conversions, conv_value, currency FROM fact_daily WHERE campaign LIKE 'Search_AlUla_Weekend |%' AND date = '2026-10-16'").run();
    const s = h.snapshot();
    // "search_alula_weekend" now prefixes two campaigns: ambiguous, so those leads are unmatched, not guessed
    expect(s.match.unmatched).toBe(14 + 6);
  });
});

describe("scout without data", () => {
  it("says no_data instead of inventing numbers", async () => {
    const empty = await setupIngest();
    const s = scout({ store: empty.store, mappings: empty.deps.mappings, baseCurrency: "SAR", timezone: "Asia/Riyadh", now: new Date("2026-10-17T07:00:00Z"), freshnessSlaHours: 24 });
    expect(s).toMatchObject({ status: "no_data", period: null, platforms: [], adsets: [] });
    expect(s.totals.blended_mer).toBeNull();
    await empty.cleanup();
  });
});
