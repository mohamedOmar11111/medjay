// Approving, holding and rejecting plans. An approval is a signed record bound to the plan hash,
// made only after the plan file is proven unedited and the CURRENT policy still passes.
import { checkPolicy } from "../shield/evaluate.js";
import { policyActions } from "./compile.js";
import { ExpiredError, PlanStateError, PolicyViolationError } from "./errors.js";
import { planFile, readPlanFile, writePlanFile } from "./files.js";
import { randomSource, type PlanDeps } from "./propose.js";
import type { PlanRow } from "./repo.js";
import { approvalRecord, signApproval } from "./signing.js";
import type { Plan } from "./types.js";

export interface ApproveOptions {
  approver: string;
  channel: string;
  confirmationCode?: string;
  nonce?: string;
}

export type ApproveResult =
  | { status: "approved"; row: PlanRow }
  | { status: "confirmation_required"; code: string; expiresAt: string };

/** Mark a plan expired if its time is up, and say so. Returns normally only for a live plan. */
export async function ensureNotExpired(deps: PlanDeps, row: PlanRow): Promise<void> {
  if (row.expires_at > deps.now().toISOString()) return;
  try {
    deps.repo.transition(row.number, "expired", deps.now());
    await deps.ledger.append({ actor: "system", event: "plan.expired", payload: { number: row.number, plan_id: row.plan_id } });
  } catch {
    // already in a state that cannot expire (for example executed); the expiry error below still applies
  }
  throw new ExpiredError(row.number, row.expires_at);
}

export function recheckPolicy(deps: PlanDeps, plan: Plan, context: string) {
  const result = checkPolicy(
    deps.policy,
    { ...(plan.client === undefined ? {} : { client: plan.client }), actions: policyActions(plan.actions) },
    deps.baselineDailySpend ? { baselineDailySpend: deps.baselineDailySpend } : {},
  );
  if (result.status === "fail") throw new PolicyViolationError(result, context);
  return result;
}

export async function approvePlan(deps: PlanDeps, number: number, options: ApproveOptions): Promise<ApproveResult> {
  if (!deps.signing) throw new Error("approving needs a signing key");
  const row = deps.repo.require(number);
  if (row.state !== "proposed" && row.state !== "held") {
    throw new PlanStateError(`plan #${number} is ${row.state}; only a proposed or held plan can be approved`);
  }
  await ensureNotExpired(deps, row);
  const plan = await readPlanFile(deps.dir, row);
  const policy = recheckPolicy(deps, plan, `cannot approve plan #${number} (policy changed since it was proposed; compile a new plan)`);

  if (policy.two_step_required) {
    if (options.confirmationCode === undefined) {
      const code = randomSource(deps).code();
      const { expiresAt } = deps.repo.setConfirmation(number, plan.plan_hash, code, deps.now());
      await deps.ledger.append({ actor: options.approver, event: "plan.confirmation_requested", payload: { number, plan_id: plan.plan_id, plan_hash: plan.plan_hash, expires_at: expiresAt } });
      return { status: "confirmation_required", code, expiresAt };
    }
    deps.repo.takeConfirmation(number, plan.plan_hash, options.confirmationCode, deps.now());
  }

  const ts = deps.now().toISOString();
  const nonce = options.nonce ?? randomSource(deps).nonce();
  const signature = signApproval(
    deps.signing.privateKeyPem,
    approvalRecord({ plan_id: plan.plan_id, plan_hash: plan.plan_hash, approver: options.approver, channel: options.channel, ts, nonce }),
  );
  deps.repo.addApproval({ plan_number: number, plan_hash: plan.plan_hash, approver: options.approver, channel: options.channel, ts, nonce, signature });
  const updated = deps.repo.transition(number, "approved", deps.now());

  // the file's approvals list is informational; the hash excludes it, and strike trusts the database + signature
  await writePlanFile(deps.dir, { ...plan, approvals: [...plan.approvals, { approver: options.approver, channel: options.channel, ts, nonce, plan_hash: plan.plan_hash, signature }] });
  await deps.ledger.append({
    actor: options.approver,
    event: "plan.approved",
    payload: { number, plan_id: plan.plan_id, plan_hash: plan.plan_hash, channel: options.channel, two_step: policy.two_step_required, file: planFile(plan.plan_id) },
  });
  return { status: "approved", row: updated };
}

export async function holdPlan(deps: PlanDeps, number: number, options: { actor: string }): Promise<PlanRow> {
  const row = deps.repo.transition(number, "held", deps.now());
  await deps.ledger.append({ actor: options.actor, event: "plan.held", payload: { number, plan_id: row.plan_id, plan_hash: row.plan_hash } });
  return row;
}

export async function rejectPlan(deps: PlanDeps, number: number, options: { actor: string; reason?: string }): Promise<PlanRow> {
  const row = deps.repo.transition(number, "rejected", deps.now());
  await deps.ledger.append({
    actor: options.actor,
    event: "plan.rejected",
    payload: { number, plan_id: row.plan_id, plan_hash: row.plan_hash, ...(options.reason ? { reason: options.reason } : {}) },
  });
  return row;
}
