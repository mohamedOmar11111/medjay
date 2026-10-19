import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRuleConfig, resolveRuleConfig, RULE_DEFAULTS, RuleConfigError } from "./config.js";
import { MediaRuleError, pyRound, RULE_IDS, RULES, renderRule } from "./rules.js";
import { parseRows, runMedia, splitArgs } from "./run.js";

const cfg = resolveRuleConfig();
const table = (header: string, ...rows: string[]) => [header, ...rows].join("\n");
const go = (id: string, csv: string | undefined, params: Record<string, string> = {}) => runMedia(id, csv, { cfg, params, now: () => new Date("2026-10-05T09:00:00Z") }).result;
const verdicts = (id: string, csv: string, params?: Record<string, string>) => go(id, csv, params).rows.map((r) => Object.values(r).at(-1));

describe("the registry", () => {
  it("has the 20 rules, numbered 1 to 20, each with the documentation the CLI prints", () => {
    expect(RULES.map((r) => r.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(RULE_IDS).size).toBe(20);
    for (const r of RULES) {
      expect(r.decision.length, r.id).toBeGreaterThan(0);
      expect(r.description.length, r.id).toBeGreaterThan(20);
      expect(r.guardrails, r.id).toBeTruthy();
    }
  });
});

describe("pyRound and number reading", () => {
  it("rounds halves to even like Python, so 72.5 hours is 72", () => {
    expect([pyRound(72.5), pyRound(73.5), pyRound(0.5), pyRound(1.5), pyRound(2.675, 2), pyRound(14.6585, 1)]).toEqual([72, 74, 0, 2, 2.67, 14.7]);
  });
  it("reads 27% as 0.27, strips $ and thousands commas, and warns about a cell that is not a number", () => {
    const r = go("is-ceiling", table("campaign,impressions,search_is,lost_is_budget,lost_is_rank", 'A,"42,100",38%,27%,0%', "B,1000,abc,0,0"));
    expect(r.rows[0]).toMatchObject({ search_is: 0.38, ceiling: 110789, flags: "budget-capped (27% lost)" });
    expect(r.warnings).toEqual([expect.stringMatching(/row 3 search_is: "abc" is not a number/)]);
  });
});

describe("1 near-copy-count", () => {
  const ads = table(
    "ad_id,platform,launched,angle,format,person",
    "M01,meta,2026-09-20,Gift for her,UGC video,Creator Maya",
    "M02,meta,2026-09-21,gift  for her,ugc video,creator maya",
    "M03,meta,2026-09-22,Scent story,UGC video,Creator Jon",
    "M04,meta,2026-09-25,Gift for her,Static,none",
    "OLD,meta,2026-07-01,Ancient,Static,none",
  );
  it("groups ads by angle, format and person (case and spacing ignored), ignores ads older than 30 days, and counts near-copies", () => {
    const r = go("near-copy-count", ads);
    expect(r.rows).toEqual([
      { concept: "gift for her / ugc video / creator maya", ads: 2, ad_ids: "M01 M02" },
      { concept: "scent story / ugc video / creator jon", ads: 1, ad_ids: "M03" },
      { concept: "gift for her / static / none", ads: 1, ad_ids: "M04" },
    ]);
    expect(r.summary).toEqual({ verdict: "UNDER", concepts: 3, ads: 4, near_copies: 1, range: "15-25" });
  });
  it("is IN RANGE at 15 and ABOVE RANGE past 25", () => {
    const many = (n: number) => table("ad_id,launched,angle,format,person", ...Array.from({ length: n }, (_, i) => `A${i},2026-09-30,angle${i},static,none`));
    expect(go("near-copy-count", many(15)).summary.verdict).toBe("IN RANGE");
    expect(go("near-copy-count", many(26)).summary.verdict).toBe("ABOVE RANGE");
  });
});

describe("2 unfunded-ads", () => {
  it("separates never funded, left behind and funded, and reports the share of spend left behind", () => {
    const r = go("unfunded-ads", table("ad_id,platform,spend_30d,impressions,purchases", "M01,meta,201.6,14469,0", "M02,meta,91.35,8845,1", "M03,meta,6930,613476,184", "M05,meta,47.25,4869,0", "M12,meta,198.45,18640,0"));
    expect(r.rows.map((x) => x.verdict)).toEqual(["LEFT BEHIND", "NEVER FUNDED", "FUNDED", "NEVER FUNDED", "LEFT BEHIND"]);
    expect(r.summary).toEqual({ never_funded: 2, ads: 5, left_behind_spend_share: 0.054 });
  });
  it("an ad with plenty of impressions but under the spend line is still never funded", () => {
    expect(verdicts("unfunded-ads", table("ad_id,spend_30d,impressions,purchases", "X,99,50000,0"))).toEqual(["NEVER FUNDED"]);
  });
});

describe("3 leave-it-alone", () => {
  const ads = (cpaSpend: number) => table("ad_id,spend_30d,purchases", `TOP,${cpaSpend},10`, ...Array.from({ length: 9 }, (_, i) => `S${i},100,2`));
  it("compares the top 10% of ads by spend with the target CPA", () => {
    expect(go("leave-it-alone", ads(380), { target_cpa: "40" }).summary).toMatchObject({ verdict: "LEAVE ALONE", top_ads: 1, top_cpa: 38, target_cpa: 40 });
    expect(go("leave-it-alone", ads(460), { target_cpa: "40" }).summary.verdict).toBe("WATCH");
    expect(go("leave-it-alone", ads(520), { target_cpa: "40" }).summary.verdict).toBe("FEED NEW CREATIVE");
  });
  it("needs the target CPA", () => {
    expect(() => go("leave-it-alone", ads(380))).toThrow(/needs the parameter target_cpa/);
  });
  it("copes with a top ad that made no sales", () => {
    expect(go("leave-it-alone", table("ad_id,spend_30d,purchases", "A,500,0", "B,100,2"), { target_cpa: "40" }).summary).toMatchObject({ verdict: "FEED NEW CREATIVE", top_cpa: "no sales" });
  });
});

describe("4 thumbstop-check", () => {
  it("flags a dead hook whatever the ROAS, and does not judge a young ad", () => {
    const r = go("thumbstop-check", table("ad_id,platform,impressions,hook_views,roas", "M01,meta,14469,3241,0", "M03,meta,100000,29600,1.54", "M21,meta,50000,8400,1.62", "NEW,meta,500,0,0"));
    expect(r.rows.map((x) => [x.ad_id, x.thumbstop, x.verdict])).toEqual([["M01", 0.224, "HOOK DEAD"], ["M03", 0.296, "HOOK OK"], ["M21", 0.168, "HOOK DEAD"], ["NEW", 0, "TOO EARLY"]]);
    expect(r.summary).toEqual({ hook_dead: 2 });
  });
});

describe("5 fatigue-call", () => {
  it("needs two of the three signals", () => {
    const r = go("fatigue-call", table("ad_id,cpm_prev,cpm_now,ctr_prev,ctr_now,frequency", "A,10,12.5,0.02,0.015,3.5", "B,10,10,0.02,0.02,1", "C,10,10,0.02,0.016,1", "D,10,12,0.02,0.02,2", "E,10,12.1,0.02,0.02,3"));
    expect(r.rows.map((x) => [x.ad_id, x.signals, x.verdict])).toEqual([
      ["A", "CPM up, CTR down, freq > 3", "FATIGUED"],
      ["B", "-", "FINE"],
      ["C", "CTR down", "WATCH"],
      ["D", "CPM up", "WATCH"],
      ["E", "CPM up", "WATCH"],
    ]);
    expect(r.summary).toEqual({ fatigued: 1 });
  });
  it("treats exactly 20% and exactly 15% as signals", () => {
    expect(go("fatigue-call", table("ad_id,cpm_prev,cpm_now,ctr_prev,ctr_now,frequency", "A,10,12,0.02,0.017,1")).rows[0]!.verdict).toBe("FATIGUED");
  });
});

describe("6 72h-guard", () => {
  it("lists what is under 72 hours and when each opens up (the guide's example)", () => {
    const r = go("72h-guard", table("ad_id,first_delivery", "N1,2026-10-01T14:00", "N2,2026-10-02T08:30", "N3,2026-10-02T18:00", "N4,2026-10-03T11:15", "N5,2026-10-04T08:00", "N6,2026-10-04T20:45"), { now: "2026-10-05T09:00" });
    expect(r.rows).toEqual([
      { ad_id: "N1", age_h: 91, verdict: "OPEN", open_from: "Sun 04 Oct 14:00" },
      { ad_id: "N2", age_h: 72, verdict: "OPEN", open_from: "Mon 05 Oct 08:30" },
      { ad_id: "N3", age_h: 63, verdict: "HANDS OFF", open_from: "Mon 05 Oct 18:00" },
      { ad_id: "N4", age_h: 46, verdict: "HANDS OFF", open_from: "Tue 06 Oct 11:15" },
      { ad_id: "N5", age_h: 25, verdict: "HANDS OFF", open_from: "Wed 07 Oct 08:00" },
      { ad_id: "N6", age_h: 12, verdict: "HANDS OFF", open_from: "Wed 07 Oct 20:45" },
    ]);
    expect(r.summary).toEqual({ hands_off: 4 });
  });
  it("uses the injected clock when no now is given, and names a bad date", () => {
    expect(go("72h-guard", table("ad_id,first_delivery", "A,2026-10-05T08:00")).rows[0]).toMatchObject({ age_h: 1, verdict: "HANDS OFF" });
    expect(() => go("72h-guard", table("ad_id,first_delivery", "A,yesterday"))).toThrow(/row 2 first_delivery: "yesterday" is not a date/);
  });
});

describe("7 tiktok-favourite", () => {
  it("finds a group where an old video holds half the spend", () => {
    const r = go("tiktok-favourite", table("ad_group,ad_id,spend,launched", "G1,T07,710,2026-09-06", "G1,T08,290,2026-09-20", "G2,T08,380,2026-09-20", "G2,T09,620,2026-09-21", "G3,T36,770,2026-09-27", "G3,T37,230,2026-09-28"), { now: "2026-10-05" });
    expect(r.rows).toEqual([
      { ad_group: "G1", favourite: "T07", share: 0.71, age_days: 29, verdict: "OLD FAVOURITE" },
      { ad_group: "G2", favourite: "T09", share: 0.62, age_days: 14, verdict: "NEW FAVOURITE" },
      { ad_group: "G3", favourite: "T36", share: 0.77, age_days: 8, verdict: "NEW FAVOURITE" },
    ]);
    expect(r.summary).toEqual({ old_favourites: 1 });
  });
  it("a spread group is SPREAD", () => {
    expect(verdicts("tiktok-favourite", table("ad_group,ad_id,spend,launched", "G,A,40,2026-01-01", "G,B,35,2026-01-01", "G,C,25,2026-01-01"), { now: "2026-10-05" })).toEqual(["SPREAD"]);
  });
});

describe("8 top-slot-watch", () => {
  it("flags an ad that fell to half its peak share this week, and ignores ads that never mattered", () => {
    const r = go("top-slot-watch", table("ad_id,week,spend_share", "M03,2026-W37,0.34", "M03,2026-W38,0.30", "M03,2026-W39,0.12", "M11,2026-W37,0.27", "M11,2026-W39,0.25", "TINY,2026-W37,0.05", "TINY,2026-W39,0.01"));
    expect(r.rows).toEqual([
      { ad_id: "M03", peak_share: 0.34, this_week: 0.12, verdict: "TURNING OVER" },
      { ad_id: "M11", peak_share: 0.27, this_week: 0.25, verdict: "HOLDING" },
    ]);
  });
});

describe("9 bench-check", () => {
  it("counts the bench, the shortfall and the live ads past three weeks", () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => `B${i},approved,`), "M03,live,2026-09-05", "T07,live,2026-09-06", "N1,live,2026-09-25"];
    const r = go("bench-check", table("ad_id,status,launched", ...rows), { now: "2026-10-05" });
    expect(r.rows).toEqual([{ ad_id: "M03", live_days: 30 }, { ad_id: "T07", live_days: 29 }]);
    expect(r.summary).toEqual({ bench: 6, short_by: 4, due_rotation: 2, verdict: "SHORT" });
  });
  it("is STOCKED with ten approved ads", () => {
    expect(go("bench-check", table("ad_id,status,launched", ...Array.from({ length: 10 }, (_, i) => `B${i},Approved,`))).summary).toMatchObject({ short_by: 0, verdict: "STOCKED" });
  });
});

