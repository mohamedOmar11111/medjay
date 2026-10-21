import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnose } from "../analysis/diagnose.js";
import { scout, type Snapshot } from "../analysis/scout.js";
import { loadUnitEconomics, simulate } from "../analysis/simulate.js";
import { FIXTURE_NOW, setupIngest, type IngestHarness } from "../../test/helpers/ingest.js";
import { approveAnswer, dataAnswer, errorAnswer, helpAnswer, languageAnswer, modelErrorAnswer, noDataAnswer, noModelAnswer, performanceAnswer, periodLabel, plansAnswer, renderAnswer, scaleAnswer, summaryPerformanceAnswer, summaryWasteAnswer, trustAnswer, wasteAnswer, type Answer } from "./answers.js";
import type { PeriodSummary } from "../analysis/summary.js";
import { emptyDashboard, type Dashboard } from "./dashboard.js";

const JARGON = /\bMER\b|P10|P50|P90|calibration|Monte Carlo|percentile|ROAS|adset|\bUTM\b/i;
const text = (a: Answer, lang: "en" | "ar" = "en") => renderAnswer(a, lang);

let h: IngestHarness;
let snapshot: Snapshot;
beforeEach(async () => {
  h = await setupIngest();
  await h.ingest();
  snapshot = scout({ store: h.store, mappings: h.deps.mappings, baseCurrency: "SAR", timezone: "Asia/Riyadh", now: FIXTURE_NOW, days: 7, freshnessSlaHours: 24 });
});
afterEach(async () => {
  await h.cleanup();
});

describe("performance", () => {
  it("leads with spend and confirmed sales in plain words and calls out an over-claiming platform", () => {
    const a = performanceAnswer(snapshot, "en", "data/imports");
    expect(a.headline).toMatch(/^Between 10–16 Oct you spent SAR 26,880, and your CRM confirms SAR [\d,]+ in sales\.$/);
    expect(a.headline).toContain("SAR 26,880");
    expect(a.body.join("\n")).toMatch(/back for every 1 SAR spent/);
    expect(a.body.join("\n")).toMatch(/Google says it returned [\d.]+× its spend, but your CRM only confirms [\d.]+×\. Trust the CRM\./);
    expect(text(a)).not.toMatch(JARGON);
    expect(a.next.map((n) => n.intent)).toEqual(["waste", "scale", "plans"]);
  });
  it("says what to do when there is no data", () => {
    const a = noDataAnswer("en", "data/imports");
    expect(a.headline).toBe("I don't have any ad numbers yet.");
    expect(a.body[0]).toContain("data/imports");
  });
  it("answers in Arabic with the same numbers and ASCII currency", () => {
    const en = performanceAnswer(snapshot, "en", "data/imports");
    const ar = performanceAnswer(snapshot, "ar", "data/imports");
    expect(ar.headline).toMatch(/[؀-ۿ]/);
    expect(ar.headline).toContain("SAR 26,880");
    expect(ar.headline.match(/SAR \d[\d,]*\d/g)).toEqual(en.headline.match(/SAR \d[\d,]*\d/g));
    expect(text(ar, "ar")).toContain("اكتب رقم");
  });
});

describe("what is wasting money", () => {
  it("names the ad set, the amount and a safe next step, without jargon", () => {
    const a = wasteAnswer(diagnose(snapshot), "en", "data/imports");
    expect(a.headline).toMatch(/SAR [\d,]+ went to ads that bought nothing your CRM can see/);
    const body = a.body.join("\n");
    expect(body).toContain("UMRAH-ALL-Broad-Reels on Meta spent SAR 3,780");
    expect(body).toMatch(/pause it or cut its budget \(I can prepare that for your approval\)/);
    expect(body).toMatch(/Judge it by leads and sales in your CRM/);
    expect(text(a)).not.toMatch(JARGON);
    expect(a.body.length).toBeLessThanOrEqual(4);
  });
  it("keeps the facts identical in Arabic", () => {
    const d = diagnose(snapshot);
    const en = wasteAnswer(d, "en", "data/imports");
    const ar = wasteAnswer(d, "ar", "data/imports");
    expect(ar.body.join("\n")).toContain("UMRAH-ALL-Broad-Reels على Meta صرفت SAR 3,780");
    expect(ar.headline.match(/SAR [\d,]+/g)).toEqual(en.headline.match(/SAR [\d,]+/g));
  });
  it("is calm when nothing is wrong", () => {
    const a = wasteAnswer({ ...diagnose(snapshot), findings: [], top: [] }, "en", "data/imports");
    expect(a.headline).toBe("Nothing alarming this period.");
  });
});

