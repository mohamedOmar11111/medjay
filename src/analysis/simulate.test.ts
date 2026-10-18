import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE } from "../../test/helpers/ingest.js";
import { ELASTICITY_DEFAULT, funnel, mulberry32, percentile, triangular, loadUnitEconomics, parseUnitEconomics, simulate, type SimulationResult } from "./simulate.js";

const front = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    currency: "SAR",
    cpc: "{ value: 3.45, low: 2.9, high: 4.2, source: x }",
    landing_page_cvr: "{ value: 0.022, low: 0.017, high: 0.03, source: x }",
    lead_to_chat: "{ value: 0.85, low: 0.7, high: 0.92, source: x }",
    chat_to_qualified: "{ value: 0.6, low: 0.5, high: 0.7, source: x }",
    qualified_to_deal: "{ value: 0.32, low: 0.2, high: 0.4, source: x }",
    average_deal_value: "{ value: 7000, low: 5500, high: 8500, source: x }",
    gross_margin: "{ value: 0.22, low: 0.18, high: 0.26, source: x }",
    refund_rate: "{ value: 0.03, low: 0.01, high: 0.06, source: x }",
    bnpl_fee: "{ value: 0.015, low: 0, high: 0.03, source: x }",
    ...over,
  };
  return `---\n${Object.entries(base).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n# notes\n`;
};

const ok = (r: SimulationResult) => {
  if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r;
};
const run = (over: Record<string, string> = {}, options: Partial<Parameters<typeof simulate>[1]> = {}) => simulate(parseUnitEconomics(front(over)), { spend: 10000, ...options });

describe("parseUnitEconomics", () => {
  it("reads ranged inputs and the currency", () => {
    const e = parseUnitEconomics(front());
    expect(e.problems).toEqual([]);
    expect(e.currency).toBe("SAR");
    expect(e.inputs.cpc).toEqual({ value: 3.45, low: 2.9, high: 4.2, source: "x" });
  });

  it("lists every missing and unranged required input, so nothing runs on a bare point estimate", () => {
    const e = parseUnitEconomics(front({ cpc: "{ value: 3.45, low: null, high: null, source: '' }", gross_margin: "{ value: null, low: null, high: null, source: '' }", qualified_to_deal: "0.3" }));
    expect(e.problems.map((p) => [p.input, p.problem])).toEqual([
      ["cpc", "no_range"],
      ["qualified_to_deal", "no_range"],
      ["gross_margin", "missing"],
    ]);
  });

  it("rejects values outside their range, rates above 1 and a missing currency", () => {
    expect(parseUnitEconomics(front({ cpc: "{ value: 9, low: 2.9, high: 4.2, source: x }" })).problems[0]).toMatchObject({ input: "cpc", problem: "out_of_range" });
    expect(parseUnitEconomics(front({ gross_margin: "{ value: 0.5, low: 0.3, high: 1.4, source: x }" })).problems[0]).toMatchObject({ input: "gross_margin", problem: "out_of_range" });
    expect(parseUnitEconomics(front({ currency: "riyal" })).problems[0]).toMatchObject({ input: "currency" });
  });

  it("treats the optional inputs as absent without failing, and says so", () => {
    const e = parseUnitEconomics(front({ refund_rate: "null", bnpl_fee: "null" }));
    expect(e.problems).toEqual([]);
    const r = ok(simulate(e, { spend: 10000 }));
    expect(r.assumptions.join(" ")).toMatch(/refund rate is not set and is treated as 0/);
  });
});