describe("10 fair-test", () => {
  it("gives a verdict per impressions band and the fair tests the budget buys (the guide's numbers)", () => {
    const r = go("fair-test", table("ad_id,impressions", "X1,3240", "X2,2710", "X3,2050", "X4,1480", "X5,860", "X6,310"), { weekly_budget: "1050", cpm: "11.40" });
    expect(r.rows.map((x) => x.verdict)).toEqual(["PAUSE BY HAND", "READ", "READ", "EARLY READ", "KEEP RUNNING", "KEEP RUNNING"]);
    expect(r.summary).toEqual({ impressions_per_week: 92105, fair_tests_per_week: 30 });
  });
  it("leaves the budget part out when the budget is not given", () => {
    expect(go("fair-test", table("ad_id,impressions", "X1,100")).summary).toEqual({});
  });
});

describe("11 batch-sizer", () => {
  it("marks the big batch unfunded below 4x CPA and shows both methods", () => {
    expect(go("batch-sizer", undefined, { daily_budget: "150", avg_cpa: "41" }).summary).toEqual({ daily_budget: 150, cpa_multiple_budget: 164, method_a_funded: false, method_a: "not funded", method_b: "10-15 ads per ad set at most, fewer on a small budget" });
    expect(go("batch-sizer", undefined, { daily_budget: "200", avg_cpa: "41" }).summary).toMatchObject({ method_a_funded: true, method_a: "20-30 ads per ad set" });
  });
});

