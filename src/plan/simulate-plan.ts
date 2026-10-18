// Simulate the budget increase a proposed plan makes, store the result, and (when it passes the gate)
// attach it as a revised plan. Shared by `mdj simulate --plan`, the WhatsApp bridge and the demo.
import { recordOf, refOf, scaleOf, SimulationRepo, type BudgetMove, type SimulationRecord } from "../analysis/sim-repo.js";
import { simulate, type SimulationResult, type UnitEconomics } from "../analysis/simulate.js";
import type { Store } from "../store/db.js";
import { readPlanFile } from "./files.js";
import type { PlanDeps } from "./propose.js";
import { reviseWithSimulation } from "./revise.js";

export const WHY_NOT: Record<string, string> = {
  no_budget_change: "has no budget change",
  mixed_currency: "mixes currencies in its budget changes",
  no_baseline: "raises a budget that starts at zero, so a percentage cannot be derived",
  not_a_scale_up: "does not raise any budget",
};

export interface PlanSimOptions {
  planNumber: number;
  economics: UnitEconomics;
  observed?: { cost_per_deal: number | null; blended_mer: number | null } | undefined;
  horizonDays?: number;
  seed?: number;
  draws?: number;
  elasticity?: number;
  attach: boolean;
  actor: string;
}

export type PlanSimOutcome =
  | { kind: "not_applicable"; reason: keyof typeof WHY_NOT; needed: boolean; message: string }
  | { kind: "insufficient_inputs"; result: Extract<SimulationResult, { status: "insufficient_inputs" }> }
  | {
      kind: "done";
      result: Extract<SimulationResult, { status: "ok" }>;
      record: SimulationRecord;
      passes: boolean;
      minPositive: number;
      attachedAs: number | null;
    };

export async function simulatePlan(deps: PlanDeps, store: Store, options: PlanSimOptions): Promise<PlanSimOutcome> {
  const horizon = options.horizonDays ?? 7;
  const row = deps.repo.require(options.planNumber);
  const plan = await readPlanFile(deps.dir, row);
  const moves: BudgetMove[] = plan.actions.flatMap((a) => (a.type === "budget_change" && !(a as { restores?: boolean }).restores ? [{ from: a.from, to: a.to, currency: a.currency }] : []));
  const scale = scaleOf(moves, horizon);
  if (!scale.ok) {
    const needed = !(scale.reason === "not_a_scale_up" || scale.reason === "no_budget_change");
    return { kind: "not_applicable", reason: scale.reason, needed, message: `Plan #${row.number} ${WHY_NOT[scale.reason]}; ${needed ? "no simulation can be run for it." : "no simulation is needed."}` };
  }
  if (options.economics.problems.length === 0 && options.economics.currency !== scale.currency) {
    throw new Error(`plan #${row.number} changes budgets in ${scale.currency} but context/unit-economics.md is in ${options.economics.currency}; Medjay never converts silently`);
  }
  const result = simulate(options.economics, {
    spend: scale.spend,
    scalePct: scale.scalePct,
    ...(options.elasticity === undefined ? {} : { elasticity: options.elasticity }),
    seed: options.seed ?? Number.parseInt(plan.plan_hash.slice(0, 8), 16),
    ...(options.draws === undefined ? {} : { draws: options.draws }),
    observed: options.observed,
  });
  if (result.status !== "ok") return { kind: "insufficient_inputs", result };

  const record = new SimulationRepo(store).put(recordOf(result, horizon, plan.plan_hash, deps.now()));
  const minPositive = deps.policy.limits.min_simulation_p_positive;
  const passes = record.p50 > 0 && record.p_positive >= minPositive;
  await deps.ledger.append({
    actor: options.actor,
    event: "simulation.completed",
    payload: { plan: row.number, plan_hash: plan.plan_hash, simulation: record.sim_id, seed: record.seed, scale_pct: record.scale_pct, p10: record.p10, p50: record.p50, p90: record.p90, p_positive: record.p_positive, passes },
  });
  let attachedAs: number | null = null;
  if (passes && options.attach) {
    attachedAs = (await reviseWithSimulation(deps, row.number, refOf(record), { actor: options.actor })).row.number;
  }
  return { kind: "done", result, record, passes, minPositive, attachedAs };
}
