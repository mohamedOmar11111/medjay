// Attaching a simulation to a proposed plan. A plan's hash covers its simulation, so this does not
// edit the plan: it compiles a NEW plan from the same actions with the simulation attached, stores it
// as proposed, and rejects the old one as superseded. The old file is kept for the record.
import { approveGuard } from "./guard.js";
import { readPlanFile } from "./files.js";
import { proposePlan, type PlanDeps } from "./propose.js";
import type { PlanRow } from "./repo.js";
import { rejectPlan } from "./approve.js";
import type { CompiledAction, Plan, ProposalInput, SimulationRef } from "./types.js";

/** The proposal a compiled action came from (the compiler adds ids, inverses and executors). */
export function proposalOf(action: CompiledAction): ProposalInput {
  switch (action.type) {
    case "budget_change":
      return { type: "budget_change", target: action.target, from: action.from, to: action.to, currency: action.currency, executor: action.executor };
    case "status_change":
      return { type: "status_change", target: action.target, from: action.from, to: action.to, executor: action.executor };
    case "add_negative_keywords":
      return { type: "add_negative_keywords", target: action.target, terms: action.terms, executor: action.executor };
    case "remove_negative_keywords":
      return { type: "remove_negative_keywords", target: action.target, terms: action.terms, executor: action.executor };
    case "code_patch":
      return { type: "code_patch", artifact: action.artifact };
    case "publish_post":
      return { type: "publish_post", site: action.site, draft: action.draft, title: action.title, post_status: action.post_status, ...(action.wp_slug ? { wp_slug: action.wp_slug } : {}), executor: action.executor };
    case "register_experiment":
      return { type: "register_experiment", experiment_id: action.experiment_id, ...(action.tactic_id ? { tactic_id: action.tactic_id } : {}), hypothesis: action.hypothesis, metric: action.metric };
  }
}

export async function reviseWithSimulation(
  deps: PlanDeps,
  number: number,
  simulation: SimulationRef,
  options: { actor: string; expiresInHours?: number },
): Promise<{ row: PlanRow; plan: Plan; superseded: PlanRow }> {
  const old = deps.repo.require(number);
  approveGuard(old, number);
  const plan = await readPlanFile(deps.dir, old);
  const next = await proposePlan(deps, {
    workspace: plan.workspace,
    ...(plan.client === undefined ? {} : { client: plan.client }),
    origin: plan.origin,
    proposals: plan.actions.map(proposalOf),
    simulation,
    ...(options.expiresInHours ? { expiresInHours: options.expiresInHours } : {}),
  });
  const superseded = await rejectPlan(deps, number, { actor: options.actor, reason: `superseded by #${next.row.number} (simulation ${simulation.id} attached)` });
  await deps.ledger.append({
    actor: options.actor,
    event: "plan.revised",
    payload: { from: number, to: next.row.number, from_plan_id: old.plan_id, to_plan_id: next.plan.plan_id, simulation: simulation.id },
  });
  return { row: next.row, plan: next.plan, superseded };
}