describe("12 scale-in-steps", () => {
  it("steps up, marks the ceiling, holds (the guide's example)", () => {
    const r = go("scale-in-steps", table("ad_set,budget_now,budget_prev,cpa_3d,target_cpa", "Meta winners (gift),300,260,33.1,40", "Meta scent story,230,200,47.8,40", "TikTok Smart+ winners,150,150,44.2,40", "Meta founder,120,100,38.9,40"));
    expect(r.rows.map((x) => [x.verdict, x.next_budget])).toEqual([["STEP UP", "345-360"], ["CEILING", "200"], ["HOLD", "150"], ["STEP UP", "138-144"]]);
  });
});

describe("13 is-ceiling", () => {
  it("reads lost budget first, then exact vs overall, then rank", () => {
    const r = go("is-ceiling", table("campaign,impressions,search_is,lost_is_budget,lost_is_rank,exact_is,avg_qs", "Brand,18400,0.92,0,0.05,0.95,9", "Soy,42100,0.38,0.27,0.12,0.31,6", "Gift,26900,0.55,0,0.2,0.7,4"));
    expect(r.rows.map((x) => [x.campaign, x.ceiling, x.flags])).toEqual([
      ["Brand", 20000, "rank loss: check QS 9 before bids"],
      ["Soy", 110789, "budget-capped (27% lost); exact IS no better than overall; rank loss: check QS 6 before bids"],
      ["Gift", 48909, "rank loss: check QS 4 before bids"],
    ]);
    expect(r.summary).toEqual({ budget_capped: 1 });
  });
});

