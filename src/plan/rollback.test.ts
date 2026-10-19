import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupPlans, type PlanHarness } from "../../test/helpers/plans.js";
import { approvePlan, rejectPlan } from "./approve.js";
import { PlanInputError, compilePlan } from "./compile.js";
import { PlanStateError } from "./errors.js";
import { proposePlan } from "./propose.js";
import { rollbackPlan } from "./rollback.js";
import { strikePlan } from "./strike.js";
import { PLAN_NOW } from "../../test/helpers/plans.js";

let h: PlanHarness;
beforeEach(async () => {
  h = await setupPlans();
});
afterEach(async () => {
  await h.cleanup();
});

const google = (id: string, name: string) => ({ platform: "google_ads", kind: "campaign", id, name });
const meta = (id: string) => ({ platform: "meta", kind: "adset", id, name: "Broad" });
const approve = (n: number) => approvePlan(h.deps, n, { approver: "cli:omar", channel: "cli" });
const strike = (n: number) => strikePlan(h.deps, n, { actor: "cli:omar" });

const proposals = [
  { type: "budget_change", target: google("1", "Brand Search"), from: 200, to: 90, currency: "SAR" },
  { type: "status_change", target: google("1", "Brand Search"), from: "ENABLED", to: "PAUSED" },
  { type: "add_negative_keywords", target: google("1", "Brand Search"), terms: [{ text: "free", match: "BROAD" }] },
  { type: "budget_change", target: meta("999"), from: 100, to: 40, currency: "SAR" },
  { type: "code_patch", artifact: "patches/hero.diff" },
];

async function struckPlan(over: unknown[] = proposals) {
  const { row } = await proposePlan(h.deps, { workspace: "ws", origin: { job: "diagnose", finding_ids: [] }, proposals: over as never });
  await approve(row.number);
  await strike(row.number);
  return row.number;
}

