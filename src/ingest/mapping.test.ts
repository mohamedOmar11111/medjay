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