describe("14 pmax-split", () => {
  it("blocks adding spend and splits products (the guide's example)", () => {
    const r = go("pmax-split", table("product,spend,conv_value", "Fig,2140,8560", "Sea,1870,6171", "Tin,760,1140", "Gift,1650,2310", "Melts,980,686", "Refill,420,0", "Trimmer,0,0"), { target_roas: "3.0" });
    expect(r.rows.map((x) => [x.product, x.bucket])).toEqual([["Fig", "WINNER"], ["Sea", "WINNER"], ["Tin", "LOSER"], ["Gift", "LOSER"], ["Melts", "LOSER"], ["Refill", "LOSER"], ["Trimmer", "NO SPEND"]]);
    expect(r.summary).toEqual({ campaign_roas: 2.41, target_roas: 3, verdict: "SPLIT BEFORE ADDING SPEND" });
  });
  it("holds when the campaign is on target, or has one product", () => {
    expect(go("pmax-split", table("product,spend,conv_value", "A,100,400"), { target_roas: "3" }).summary.verdict).toBe("HOLDING TARGET");
    expect(go("pmax-split", table("product,spend,conv_value", "A,100,100"), { target_roas: "3" }).summary.verdict).toBe("HOLDING TARGET");
  });
});

describe("15 campaign-job", () => {
  it("needs a job, a signal and a metric, and brand exclusions on PMax", () => {
    const r = go("campaign-job", table("campaign,type,job,signal,metric,brand_exclusions", "Brand,search,protect brand,purchases,ROAS,", "PMax,pmax,remarketing,,,no", "DG,demand_gen,,,,", "PM2,PMax,remarketing,purchases,ROAS,Yes", "PM3,pmax,remarketing,purchases,ROAS,no"));
    expect(r.rows.map((x) => [x.campaign, x.verdict, x.issues])).toEqual([
      ["Brand", "OK", "-"],
      ["PMax", "NO JOB", "no signal; no metric; PMax without brand exclusions"],
      ["DG", "NO JOB", "no job; no signal; no metric"],
      ["PM2", "OK", "-"],
      ["PM3", "FIX", "PMax without brand exclusions"],
    ]);
    expect(r.summary).toEqual({ no_job: 2 });
  });
  it("works when the optional columns are missing from the file", () => {
    expect(verdicts("campaign-job", table("campaign,type", "A,search"))).toEqual(["-"].map(() => "no job; no signal; no metric"));
  });
});

