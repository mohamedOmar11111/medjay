import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupScout, type ScoutHarness } from "../../test/helpers/scout.js";
import { diagnose, THRESHOLDS } from "./diagnose.js";
import type { Snapshot } from "./scout.js";

let h: ScoutHarness;
beforeEach(async () => {
  h = await setupScout();
});
afterEach(async () => {
  await h.cleanup();
});

const ids = (snapshot: Snapshot) => diagnose(snapshot).findings.map((f) => f.id);

describe("diagnose on the etlaala-ksa fixture", () => {
  it("finds the bleeding ad set, with spend, the platform's claim and the CRM's zero", () => {
    const d = diagnose(h.snapshot());
    const f = d.findings.find((x) => x.kind === "bleeding_adset")!;
    expect(f).toMatchObject({ severity: "high", category: "spend", wasted_spend: 3780 });
    expect(f.summary).toContain("UMRAH-ALL-Broad-Reels");
    expect(f.summary).toMatch(/reports 29 result\(s\)/);
    expect(f.summary).toMatch(/6 lead\(s\), 0 qualified and 0 deals/);
    expect(f.evidence.map((e) => e.source)).toEqual(["meta_ads:meta-ads-2026-10-10_16.csv", "crm:crm-contacts-2026-10-17.json"]);
    expect(f.evidence.every((e) => e.as_of === "2026-10-16")).toBe(true);
  });

  it("finds platform over-attribution against CRM actuals, and the PMax campaign on its own", () => {
    const d = diagnose(h.snapshot());
    const google = d.findings.find((x) => x.id === "over_attribution:google")!;
    expect(google).toMatchObject({ severity: "high", spend_at_risk: 11900 });
    expect(google.title).toContain("2.1x");
    expect(d.findings.find((x) => x.id === "over_attribution:meta")).toMatchObject({ severity: "medium" });
    const pmax = d.findings.find((x) => x.id.includes("pmax"))!;
    expect(pmax.summary).toMatch(/reports 61 conversions/);
    expect(pmax.summary).toMatch(/matched 9 lead/);
  });

  it("sets platform ROAS against Blended MER", () => {
    const f = diagnose(h.snapshot()).findings.find((x) => x.kind === "mer_vs_roas")!;
    expect(f.title).toBe("google ROAS 19.8 vs Blended MER 7.46");
  });

  it("flags the planted instructions as a data-quality finding that quotes only a short excerpt", () => {
    const f = diagnose(h.snapshot()).findings.find((x) => x.kind === "instruction_like_text")!;
    expect(f).toMatchObject({ category: "data", severity: "medium" });
    expect(f.title).toMatch(/^8 data cell/);
    for (const e of f.evidence) expect(String(e.facts.excerpt).length).toBeLessThanOrEqual(THRESHOLDS.excerptChars);
    expect(f.summary).not.toMatch(/ignore your previous/i);
  });

  it("ranks by severity then money, and names the top three money findings", () => {
    const d = diagnose(h.snapshot());
    expect(d.findings[0]!.kind).toBe("bleeding_adset");
    expect(d.findings.map((f) => f.rank)).toEqual(d.findings.map((_, i) => i + 1));
    expect(d.top).toHaveLength(3);
    expect(d.top[0]).toBe(d.findings[0]!.id);
    const byId = new Map(d.findings.map((f) => [f.id, f]));
    expect(d.top.every((id) => byId.get(id)!.category !== "data")).toBe(true);
  });

  it("is deterministic: the same snapshot gives byte-identical findings", () => {
    const a = JSON.stringify(diagnose(h.snapshot()));
    const b = JSON.stringify(diagnose(h.snapshot()));
    expect(a).toBe(b);
  });

  it("does not flag healthy ad sets, and recommends rather than acts", () => {
    const d = diagnose(h.snapshot());
    expect(d.findings.filter((f) => f.kind === "bleeding_adset")).toHaveLength(1);
    for (const f of d.findings) expect(f.recommendation.length).toBeGreaterThan(10);
  });
});

describe("diagnose rules on adjusted data", () => {
  it("does not call a short-lived or small ad set bleeding", () => {
    const s = h.snapshot();
    const broad = s.adsets.find((a) => a.adset === "UMRAH-ALL-Broad-Reels")!;
    broad.active_days = 3;
    expect(ids(s)).not.toContain("bleeding_adset:meta:umrah-all-broad-reels");
    broad.active_days = 7;
    broad.spend = 100;
    expect(ids(s)).not.toContain("bleeding_adset:meta:umrah-all-broad-reels");
  });

  it("flags a low match rate, slow replies and drop-off when the data says so", () => {
    const s = h.snapshot();
    s.match = { ...s.match, rate: 0.7, unmatched: 50 };
    s.conversations = { median_first_response_seconds: 1500, ghost_rate: 0.55, leads_with_response_time: 100 };
    expect(ids(s)).toEqual(expect.arrayContaining(["low_match_rate", "slow_first_response", "conversation_drop_off"]));
  });

  it("flags stale exports, treating a stale ad or CRM export as high", () => {
    const late = diagnose(h.snapshot({ now: new Date("2026-10-20T07:00:00Z") }));
    const stale = late.findings.filter((f) => f.kind === "stale_data");
    expect(stale).toHaveLength(4);
    expect(stale.find((f) => f.id.includes("ga4"))!.severity).toBe("low");
    expect(stale.find((f) => f.id.includes("meta"))!.severity).toBe("high");
  });

  it("reports no_data instead of findings when nothing was ingested", () => {
    const s = h.snapshot();
    const d = diagnose({ ...s, status: "no_data", period: null, platforms: [], adsets: [] });
    expect(d).toMatchObject({ status: "no_data", findings: [], top: [] });
  });
});