describe("simulate", () => {
  it("runs the funnel in the documented order and gets the base case right", () => {
    const base = ok(run()).scenarios.find((s) => s.name === "base")!.outcome;
    const clicks = 10000 / 3.45;
    const deals = clicks * 0.022 * 0.85 * 0.6 * 0.32;
    const revenue = deals * 7000 * 0.97;
    expect(base.clicks).toBeCloseTo(clicks, 1);
    expect(base.deals).toBeCloseTo(deals, 1);
    expect(base.revenue).toBeCloseTo(revenue, 0);
    expect(base.contribution).toBeCloseTo(revenue * 0.22 - revenue * 0.015 - 10000, 0);
    expect(base.cost_per_deal).toBeCloseTo(10000 / deals, 1);
  });

  it("orders the scenarios pessimistic < base < optimistic", () => {
    const [low, base, high] = ok(run()).scenarios.map((s) => s.outcome.contribution) as [number, number, number];
    expect(low).toBeLessThan(base);
    expect(base).toBeLessThan(high);
  });

  it("breaks even exactly at the stated cost per deal and ROAS", () => {
    const r = ok(run());
    const perDeal = 7000 * 0.97 * (0.22 - 0.015);
    expect(r.break_even.cost_per_deal).toBeCloseTo(perDeal, 1);
    expect(r.break_even.roas).toBeCloseTo(1 / (0.22 - 0.015), 1);
    // spend that buys deals at exactly the break-even cost has zero contribution
    const values = { cpc: 3.45, landing_page_cvr: 0.022, lead_to_chat: 0.85, chat_to_qualified: 0.6, qualified_to_deal: 0.32, average_deal_value: 7000, gross_margin: 0.22, refund_rate: 0.03, bnpl_fee: 0.015 };
    const atBreakEven = funnel({ ...values, cpc: values.cpc * (perDeal / (10000 / funnel(values, 10000).deals)) }, 10000);
    expect(Math.abs(atBreakEven.contribution)).toBeLessThan(5);
  });

  it("ranks the inputs by how much they move the result", () => {
    const s = ok(run()).sensitivity;
    expect(s.length).toBe(9);
    expect([...s].sort((a, b) => b.swing - a.swing).map((x) => x.input)).toEqual(s.map((x) => x.input));
    expect(s[0]!.swing).toBeGreaterThan(s.at(-1)!.swing);
    expect(s.every((x) => x.contribution_at_best >= x.contribution_at_worst)).toBe(true);
  });

  it("with no elasticity a scale-up scales contribution linearly; with the default it earns less than that", () => {
    const flat = ok(run({}, { scalePct: 50, elasticity: 0 })).scenarios[1]!;
    expect(flat.scaled!.contribution).toBeCloseTo(flat.outcome.contribution * 1.5, 0);
    const real = ok(run({}, { scalePct: 50 }));
    const base = real.scenarios[1]!;
    expect(base.scaled!.contribution).toBeLessThan(flat.scaled!.contribution);
    expect(real.scale).toMatchObject({ pct: 50, elasticity: ELASTICITY_DEFAULT, spend: 15000 });
    expect(real.assumptions.join(" ")).toMatch(/ASSUMPTION: cost per click rises with spend/);
  });

  it("shows a scale-up destroying margin when the margin is thin", () => {
    const thin = ok(run({ gross_margin: "{ value: 0.1, low: 0.08, high: 0.12, source: x }" }, { scalePct: 100, elasticity: 1 }));
    expect(thin.scenarios[1]!.contribution_delta!).toBeLessThan(0);
  });

  it("stops with the list of problems instead of a number", () => {
    const r = run({ cpc: "null" });
    expect(r.status).toBe("insufficient_inputs");
    if (r.status === "insufficient_inputs") expect(r.problems[0]).toMatchObject({ input: "cpc", problem: "missing" });
  });

  it("compares the model with what scout observed", () => {
    const r = ok(run({}, { observed: { cost_per_deal: 960, blended_mer: 7.46 } }));
    expect(r.observed_check).toMatchObject({ observed_cost_per_deal: 960, observed_mer: 7.46 });
    expect(r.observed_check!.model_cost_per_deal).toBeGreaterThan(0);
  });

  it("is deterministic and rejects nonsense options", () => {
    expect(JSON.stringify(run({}, { scalePct: 30 }))).toBe(JSON.stringify(run({}, { scalePct: 30 })));
    expect(() => run({}, { spend: 0 })).toThrow(/spend/);
    expect(() => run({}, { scalePct: -100 })).toThrow(/scale-pct/);
    expect(() => run({}, { elasticity: 5 })).toThrow(/elasticity/);
  });
});