describe("16 brand-search-check", () => {
  it("applies the ROAS floor and flags automated bidding", () => {
    const r = go("brand-search-check", table("campaign,bid_strategy,roas", "Brand,Maximize conversions,5.4", "Misspellings,Manual CPC,11.2", "Mid,target impression share,7"));
    expect(r.rows.map((x) => [x.band, x.issues])).toEqual([["BELOW FLOOR", "automated bidding on brand"], ["STRONG", "-"], ["OK", "-"]]);
  });
});

describe("17 dsa-scout", () => {
  it("promotes converters, negates proven non-converters, waits on the rest", () => {
    const r = go("dsa-scout", table("search_term,conversions,cost,in_keywords", "fig and cedar candle,4,96.2,no", "soy candle no soot,3,71.4,", "candle making kit,0,58.9,no", "cheap candles bulk,0,44.1,no", "long burning candle gift,1,22.8,no", "northwick candles,6,18.3,yes", "cheap thing,0,10,no"), { avg_cpa: "41" });
    expect(r.rows.map((x) => x.verdict)).toEqual(["PROMOTE", "PROMOTE", "NEGATIVE", "NEGATIVE", "WAIT", "WAIT", "WAIT"]);
    expect(r.summary).toEqual({ promote: 2, negative: 2 });
  });
});

