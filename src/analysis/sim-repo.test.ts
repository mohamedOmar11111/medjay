import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store/db.js";
import { bindingProblem, inputsHash, recordOf, refOf, scaleOf, SimulationRepo } from "./sim-repo.js";
import { parseUnitEconomics, simulate, type SimulationResult } from "./simulate.js";

const NOW = new Date("2026-10-17T10:00:00Z");
const economics = parseUnitEconomics(`---
currency: SAR
cpc: { value: 3.45, low: 2.9, high: 4.2, source: x }
landing_page_cvr: { value: 0.022, low: 0.017, high: 0.03, source: x }
lead_to_chat: { value: 0.85, low: 0.7, high: 0.92, source: x }
chat_to_qualified: { value: 0.6, low: 0.5, high: 0.7, source: x }
qualified_to_deal: { value: 0.32, low: 0.2, high: 0.4, source: x }
average_deal_value: { value: 7000, low: 5500, high: 8500, source: x }
gross_margin: { value: 0.35, low: 0.3, high: 0.4, source: x }
---
`);
const run = (over: Partial<Parameters<typeof simulate>[1]> = {}) => {
  const r: SimulationResult = simulate(economics, { spend: 700, scalePct: 15, seed: 5, ...over });
  if (r.status !== "ok") throw new Error("not ok");
  return r;
};

let dir: string;
let store: Store;
let repo: SimulationRepo;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-sim-"));
  store = Store.open(join(dir, "x.db"));
  repo = new SimulationRepo(store);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("SimulationRepo", () => {
  it("gives the same id to the same simulation, and a different one when any number differs", () => {
    const a = recordOf(run(), 7, "hash-a", NOW);
    const b = recordOf(run(), 7, "hash-b", new Date("2027-01-01"));
    const c = recordOf(run({ seed: 6 }), 7, "hash-a", NOW);
    expect(a.sim_id).toBe(b.sim_id);
    expect(a.sim_id).toMatch(/^sim_[0-9a-f]{12}$/);
    expect(c.sim_id).not.toBe(a.sim_id);
  });

  it("stores and reads back a simulation, idempotently", () => {
    const record = recordOf(run(), 7, "hash-a", NOW);
    repo.put(record);
    repo.put(record);
    expect(repo.require(record.sim_id)).toEqual(record);
    expect(refOf(record)).toMatchObject({ id: record.sim_id, seed: 5, p50: record.p50 });
  });

  it("refuses a simulation whose stored numbers were edited, and an unknown id", () => {
    const record = repo.put(recordOf(run(), 7, null, NOW));
    store.database().prepare("UPDATE simulations SET p50 = 99999 WHERE sim_id = ?").run(record.sim_id);
    expect(() => repo.get(record.sim_id)).toThrow(/database was edited/);
    expect(() => repo.require("sim_nope")).toThrow(/no simulation sim_nope/);
  });

  it("hashes the inputs so a change to unit-economics is visible", () => {
    const a = inputsHash("SAR", economics.inputs);
    const changed = { ...economics.inputs, gross_margin: { value: 0.2, low: 0.15, high: 0.25, source: "y" } };
    expect(inputsHash("SAR", changed)).not.toBe(a);
    expect(inputsHash("USD", economics.inputs)).not.toBe(a);
  });
});

describe("scaleOf and bindingProblem", () => {
  it("adds up budget moves into one spend and one percentage", () => {
    expect(scaleOf([{ from: 100, to: 115, currency: "SAR" }, { from: 50, to: 50, currency: "SAR" }], 7)).toEqual({ ok: true, spend: 1050, scalePct: 10, currency: "SAR" });
  });
  it("says why it cannot", () => {
    expect(scaleOf([], 7)).toEqual({ ok: false, reason: "no_budget_change" });
    expect(scaleOf([{ from: 1, to: 2, currency: "SAR" }, { from: 1, to: 2, currency: "USD" }], 7)).toEqual({ ok: false, reason: "mixed_currency" });
    expect(scaleOf([{ from: 0, to: 5, currency: "SAR" }], 7)).toEqual({ ok: false, reason: "no_baseline" });
    expect(scaleOf([{ from: 100, to: 60, currency: "SAR" }], 7)).toEqual({ ok: false, reason: "not_a_scale_up" });
  });
  it("accepts a simulation for the same move and refuses one for another", () => {
    const record = recordOf(run(), 7, null, NOW);
    expect(bindingProblem(record, [{ from: 100, to: 115, currency: "SAR" }])).toBeNull();
    expect(bindingProblem(record, [{ from: 100, to: 130, currency: "SAR" }])).toMatch(/simulated \+15% on 700, but this plan is \+30%/);
    expect(bindingProblem(record, [{ from: 100, to: 115, currency: "USD" }])).toMatch(/is in SAR, the plan's budgets are in USD/);
    expect(bindingProblem(record, [{ from: 100, to: 90, currency: "SAR" }])).toMatch(/does not raise any budget/);
    const fixedSpend = recordOf(simulate(economics, { spend: 700, seed: 5 }) as Extract<SimulationResult, { status: "ok" }>, 7, null, NOW);
    expect(bindingProblem(fixedSpend, [{ from: 100, to: 115, currency: "SAR" }])).toMatch(/fixed spend, not a scale-up/);
  });
});
