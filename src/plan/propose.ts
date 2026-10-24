import { randomBytes, randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Ledger } from "../audit/ledger.js";
import type { PolicyContext } from "../shield/evaluate.js";
import type { Policy } from "../shield/policy.js";
import { compilePlan, PlanInputError, type CompileInput } from "./compile.js";
import { resolvePublishDrafts, type DraftPort } from "./draft-binding.js";
import { PolicyViolationError } from "./errors.js";
import { writePlanFile } from "./files.js";
import type { PlanRepo, PlanRow } from "./repo.js";
import type { SigningKeys } from "./signing.js";
import type { Plan } from "./types.js";

export interface PlanDeps extends PolicyContext {
  dir: string;
  repo: PlanRepo;
  ledger: Ledger;
  policy: Policy;
  signing?: SigningKeys;
  /** The drafts store, for checking the draft a publish_post action is bound to. */
  drafts?: DraftPort;
  now: () => Date;
  /** Injectable for tests; defaults to cryptographic randomness. */
  random?: { code: () => string; nonce: () => string };
}

export const randomSource = (deps: PlanDeps) =>
  deps.random ?? {
    code: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
    nonce: () => randomBytes(16).toString("hex"),
  };

/** Compile, policy-check and store a plan as proposed. A plan that breaks policy is never stored. */
export async function proposePlan(deps: PlanDeps, input: Omit<CompileInput, "now">): Promise<{ row: PlanRow; plan: Plan }> {
  const { plan } = compilePlan(
    { ...input, now: deps.now() },
    { policy: deps.policy, ...(deps.baselineDailySpend ? { baselineDailySpend: deps.baselineDailySpend } : {}) },
  );
  if (plan.policy_result.status === "fail") throw new PolicyViolationError(plan.policy_result, "cannot propose this plan");

  for (const action of plan.actions) {
    if (action.type !== "code_patch") continue;
    const exists = await stat(join(deps.dir, "plans", action.artifact)).then((s) => s.isFile(), () => false);
    if (!exists) throw new PlanInputError(`patch artifact ${action.artifact} was not found under plans/`);
  }

  if (plan.actions.some((a) => a.type === "publish_post")) {
    const { problems } = await resolvePublishDrafts(plan.actions, deps.drafts);
    if (problems.size > 0) throw new PlanInputError("a post is not ready to publish", [...problems].map(([id, message]) => ({ path: id, message })));
  }

  const existing = deps.repo.byId(plan.plan_id);
  if (existing) throw new PlanInputError(`this exact plan was already proposed as #${existing.number}`);

  const file = await writePlanFile(deps.dir, plan);
  const row = deps.repo.insert(plan, file, deps.now());
  await deps.ledger.append({
    actor: "system",
    event: "plan.proposed",
    payload: {
      number: row.number,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      actions: plan.actions.length,
      two_step_required: plan.policy_result.two_step_required,
      origin: plan.origin,
    },
  });
  return { row, plan };
}