describe("18 hook-page-match", () => {
  it("compares the hook with the headline and flags slow pages", () => {
    const r = go("hook-page-match", table("ad_id,hook,page_headline,load_s", "M03,Gift for her,Gift for her | Fig & Cedar,1.2", "M11,Burns 60 hours,Shop all candles,1.8", "T07,Soy wax no soot,Clean soy wax candles with no soot,2.6"));
    expect(r.rows).toEqual([
      { ad_id: "M03", overlap: 1, verdict: "WORD FOR WORD", load: "ok" },
      { ad_id: "M11", overlap: 0, verdict: "MISMATCH", load: "ok" },
      { ad_id: "T07", overlap: 1, verdict: "MATCH", load: "SLOW" },
    ]);
    expect(r.summary).toEqual({ mismatch: 1 });
  });
});

describe("19 anomaly-explainer refuses on thin data", () => {
  const days = (n: number, start: string, conv: number) => Array.from({ length: n }, (_, i) => `${new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)},${conv * 10},${conv}`);
  it("refuses, lists each failed gate, and names the earliest date a read is possible", () => {
    const r = go("anomaly-explainer", table("date,spend,conversions", ...days(30, "2026-09-01", 2)), { change_date: "2026-09-25" });
    expect(r.summary.verdict).toBe("REFUSED: NO CAUSE NAMED");
    expect(r.summary.failed_gates).toEqual(expect.arrayContaining([expect.stringMatching(/after-window 4d < 7d/), expect.stringMatching(/baseline 48 conv|after-window 8 conv < 30/)]));
    expect(String(r.summary.earliest_read)).toMatch(/^2026-/);
  });
  it("reads the shift once both sides have enough days and conversions, dropping the last two days", () => {
    const r = go("anomaly-explainer", table("date,spend,conversions", ...days(20, "2026-09-01", 5), ...days(20, "2026-09-21", 4)), { change_date: "2026-09-21" });
    expect(r.summary).toMatchObject({ verdict: "READ OK", cpa_before: 10, cpa_after: 10, shift: 0, days_dropped_for_lag: 2 });
  });
  it("needs the change date", () => {
    expect(() => go("anomaly-explainer", table("date,spend,conversions", "2026-09-01,10,1"))).toThrow(/change_date/);
  });
});

describe("20 test-readout refuses a winner the data cannot carry", () => {
  const arms = (convA: number, convB: number, clicks = 2000) => table("arm,impressions,clicks,conversions", `A,50000,${clicks},${convA}`, `B,50000,${clicks},${convB}`);
  it("names a winner only when every gate passes", () => {
    const r = go("test-readout", arms(120, 70), { hours_live: "96" });
    expect(r.summary).toMatchObject({ verdict: "WINNER: A", cvr_A: 0.06, cvr_B: 0.035 });
  });
  it("refuses and lists every failed gate", () => {
    const thin = go("test-readout", arms(12, 5, 300), { hours_live: "30" }).summary;
    expect(thin.verdict).toBe("REFUSED: NO WINNER YET");
    expect(thin.failed_gates).toEqual(expect.arrayContaining(["A: 12 conv < 30", "B: 5 conv < 30", "live 30h < 72h"]));
    const close = go("test-readout", arms(80, 76), { hours_live: "96" }).summary;
    expect(close.verdict).toBe("REFUSED: NO WINNER YET");
    expect(close.failed_gates).toEqual([expect.stringMatching(/\|z\| 0\.\d+ < 1\.96/)]);
  });
  it("cannot divide by zero clicks", () => {
    expect(go("test-readout", table("arm,impressions,clicks,conversions", "A,5000,0,0", "B,5000,0,0"), { hours_live: "96" }).summary).toMatchObject({ verdict: "REFUSED: NO WINNER YET" });
  });
  it("needs two arms and the hours live", () => {
    expect(() => go("test-readout", table("arm,impressions,clicks,conversions", "A,1,1,1"), { hours_live: "96" })).toThrow(/two arms/);
    expect(go("test-readout", arms(120, 70)).summary.verdict).toBe("REFUSED: NO WINNER YET");
  });
});