describe("can I scale", () => {
  it("says not yet, with the chance and the safety rule, when the check fails", async () => {
    const economics = await loadUnitEconomics(h.dir);
    const sim = simulate(economics, { spend: snapshot.totals.spend, scalePct: 15 });
    const a = scaleAnswer(sim, 15, "en", 0.6, "SAR");
    expect(a.headline).toMatch(/^Not yet\. Raising spend by 15% has only about a \d+% chance of paying off, and my safety rule needs 60%\.$/);
    expect(a.body.join("\n")).toMatch(/You break even at SAR [\d,]+ per sale/);
    expect(a.body.join("\n")).toMatch(/not a forecast/);
    expect(text(a)).not.toMatch(JARGON);
  });
  it("is encouraging, with the same facts, when the check passes", async () => {
    const economics = await loadUnitEconomics(h.dir);
    const sim = simulate(economics, { spend: snapshot.totals.spend, scalePct: 15 });
    if (sim.status !== "ok") throw new Error("fixture economics should be complete");
    const passing = { ...sim, monte_carlo: { ...sim.monte_carlo, p50: 5000, p_positive: 0.8 } };
    expect(scaleAnswer(passing, 15, "en", 0.6, "SAR").headline).toBe("Raising spend by 15% looks worth trying: about a 80% chance of coming out ahead.");
  });
  it("asks for the missing business numbers in plain words", () => {
    const a = scaleAnswer({ status: "insufficient_inputs", problems: [{ input: "average_deal_value", problem: "missing", message: "x" }] }, 20, "en", 0.6, "SAR");
    expect(a.headline).toMatch(/missing a few numbers/);
    expect(a.body[0]).toBe("• average deal value");
    expect(a.body.join("\n")).toContain("context/unit-economics.md");
  });
});

describe("plans, data, trust, approvals", () => {
  const dash: Dashboard = {
    ...emptyDashboard(),
    plans: [
      { number: 1, state: "proposed", id: "pl_1", expires_at: "2099-01-01T00:00:00Z" },
      { number: 2, state: "exported", id: "pl_2", expires_at: "2099-01-01T00:00:00Z" },
    ],
    data: { status: "ok", period: { start: "2026-10-10", end: "2026-10-16", days: 7 }, sources: [{ id: "meta_ads:meta-ads.csv", ageDays: 1, stale: false, errors: 0 }, { id: "ga4:ga4.csv", ageDays: 9, stale: true, errors: 0 }, { id: "crm:crm.json", ageDays: 0, stale: false, errors: 2 }] },
  };
  it("lists plans in plain words and points to the terminal for the decision", () => {
    const a = plansAnswer(dash, "en");
    expect(a.headline).toBe("1 plan(s) waiting for your decision.");
    expect(a.body).toEqual(expect.arrayContaining(["#1: waiting for your approval", "#2: applied (files exported)"]));
    expect(a.body.join("\n")).toContain("mdj diff 1");
    expect(a.body.join("\n")).toContain("mdj approve 1, then mdj strike 1");
  });
  it("says nothing is waiting when there are no plans", () => {
    expect(plansAnswer(emptyDashboard(), "en").headline).toBe("Nothing is waiting for you.");
  });
  it("shows which files are old or failing", () => {
    const a = dataAnswer(dash, "en", "data/imports");
    expect(a.headline).toBe("2 of your files need attention.");
    expect(a.body).toEqual(["✓ Meta Ads: 1 day(s) old", "✗ Website analytics: 9 day(s) old", "✗ Your CRM: today, 2 problem(s) reading it"]);
  });
  it("reads the ledger check result", () => {
    expect(trustAnswer("mdj ledger verify: OK, 42 entries, head abc", "en").headline).toBe("Your activity log is intact: 42 entries, none altered.");
    expect(trustAnswer("FAILED: entry 3 hash mismatch", "en").headline).toMatch(/did not verify/);
  });
  it("never approves, and gives the exact ASCII commands in both languages", () => {
    for (const lang of ["en", "ar"] as const) {
      const body = approveAnswer(3, lang).body.join("\n");
      expect(body).toContain("1) mdj diff 3");
      expect(body).toContain("3) mdj strike 3");
    }
    expect(approveAnswer(undefined, "en").body.join("\n")).toContain("mdj approve <number>");
  });
});

describe("help, language, errors", () => {
  it("greets and offers numbered questions", () => {
    const a = helpAnswer("en", true);
    expect(a.headline).toBe("Hi! I'm Medjay. Ask me in your own words.");
    expect(text(a)).toMatch(/> {3}1\. How are my ads doing\?/);
    expect(a.next.length).toBe(6);
  });
  it("explains the missing model in plain words in both languages", () => {
    expect(noModelAnswer("en").body[0]).toContain("mdj auth set anthropic");
    expect(noModelAnswer("ar").headline).toMatch(/[؀-ۿ]/);
  });
  it("switches language and wraps errors", () => {
    expect(languageAnswer("ar").headline).toMatch(/[؀-ۿ]/);
    expect(errorAnswer("en", "boom\nline2").body).toEqual(["boom\nline2"]);
  });
  it("labels periods in both languages", () => {
    expect(periodLabel("2026-10-10", "2026-10-16", "en")).toBe("10–16 Oct");
    expect(periodLabel("2026-09-28", "2026-10-04", "en")).toBe("28 Sep – 4 Oct");
    expect(periodLabel("2026-10-10", "2026-10-16", "ar")).toBe("10–16 أكتوبر");
  });
});

