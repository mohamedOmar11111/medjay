// Strike: executes an approved plan, and only an approved plan. Before touching anything it proves
// (1) the plan file is exactly what was approved, (2) a valid signed approval exists for that
// hash, (3) the plan has not expired, and (4) the CURRENT policy still passes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureNotExpired, recheckPolicy } from "./approve.js";
import { exportPlan, type ActionOutcome } from "./export.js";
import { PlanStateError, SignatureError } from "./errors.js";
import { readPlanFile } from "./files.js";
import type { PlanDeps } from "./propose.js";
import type { PlanState } from "./repo.js";
import { approvalRecord, verifyApproval } from "./signing.js";

const STRIKABLE: readonly PlanState[] = ["approved", "partial", "failed"];
const SUCCESS = new Set(["exported", "recorded"]);

export interface StrikeResult {
  state: PlanState;
  results: ActionOutcome[];
  exportDir: string;
}

export async function strikePlan(deps: PlanDeps, number: number, options: { actor: string }): Promise<StrikeResult> {
  if (!deps.signing) throw new Error("striking needs the signing key to verify approvals");
  const row = deps.repo.require(number);
  if (!STRIKABLE.includes(row.state)) {
    throw new PlanStateError(
      row.state === "proposed" || row.state === "held"
        ? `plan #${number} is ${row.state}: it has not been approved`
        : `plan #${number} is ${row.state}; it cannot be struck again`,
    );
  }
  await ensureNotExpired(deps, row);

  const plan = await readPlanFile(deps.dir, row);

  const valid = deps.repo
    .approvals(number)
    .filter((a) => a.plan_hash === plan.plan_hash)
    .some((a) =>
      verifyApproval(
        deps.signing!.publicKeyPem,
        approvalRecord({ plan_id: plan.plan_id, plan_hash: a.plan_hash, approver: a.approver, channel: a.channel, ts: a.ts, nonce: a.nonce }),
        a.signature,
      ),
    );
  if (!valid) throw new SignatureError(`plan #${number} has no valid signed approval for hash ${plan.plan_hash.slice(0, 12)}; refusing to strike`);

  recheckPolicy(deps, plan, `cannot strike plan #${number}`);

  const previous = new Map(deps.repo.actionResults(number).map((r) => [r.action_id, r]));
  const pending = new Set(plan.actions.filter((a) => !SUCCESS.has(previous.get(a.id)?.status ?? "")).map((a) => a.id));

  deps.repo.transition(number, "executing", deps.now());
  await deps.ledger.append({
    actor: options.actor,
    event: "plan.strike_started",
    payload: { number, plan_id: plan.plan_id, plan_hash: plan.plan_hash, pending: [...pending] },
  });

  let run;
  try {
    run = await exportPlan({ dir: deps.dir, plan, pending, now: deps.now() });
  } catch (error) {
    deps.repo.transition(number, "failed", deps.now());
    await deps.ledger.append({ actor: options.actor, event: "plan.failed", payload: { number, plan_id: plan.plan_id, error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }

  for (const outcome of run.outcomes) {
    deps.repo.setActionResult(number, outcome.action_id, outcome.status, outcome.detail, outcome.artifact, deps.now());
  }
  const results: ActionOutcome[] = plan.actions.map((a) => {
    const fresh = run.outcomes.find((o) => o.action_id === a.id);
    if (fresh) return fresh;
    const old = previous.get(a.id);
    return { action_id: a.id, status: (old?.status ?? "exported") as ActionOutcome["status"], ...(old?.detail ? { detail: old.detail } : {}), ...(old?.artifact ? { artifact: old.artifact } : {}) };
  });

  const succeeded = results.filter((r) => SUCCESS.has(r.status)).length;
  const state: PlanState = succeeded === results.length ? "exported" : succeeded === 0 ? "failed" : "partial";
  deps.repo.transition(number, state, deps.now());

  const csv = await readFile(join(run.exportDir, "manifest.json")).catch(() => undefined);
  await deps.ledger.append({
    actor: options.actor,
    event: state === "exported" ? "plan.exported" : state === "partial" ? "plan.partial" : "plan.failed",
    payload: {
      number,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      results: results.map((r) => ({ action_id: r.action_id, status: r.status })),
      artifacts: run.artifacts,
      ...(csv ? { manifest_sha256: createHash("sha256").update(csv).digest("hex") } : {}),
    },
  });
  return { state, results, exportDir: run.exportDir };
}