describe("files, parameters and rendering", () => {
  it("names missing columns and unknown parameters", () => {
    expect(() => go("fatigue-call", table("ad_id,cpm_prev", "A,1"))).toThrow(/fatigue.csv is missing column\(s\): cpm_now, ctr_prev, ctr_now, frequency/);
    expect(() => runMedia("fair-test", table("ad_id,impressions", "A,1"), { cfg, params: { nonsense: "1" } })).toThrow(/does not take nonsense=/);
    expect(() => runMedia("nope", "", { cfg })).toThrow(MediaRuleError);
    expect(() => go("fair-test", table("ad_id,impressions"))).toThrow(/has no rows/);
  });
  it("accepts spend or spend_30d for leave-it-alone", () => {
    expect(go("leave-it-alone", table("ad_id,spend,purchases", "A,100,5"), { target_cpa: "30" }).summary.verdict).toBe("LEAVE ALONE");
    expect(() => go("leave-it-alone", table("ad_id,purchases", "A,5"), { target_cpa: "30" })).toThrow(/spend or spend_30d/);
  });
  it("splits key=value arguments from the file", () => {
    expect(splitArgs(["ads.csv", "target_cpa=40", "now=2026-10-05T09:00"])).toEqual({ file: "ads.csv", params: { target_cpa: "40", now: "2026-10-05T09:00" } });
    expect(() => splitArgs(["a.csv", "b.csv"])).toThrow(/one file at most/);
  });
  it("parses quoted CSV and rejects an empty header", () => {
    expect(parseRows('a,b\n"x, y",2\n')).toEqual([{ a: "x, y", b: "2" }]);
    expect(() => parseRows("")).toThrow(/no header/);
  });
  it("renders a table, a SUMMARY line and warnings", () => {
    const text = renderRule(go("unfunded-ads", table("ad_id,spend_30d,impressions,purchases", "A,500,9000,x")));
    expect(text).toMatch(/^\| ad_id \| platform \| spend_30d/);
    expect(text).toMatch(/SUMMARY \{"never_funded":0,"ads":1,"left_behind_spend_share":1\}/);
    expect(text).toMatch(/warning: row 2 purchases: "x" is not a number/);
  });
});

describe("thresholds are configurable and validated", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "medjay-media-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the defaults when there is no override file", async () => {
    expect(await loadRuleConfig(dir)).toEqual(RULE_DEFAULTS);
  });
  it("applies overrides from context/media-rules.yaml and the rules pick them up", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "context"), { recursive: true }));
    await writeFile(join(dir, "context", "media-rules.yaml"), "thumbstop_floor: 0.3\nbrand_roas_floor: 8\nmanual_bids: [manual_cpc]\n", "utf8");
    const custom = await loadRuleConfig(dir);
    expect(custom).toMatchObject({ thumbstop_floor: 0.3, brand_roas_floor: 8, manual_bids: ["manual_cpc"], concepts_min: 15 });
    const r = runMedia("thumbstop-check", table("ad_id,impressions,hook_views", "A,10000,2800"), { cfg: custom }).result;
    expect(r.rows[0]!.verdict).toBe("HOOK DEAD");
    expect(runMedia("thumbstop-check", table("ad_id,impressions,hook_views", "A,10000,2800"), { cfg }).result.rows[0]!.verdict).toBe("HOOK OK");
  });
  it("rejects unknown keys, out-of-range values and thresholds that contradict each other", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "context"), { recursive: true }));
    for (const [text, expected] of [["thumbstop_flor: 0.3\n", /thumbstop_flor|Unrecognized/], ["thumbstop_floor: 4\n", /thumbstop_floor/], ["concepts_min: 30\n", /concepts_min must not exceed/], ["impr_floor: 5000\n", /impr_floor <= impr_read/], ["{{{", /not valid YAML/]] as const) {
      await writeFile(join(dir, "context", "media-rules.yaml"), text, "utf8");
      await expect(loadRuleConfig(dir)).rejects.toThrow(expected);
    }
    expect(() => resolveRuleConfig({ step_low: 0.5, step_high: 0.1 })).toThrow(RuleConfigError);
  });
});
