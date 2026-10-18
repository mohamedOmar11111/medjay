// Verify: after a person has imported an export, compare what the platform now shows with what the
// plan said it should show. A plan becomes `verified` only when every machine-checkable action matches.
// Nothing is assumed: an action with no matching observation is "not observed", never a pass.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonPretty } from "../audit/canonical.js";
import { PlanStateError } from "./errors.js";
import { readPlanFile } from "./files.js";
import type { Observation } from "./observed.js";
import type { PlanDeps } from "./propose.js";
import type { PlanRow } from "./repo.js";
import type { CompiledAction, Plan } from "./types.js";

export type VerifyStatus = "verified" | "mismatch" | "not_observed" | "manual";

export interface ActionVerification {
  action_id: string;
  type: string;
  status: VerifyStatus;
  expected?: unknown;
  observed?: unknown;
  detail?: string;
}

export interface VerificationReport {
  plan_id: string;
  plan_hash: string;
  all_verified: boolean;
  results: ActionVerification[];
}

const VERIFIABLE: ReadonlySet<string> = new Set(["exported", "executed", "verified"]);
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const key = (term: { text: string; match: string }) => `${term.match}\u0001${term.text.toLowerCase()}`;

const entityOf = (a: { target: { platform: string; kind: string; id: string } }) => `${a.target.platform}:${a.target.kind}/${a.target.id}`;

/** Observations about one target: matched by entity id, or by name where the source only knows names. */
function about(a: Extract<CompiledAction, { target: unknown }>, observations: Observation[], field: Observation["field"]): Observation[] {
  const entity = entityOf(a);
  return observations.filter((o) => o.field === field && (o.entity === entity || (o.name !== undefined && a.target.name !== undefined && o.name === a.target.name)));
}

const asStatus = (v: unknown) => String(v).trim().toUpperCase().replace(/^ACTIVE$/, "ENABLED");

function verifyAction(action: CompiledAction, observations: Observation[]): ActionVerification {
  const base = { action_id: action.id, type: action.type };
  switch (action.type) {
    case "budget_change": {
      const hits = about(action, observations, "daily_budget");
      if (hits.length === 0) return { ...base, status: "not_observed", expected: action.to, detail: "no observation of this budget" };
      const bad = hits.find((h) => typeof h.value !== "number" || !same(h.value, action.to) || (h.currency !== undefined && h.currency !== action.currency));
      return bad
        ? { ...base, status: "mismatch", expected: action.to, observed: bad.value, detail: bad.currency !== undefined && bad.currency !== action.currency ? `currency ${bad.currency}, expected ${action.currency}` : `daily budget is ${String(bad.value)}, expected ${action.to}` }
        : { ...base, status: "verified", expected: action.to, observed: action.to };
    }
    case "status_change": {
      const hits = about(action, observations, "status");
      if (hits.length === 0) return { ...base, status: "not_observed", expected: action.to, detail: "no observation of this status" };
      const bad = hits.find((h) => asStatus(h.value) !== action.to);
      return bad ? { ...base, status: "mismatch", expected: action.to, observed: bad.value, detail: `status is ${String(bad.value)}, expected ${action.to}` } : { ...base, status: "verified", expected: action.to, observed: action.to };
    }
    case "add_negative_keywords":
    case "remove_negative_keywords": {
      const adding = action.type === "add_negative_keywords";
      const hits = about(action, observations, "negative_keywords");
      if (hits.length === 0) return { ...base, status: "not_observed", detail: "no observation of this campaign's negative keywords" };
      const present = new Set(hits.flatMap((h) => (Array.isArray(h.value) ? h.value.map(key) : [])));
      const wrong = action.terms.filter((t) => present.has(key(t)) !== adding);
      return wrong.length === 0
        ? { ...base, status: "verified" }
        : { ...base, status: "mismatch", detail: `${adding ? "missing" : "still present"}: ${wrong.map((t) => `${t.text} [${t.match.toLowerCase()}]`).join(", ")}` };
    }
    case "code_patch":
      return { ...base, status: "manual", detail: "a patch is reviewed and deployed by a person; Medjay cannot observe it" };
    case "register_experiment":
      return { ...base, status: "manual", detail: "a record, not a platform change" };
  }
}

/** Pure comparison, so it can be reasoned about and tested without a database. */
export function compareObserved(plan: Plan, observations: Observation[]): VerificationReport {
  const results = plan.actions.map((a) => verifyAction(a, observations));
  return { plan_id: plan.plan_id, plan_hash: plan.plan_hash, all_verified: results.every((r) => r.status === "verified" || r.status === "manual"), results };
}

export async function verifyPlan(
  deps: PlanDeps,
  number: number,
  observations: Observation[],
  options: { actor: string; observedSha256?: string },
): Promise<{ row: PlanRow; report: VerificationReport }> {
  const row = deps.repo.require(number);
  if (!VERIFIABLE.has(row.state)) throw new PlanStateError(`plan #${number} is ${row.state}; only a plan that was struck (exported or executed) can be verified`);
  const plan = await readPlanFile(deps.dir, row);
  const report = compareObserved(plan, observations);

  const exportDir = join(deps.dir, "exports", plan.plan_id);
  await mkdir(exportDir, { recursive: true });
  await writeFile(join(exportDir, "verification.json"), `${canonicalJsonPretty({ verified_at: deps.now().toISOString(), observed_sha256: options.observedSha256 ?? null, ...report })}\n`, "utf8");

  const updated = report.all_verified && row.state !== "verified" ? deps.repo.transition(number, "verified", deps.now()) : row;
  await deps.ledger.append({
    actor: options.actor,
    event: report.all_verified ? "plan.verified" : "plan.verify_failed",
    payload: {
      number,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      results: report.results.map((r) => ({ action_id: r.action_id, status: r.status })),
      ...(options.observedSha256 ? { observed_sha256: options.observedSha256 } : {}),
    },
  });
  return { row: updated, report };
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