describe("seeded Monte Carlo", () => {
  it("gives byte-identical results for the same seed and different ones for another", () => {
    const a = ok(run({}, { seed: 7 })).monte_carlo;
    const b = ok(run({}, { seed: 7 })).monte_carlo;
    const c = ok(run({}, { seed: 8 })).monte_carlo;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.p50).not.toBe(c.p50);
    expect(a).toMatchObject({ seed: 7, draws: 10000, target: "contribution" });
  });

  it("orders P10 <= P50 <= P90 and keeps the median near the deterministic base case", () => {
    const r = ok(run());
    const mc = r.monte_carlo;
    expect(mc.p10).toBeLessThanOrEqual(mc.p50);
    expect(mc.p50).toBeLessThanOrEqual(mc.p90);
    const base = r.scenarios[1]!.outcome.contribution;
    // draws are independent triangulars, so the median sits near (not exactly on) the all-values case
    expect(Math.abs(mc.p50 - base)).toBeLessThan(Math.abs(base) * 0.25);
    expect(r.scenarios[0]!.outcome.contribution).toBeLessThan(mc.p10);
    expect(r.scenarios[2]!.outcome.contribution).toBeGreaterThan(mc.p90);
  });

  it("describes the CHANGE when scaling, and P(delta > 0) falls as the margin thins", () => {
    const healthy = ok(run({}, { scalePct: 50, elasticity: 0.25 })).monte_carlo;
    const thin = ok(run({ gross_margin: "{ value: 0.1, low: 0.08, high: 0.12, source: x }" }, { scalePct: 50, elasticity: 0.25 })).monte_carlo;
    expect(healthy.target).toBe("contribution_delta");
    expect(healthy.p_positive).toBeGreaterThan(thin.p_positive);
    expect(thin.p50).toBeLessThan(healthy.p50);
  });

  it("is certain when there is no uncertainty", () => {
    const pinned = (v: string) => `{ value: ${v}, low: ${v}, high: ${v}, source: x }`;
    const r = ok(run({ cpc: pinned("3.45"), landing_page_cvr: pinned("0.022"), lead_to_chat: pinned("0.85"), chat_to_qualified: pinned("0.6"), qualified_to_deal: pinned("0.32"), average_deal_value: pinned("7000"), gross_margin: pinned("0.22"), refund_rate: pinned("0.03"), bnpl_fee: pinned("0.015") }));
    expect(r.monte_carlo.p10).toBeCloseTo(r.monte_carlo.p90, 2);
    expect(r.monte_carlo.p50).toBeCloseTo(r.scenarios[1]!.outcome.contribution, 0);
    expect(r.monte_carlo.p_positive).toBe(1);
  });

  it("rejects a bad seed or draw count", () => {
    expect(() => run({}, { seed: -1 })).toThrow(/seed/);
    expect(() => run({}, { seed: 1.5 })).toThrow(/seed/);
    expect(() => run({}, { draws: 10 })).toThrow(/draws/);
  });

  it("the primitives behave: mulberry32 is deterministic, triangular stays in range, percentile interpolates", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const r = mulberry32(3);
    for (let i = 0; i < 1000; i += 1) {
      const x = triangular(r(), 2, 3, 10);
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThanOrEqual(10);
    }
    expect(triangular(0.5, 5, 5, 5)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
});

describe("the etlaala-ksa unit economics file", () => {
  it("parses cleanly and the model lands near what the fixture CRM shows", async () => {
    const economics = parseUnitEconomics(await readFile(join(FIXTURE, "context", "unit-economics.md"), "utf8"));
    expect(economics.problems).toEqual([]);
    const r = ok(simulate(economics, { spend: 26880 }));
    // the fixture's observed Blended MER is 7.46 and cost per deal 960
    const base = r.scenarios[1]!.outcome;
    expect(base.mer).toBeGreaterThan(5);
    expect(base.mer).toBeLessThan(10);
    expect(base.cost_per_deal!).toBeGreaterThan(700);
    expect(base.cost_per_deal!).toBeLessThan(1300);
  });

  it("reports a missing file as an input problem", async () => {
    const e = await loadUnitEconomics(join(FIXTURE, "nope"));
    expect(e.problems[0]).toMatchObject({ input: "context/unit-economics.md", problem: "missing" });
  });
});
