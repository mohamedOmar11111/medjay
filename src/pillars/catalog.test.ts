import { describe, expect, it } from "vitest";
import { BUSINESS_TYPES, DEFAULT_PILLARS, PILLARS, isStubbed, pillarById } from "./catalog.js";

describe("pillar catalog", () => {
  it("defines eleven pillars with consecutive ids", () => {
    expect(PILLARS.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(PILLARS.map((p) => p.key)).size).toBe(11);
  });

  it("marks only pillar 11 as stubbed until after M3", () => {
    expect(PILLARS.filter((p) => isStubbed(p.id)).map((p) => p.id)).toEqual([11]);
    expect(pillarById(11)?.availableFrom).toBe("post-M3");
  });

  it("assigns every pillar a default slot", () => {
    for (const p of PILLARS) expect(["fast", "reasoning", "creative"]).toContain(p.defaultSlot);
  });
});

describe("business types", () => {
  it("are the five MENA-realistic types", () => {
    expect([...BUSINESS_TYPES]).toEqual(["ecom", "b2b_saas", "high_ticket_hybrid", "agency", "local_leadgen"]);
  });

  it("map to valid, unique, sorted default pillars and never enable pillar 11", () => {
    for (const type of BUSINESS_TYPES) {
      const pillars = DEFAULT_PILLARS[type];
      expect(pillars.length).toBeGreaterThan(0);
      expect(new Set(pillars).size).toBe(pillars.length);
      expect([...pillars].sort((a, b) => a - b)).toEqual(pillars);
      expect(pillars.every((id) => pillarById(id) !== undefined)).toBe(true);
      expect(pillars).not.toContain(11);
    }
  });

  it("high_ticket_hybrid enables ads, creative, SEO/GEO, CRO, conversational, offer, measurement, strategy, intelligence", () => {
    expect(DEFAULT_PILLARS.high_ticket_hybrid).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10]);
  });
});
