// Rollback: undo a struck plan by compiling a NEW plan of exact inverses. It goes through the same
// policy check, approval and strike as any other plan, nothing is reverted behind anyone's back. The
// compiler refuses a rollback plan whose actions are not exact inverses of the original's, and treats
// a budget that is restored to its earlier value as a restoration (so the daily-increase cap and the
// simulation gate, which exist to stop NEW scaling, do not trap you in a bad state).
import { readPlanFile } from "./files.js";
import { PlanStateError } from "./errors.js";
import { proposePlan, type PlanDeps } from "./propose.js";
import type { PlanRow } from "./repo.js";
import type { CompiledAction, Plan, ProposalInput } from "./types.js";

const ROLLBACKABLE = new Set(["exported", "executed", "verified", "partial"]);
const APPLIED = new Set(["exported", "recorded"]);

export interface Skipped {
  action_id: string;
  reason: string;
}

function inverseProposal(action: CompiledAction): ProposalInput | Skipped {
  switch (action.type) {
    case "budget_change":
      return { type: "budget_change", target: action.target, from: action.to, to: action.from, currency: action.currency, executor: action.executor };
    case "status_change":
      return { type: "status_change", target: action.target, from: action.to, to: action.from, executor: action.executor };
    case "add_negative_keywords":
      return { type: "remove_negative_keywords", target: action.target, terms: action.terms, executor: action.executor };
    case "remove_negative_keywords":
      return { type: "add_negative_keywords", target: action.target, terms: action.terms, executor: action.executor };
    case "code_patch":
      return { action_id: action.id, reason: "a patch is never deployed by Medjay, so there is nothing to revert here; revert it in your repository" };
    case "register_experiment":
      return { action_id: action.id, reason: "an experiment record is not a platform change; archive it in the tactics log if needed" };
  }
}

const isSkipped = (x: ProposalInput | Skipped): x is Skipped => "reason" in x;

export async function rollbackPlan(deps: PlanDeps, number: number, options: { actor: string }): Promise<{ row: PlanRow; plan: Plan; skipped: Skipped[]; original: Plan }> {
  const old = deps.repo.require(number);
  if (!ROLLBACKABLE.has(old.state)) {
    throw new PlanStateError(`plan #${number} is ${old.state}; only a plan that was struck (exported, executed, partial or verified) can be rolled back`);
  }
  const original = await readPlanFile(deps.dir, old);
  if (original.origin.rollback_of !== undefined) {
    throw new PlanStateError(`plan #${number} is itself a rollback; roll back the plan it undid by compiling a new change, not a rollback of a rollback`);
  }
  const done = new Set(deps.repo.actionResults(number).filter((r) => APPLIED.has(r.status)).map((r) => r.action_id));

  const proposals: ProposalInput[] = [];
  const skipped: Skipped[] = [];
  for (const action of [...original.actions].reverse()) {
    if (!done.has(action.id)) {
      skipped.push({ action_id: action.id, reason: "was never exported, so there is nothing to undo" });
      continue;
    }
    const inverse = inverseProposal(action);
    if (isSkipped(inverse)) skipped.push(inverse);
    else proposals.push(inverse);
  }
  if (proposals.length === 0) throw new PlanStateError(`plan #${number} has nothing that can be rolled back${skipped.length ? `: ${skipped.map((s) => `${s.action_id} ${s.reason}`).join("; ")}` : ""}`);

  const next = await proposePlan(deps, {
    workspace: original.workspace,
    ...(original.client === undefined ? {} : { client: original.client }),
    origin: { job: "rollback", finding_ids: [] },
    proposals,
    rollbackOf: { plan_id: original.plan_id, actions: original.actions },
  });
  await deps.ledger.append({
    actor: options.actor,
    event: "plan.rollback_proposed",
    payload: { from: number, to: next.row.number, from_plan_id: original.plan_id, to_plan_id: next.plan.plan_id, actions: proposals.length, skipped: skipped.map((s) => s.action_id) },
  });
  return { row: next.row, plan: next.plan, skipped, original };
}