describe("rollbackPlan", () => {
  it("compiles a new plan of exact inverses, newest action first, and lists what it cannot undo", async () => {
    const n = await struckPlan();
    const { row, plan, skipped } = await rollbackPlan(h.deps, n, { actor: "cli:omar" });
    expect(row.number).toBe(2);
    expect(plan.origin).toMatchObject({ job: "rollback", rollback_of: h.deps.repo.require(n).plan_id });
    expect(plan.actions.map((a) => a.type)).toEqual(["budget_change", "remove_negative_keywords", "status_change", "budget_change"]);
    expect(plan.actions[0]).toMatchObject({ from: 40, to: 100, restores: true });
    expect(plan.actions[3]).toMatchObject({ from: 90, to: 200, restores: true });
    expect(plan.actions[2]).toMatchObject({ from: "PAUSED", to: "ENABLED" });
    expect(skipped).toEqual([{ action_id: "a5", reason: expect.stringContaining("never deployed") }]);
  });

  it("is not blocked by the daily-increase cap or the simulation gate, because it only restores", async () => {
    const n = await struckPlan();
    const { plan } = await rollbackPlan(h.deps, n, { actor: "cli:omar" });
    // 40 -> 100 is +150% and 90 -> 200 is +122%: far over the 20% cap, and no simulation is attached
    expect(plan.policy_result.status).toBe("pass");
    expect(plan.policy_result.checks.filter((c) => c.ok === false || c.rule.includes("simulation"))).toEqual([]);
    expect((await approve(2)).status).toBe("approved");
  });

  it("strikes into the same exports and marks the original plan rolled back only once the rollback is struck", async () => {
    const n = await struckPlan();
    await rollbackPlan(h.deps, n, { actor: "cli:omar" });
    expect(h.deps.repo.require(n).state).toBe("exported");
    await approve(2);
    const struck = await strike(2);
    expect(struck.state).toBe("exported");
    expect(h.deps.repo.require(n).state).toBe("rolled_back");
    const csv = (await readFile(join(struck.exportDir, "google-ads-editor.csv"), "utf8")).slice(1).split("\r\n").filter(Boolean);
    expect(csv).toEqual(["Campaign,Ad Group,Keyword,Criterion Type,Campaign Status,Budget,Status", "Brand Search,,,,Enabled,200,", "Brand Search,,free,Campaign Negative Broad,,,Removed"]);
    expect(await readFile(join(struck.exportDir, "CHANGES.md"), "utf8")).toMatch(/Remove these negative keywords from google_ads campaign "Brand Search": free \[broad\]/);
    const metaDoc = JSON.parse(await readFile(join(struck.exportDir, "meta-mutations.json"), "utf8"));
    expect(metaDoc.requests[0]).toMatchObject({ params: { daily_budget: "10000" }, expect_before: { daily_budget: "4000" } });
    const events = await h.events();
    expect(events.find((e) => e.event === "plan.rollback_proposed")!.payload).toMatchObject({ from: 1, to: 2, skipped: ["a5"] });
    expect(events.find((e) => e.event === "plan.rolled_back")!.payload).toMatchObject({ number: 1, by: 2 });
  });

  it("only undoes what was really exported, and refuses plans that were never struck or are already rollbacks", async () => {
    const { row } = await proposePlan(h.deps, { workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: proposals as never });
    await expect(rollbackPlan(h.deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(PlanStateError);
    await approve(row.number);
    await strike(row.number);
    const first = await rollbackPlan(h.deps, row.number, { actor: "cli:omar" });
    await approve(first.row.number);
    await strike(first.row.number);
    await expect(rollbackPlan(h.deps, first.row.number, { actor: "cli:omar" })).rejects.toThrow(/itself a rollback/);
    await expect(rollbackPlan(h.deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(PlanStateError);
  });

  it("a plan with nothing to undo (only a patch) says so", async () => {
    const n = await struckPlan([{ type: "code_patch", artifact: "patches/hero.diff" }]);
    await expect(rollbackPlan(h.deps, n, { actor: "cli:omar" })).rejects.toThrow(/nothing that can be rolled back/);
  });

  it("skips an action whose export failed, since it never reached the platform", async () => {
    const n = await struckPlan([
      { type: "budget_change", target: meta("999"), from: 100, to: 40, currency: "SAR" },
      { type: "budget_change", target: meta("998"), from: 100, to: 50.555, currency: "SAR" },
    ]);
    expect(h.deps.repo.require(n).state).toBe("partial");
    const { plan, skipped } = await rollbackPlan(h.deps, n, { actor: "cli:omar" });
    expect(plan.actions).toHaveLength(1);
    expect(skipped).toEqual([{ action_id: "a2", reason: "was never exported, so there is nothing to undo" }]);
  });
});

describe("the compiler's rollback guard", () => {
  const policy = () => h.deps.policy;
  const original = async () => {
    const n = await struckPlan([{ type: "budget_change", target: meta("999"), from: 100, to: 40, currency: "SAR" }]);
    const { readPlanFile } = await import("./files.js");
    return readPlanFile(h.dir, h.deps.repo.require(n));
  };

  it("refuses a proposals file that claims to be a rollback", async () => {
    await expect(proposePlan(h.deps, { workspace: "ws", origin: { job: "rollback", finding_ids: [], rollback_of: "pl_000000000000" }, proposals: [{ type: "budget_change", target: meta("1"), from: 10, to: 11, currency: "SAR" }] as never })).rejects.toThrow(/set by `mdj rollback` only/);
  });

  it("refuses a rollback whose action is not an exact inverse, so it cannot smuggle in a new increase", async () => {
    const o = await original();
    const compile = (to: number) =>
      compilePlan(
        { workspace: "ws", origin: { job: "rollback", finding_ids: [] }, proposals: [{ type: "budget_change", target: meta("999"), from: 40, to, currency: "SAR" } as never], rollbackOf: { plan_id: o.plan_id, actions: o.actions }, now: PLAN_NOW },
        { policy: policy() },
      );
    expect(() => compile(500)).toThrow(PlanInputError);
    expect(() => compile(500)).toThrow(/not the exact inverse/);
    expect(compile(100).plan.actions[0]).toMatchObject({ restores: true });
  });

  it("does not let an ordinary plan carry the restores flag: only a rollback compile sets it", async () => {
    const { plan } = compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: [{ type: "budget_change", target: meta("5"), from: 10, to: 12, currency: "SAR" }] as never, now: PLAN_NOW }, { policy: policy() });
    expect((plan.actions[0] as { restores?: boolean }).restores).toBeUndefined();
    expect(plan.policy_result.checks.some((c) => c.rule === "scale_requires_simulation")).toBe(true);
  });

  it("rejecting the rollback plan leaves the original struck", async () => {
    const n = await struckPlan();
    const { row } = await rollbackPlan(h.deps, n, { actor: "cli:omar" });
    await rejectPlan(h.deps, row.number, { actor: "cli:omar" });
    expect(h.deps.repo.require(n).state).toBe("exported");
  });
});
