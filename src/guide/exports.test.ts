import { describe, expect, it } from "vitest";
import { EXPORT_GUIDES, GUIDE_NOTICE, exportGuideSummaries, exportsNeeded } from "./exports.js";

describe("export guides", () => {
  it("cover the sources the ingester reads: Google Ads, Meta Ads, web analytics and a CRM", () => {
    expect(EXPORT_GUIDES.map((g) => g.id)).toEqual(["google_ads_daily", "google_ads_summary", "meta_ads", "ga4", "crm"]);
  });

  it("each says what to export, which columns it needs, and where the file goes", () => {
    for (const guide of EXPORT_GUIDES) {
      expect(guide.report.length, guide.id).toBeGreaterThan(5);
      expect(guide.required_columns.length, guide.id).toBeGreaterThan(2);
      expect(guide.steps.length, guide.id).toBeGreaterThanOrEqual(3);
      expect(guide.save_to, guide.id).toBe("data/imports");
      expect(guide.file_type, guide.id).toMatch(/CSV/);
      expect(guide.written, guide.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("never claims a guide was checked against the live platform", () => {
    for (const guide of EXPORT_GUIDES) expect(guide.verified, guide.id).toBe(false);
    expect(GUIDE_NOTICE).toMatch(/menu names/i);
    expect(GUIDE_NOTICE).toMatch(/not been checked|unverified|may differ/i);
  });

  it("have unique ids and tell the person how the file must be named where the ingester needs it", () => {
    expect(new Set(EXPORT_GUIDES.map((g) => g.id)).size).toBe(EXPORT_GUIDES.length);
    expect(EXPORT_GUIDES.find((g) => g.id === "meta_ads")!.file_name_hint).toMatch(/meta/i);
    expect(EXPORT_GUIDES.find((g) => g.id === "google_ads_daily")!.file_name_hint).toMatch(/google/i);
    expect(EXPORT_GUIDES.find((g) => g.id === "google_ads_summary")!.file_name_hint).toMatch(/\d{4}\.\d{2}\.\d{2}-\d{4}\.\d{2}\.\d{2}/);
  });

  it("exportsNeeded gives one short line per guide, and the summaries drop the long steps", () => {
    expect(exportsNeeded()).toHaveLength(EXPORT_GUIDES.length);
    for (const line of exportsNeeded()) expect(line.length).toBeLessThan(160);
    for (const summary of exportGuideSummaries()) {
      expect(Object.keys(summary)).not.toContain("steps_full");
      expect(summary.steps.length).toBeGreaterThan(0);
    }
  });
});
