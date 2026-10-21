import { describe, expect, it } from "vitest";
import { renderSummary } from "./render.js";
import type { PeriodSummary } from "./summary.js";

const S: PeriodSummary = {
  platform: "google",
  currency: "SAR",
  period: { start: "2026-09-01", end: "2026-09-30", days: 30 },
  totals: { spend: 15132.09, conversions: 210, clicks: 0, cost_per_conversion: 72.06 },
  campaigns: [
    { name: "georgia", spend: 8450, conversions: 78, cost_per_conversion: 108.33, share_of_spend: 0.558 },
    { name: "Idle", spend: 120, conversions: 0, cost_per_conversion: null, share_of_spend: 0.008 },
  ],
  zero_conversion_terms: [{ term: "thailand", spend: 164.71, clicks: 17 }],
  zero_conversion_total: { terms: 12, spend: 900.5 },
  top_keywords: [],
  devices: [{ device: "Mobile phones", spend: 29822.18, clicks: 3226, conversions: 345, cost_per_conversion: 86.44 }],
  daily: [],
  notes: ["The devices report adds up to 900 but the campaigns report adds up to 1000 (10% apart)."],
};

describe("renderSummary", () => {
  const text = renderSummary(S);
  it("states the period, platform, currency and the totals", () => {
    expect(text).toContain("2026-09-01..2026-09-30 (30 days)");
    expect(text).toContain("google");
    expect(text).toContain("Spend 15,132");
    expect(text).toContain("Conversions 210");
    expect(text).toContain("72.06");
  });
  it("lists campaigns with their share, and n/a where nothing converted", () => {
    expect(text).toMatch(/georgia\s+8,450\s+78\s+108\.33\s+55\.8%/);
    expect(text).toMatch(/Idle\s+120\s+0\s+n\/a/);
  });
  it("calls out the money spent on search terms that never converted, and the disagreement note", () => {
    expect(text).toContain("12 search terms spent SAR 901 and never converted");
    expect(text).toMatch(/thailand\s+165/);
    expect(text).toContain("10% apart");
  });
});
