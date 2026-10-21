import { describe, expect, it } from "vitest";
import { MappingError, parseMappings } from "./mapping.js";

const base = `
version: 1
funnel: { qualified: [qualified] }
attribution: { source_aliases: { meta: [facebook, instagram] } }
sources:
  - id: meta_ads
    kind: ad_platform
    platform: meta
    currency: SAR
    file: "meta-ads-*.csv"
    columns: { date: Day, campaign: Campaign name, spend: Amount spent }
`;

describe("ingestion mappings", () => {
  it("accepts a minimal mapping and applies defaults", () => {
    const m = parseMappings(base);
    expect(m.sources[0]).toMatchObject({ format: "csv", delimiter: ",", skip_rows: 0, date_format: "iso" });
  });
  it("rejects unknown keys, so a typo is not silently ignored", () => {
    expect(() => parseMappings(base.replace("spend: Amount spent", "spend: Amount spent, cost: X"))).toThrow(MappingError);
  });
  it("rejects a file pattern that leaves the dropzone", () => {
    expect(() => parseMappings(base.replace("meta-ads-*.csv", "../secrets.csv"))).toThrow(/no folders|\.\./);
    expect(() => parseMappings(base.replace("meta-ads-*.csv", "sub/meta.csv"))).toThrow(/no folders/);
  });
  it("rejects duplicate source ids and aliases for an unknown platform", () => {
    const dup = `${base}  - id: meta_ads\n    kind: ad_platform\n    platform: meta\n    currency: SAR\n    file: b.csv\n    columns: { date: d, campaign: c, spend: s }\n`;
    expect(() => parseMappings(dup)).toThrow(/duplicate source id/);
    expect(() => parseMappings(base.replace("meta: [facebook", "tiktok: [tt"))).toThrow(/no ad_platform source has platform "tiktok"/);
  });
  it("requires an ISO currency for money sources", () => {
    expect(() => parseMappings(base.replace("currency: SAR", "currency: riyal"))).toThrow(/ISO 4217/);
  });
});

describe("ad_summary sources (platform UI exports with no date column)", () => {
  const yaml = (extra = "") => `version: 1
sources:
  - id: google-campaigns
    kind: ad_summary
    platform: google
    currency: SAR
    file: "Campaigns(*).csv"
    dimension: campaign
    columns:
      key: Campaign Name
      spend: Cost
      conversions: Conversions${extra}
attribution:
  source_aliases: {}
`;
  it("accepts a summary source and fills in the defaults", () => {
    const m = parseMappings(yaml());
    expect(m.sources[0]).toMatchObject({ kind: "ad_summary", dimension: "campaign", delimiter: ",", columns: { key: "Campaign Name", spend: "Cost" } });
  });
  it("rejects an unknown dimension, a missing key column and stray fields", () => {
    expect(() => parseMappings(yaml().replace("dimension: campaign", "dimension: galaxy"))).toThrow(/dimension/);
    expect(() => parseMappings(yaml().replace("      key: Campaign Name\n", ""))).toThrow(/key/);
    expect(() => parseMappings(yaml("\n      colour: red"))).toThrow(/colour|unrecognized/i);
  });
});