describe("modelErrorAnswer", () => {
  const f = (kind: "no_key" | "key_malformed" | "key_rejected" | "quota" | "model_not_found" | "network" | "other", detail = "d", provider = "openai") => ({ kind, provider, detail });
  it("says what is wrong and the exact next step, in ASCII commands", () => {
    expect(text(modelErrorAnswer(f("no_key"), "en"))).toContain("/connect openai");
    expect(text(modelErrorAnswer(f("key_rejected"), "en"))).toMatch(/rejected/);
    expect(text(modelErrorAnswer(f("key_malformed"), "en"))).toMatch(/stray/);
    expect(text(modelErrorAnswer(f("quota", "regain access on 2026-11-01 at 00:00 UTC"), "en"))).toContain("2026-11-01");
    expect(text(modelErrorAnswer(f("network"), "en"))).toMatch(/reach/);
    expect(text(modelErrorAnswer(f("model_not_found"), "en"))).toContain("workspace.yaml");
  });
  it("answers in Arabic with ASCII commands", () => {
    const a = modelErrorAnswer(f("no_key", "d", "anthropic"), "ar");
    expect(a.headline).toMatch(/[؀-ۿ]/);
    expect(text(a, "ar")).toContain("/connect anthropic");
  });
  it("never repeats the old catch-all for a stored-but-rejected key", () => {
    expect(text(modelErrorAnswer(f("key_rejected"), "en"))).not.toMatch(/not connected to an AI model yet/);
  });
});

describe("answers from a period summary (platform reports with no CRM yet)", () => {
  const S: PeriodSummary = {
    platform: "google",
    currency: "SAR",
    period: { start: "2026-09-01", end: "2026-09-30", days: 30 },
    totals: { spend: 33304.31, conversions: 405, clicks: 0, cost_per_conversion: 82.23 },
    campaigns: [
      { name: "georgia", spend: 8450, conversions: 78, cost_per_conversion: 108.33, share_of_spend: 0.254 },
      { name: "Europe", spend: 6682.09, conversions: 132, cost_per_conversion: 50.62, share_of_spend: 0.201 },
      { name: "Bosnia", spend: 688, conversions: 3, cost_per_conversion: 229.21, share_of_spend: 0.021 },
    ],
    zero_conversion_terms: [
      { term: "thailand", spend: 164.71, clicks: 17 },
      { term: "جورجيا سياحة", spend: 153.42, clicks: 13 },
      { term: "تايلاند", spend: 152.02, clicks: 35 },
      { term: "fourth", spend: 100, clicks: 5 },
    ],
    zero_conversion_total: { terms: 87, spend: 3843.2 },
    top_keywords: [],
    devices: [],
    daily: [],
    notes: ["The search term report has exactly 100 rows, which usually means the platform cut it off; there may be more search terms than shown here."],
  };

  it("leads with spend and what it bought, names the cheapest and dearest campaign, and is honest about the source", () => {
    const a = summaryPerformanceAnswer(S, "en");
    expect(a.headline).toBe("Between 1–30 Sep you spent SAR 33,304 and Google reports 405 conversions, about SAR 82 each.");
    const body = a.body.join("\n");
    expect(body).toContain("Europe is your cheapest at SAR 51 per conversion");
    expect(body).toContain("Bosnia is the dearest at SAR 229");
    expect(body).toContain("87 search terms spent SAR 3,843 and never converted");
    expect(body).toMatch(/Google's own numbers/);
    expect(text(a)).not.toMatch(JARGON);
  });

  it("names the biggest wasters with their cost and offers the safe next step", () => {
    const a = summaryWasteAnswer(S, "en");
    expect(a.headline).toBe("SAR 3,843 went to 87 search terms that never turned into a conversion.");
    const body = a.body.join("\n");
    expect(body).toContain("thailand: SAR 165");
    expect(body).toContain("جورجيا سياحة: SAR 153");
    expect(body).not.toContain("fourth");
    expect(body).toMatch(/negative keywords \(I can prepare that for your approval\)/);
    expect(body).toMatch(/cut it off/);
  });

  it("answers in Arabic with the same numbers", () => {
    const a = summaryWasteAnswer(S, "ar");
    expect(a.headline).toMatch(/[؀-ۿ]/);
    expect(a.headline).toContain("SAR 3,843");
    expect(summaryPerformanceAnswer(S, "ar").headline).toContain("SAR 33,304");
  });
});
