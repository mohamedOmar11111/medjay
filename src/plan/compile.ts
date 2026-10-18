// The plan compiler is deterministic code, not an LLM. Identical inputs (including the clock the
// caller passes in) give a byte-identical plan file, so a plan can be reviewed, approved by hash,
// and re-derived. An agent proposes; this function decides what the actions are.
import { createHash } from "node:crypto";
import { canonicalJson, canonicalJsonPretty } from "../audit/canonical.js";
import { checkPolicy, type PolicyAction, type PolicyContext } from "../shield/evaluate.js";
import type { Policy } from "../shield/policy.js";
import {
  OriginSchema,
  ProposalSchema,
  SimulationSchema,
  type CompiledAction,
  type Origin,
  type Plan,
  type PlanBody,
  type Proposal,
  type ProposalInput,
  type SimulationRef,
  type Term,
} from "./types.js";

export class PlanInputError extends Error {
  constructor(
    summary: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(issues.length === 0 ? summary : `${summary}\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "PlanInputError";
  }
}

export interface CompileInput {
  workspace: string;
  client?: string;
  origin: Origin;
  proposals: ProposalInput[];
  simulation?: SimulationRef;
  /** Only a rollback sets this: the plan being undone. Every action must then be an exact inverse of one of its actions. */
  rollbackOf?: { plan_id: string; actions: CompiledAction[] };
  now: Date;
  expiresInHours?: number;
}

export interface CompileContext extends PolicyContext {
  policy: Policy;
}

const DEFAULT_EXPIRY_HOURS = 48;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function dedupeTerms(terms: Term[]): Term[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = `${term.match}\0${term.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validate(proposals: ProposalInput[]): Proposal[] {
  if (proposals.length === 0) throw new PlanInputError("a plan needs at least one action");
  return proposals.map((raw, index) => {
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PlanInputError(
        `proposal ${index + 1} is invalid`,
        parsed.error.issues.map((i) => ({ path: [`proposals[${index}]`, ...i.path.map(String)].join("."), message: i.message })),
      );
    }
    const proposal = parsed.data;
    return proposal.type === "add_negative_keywords" || proposal.type === "remove_negative_keywords" ? { ...proposal, terms: dedupeTerms(proposal.terms) } : proposal;
  });
}

const sameTarget = (a: { target: { platform: string; kind: string; id: string } }, b: { target: { platform: string; kind: string; id: string } }) =>
  a.target.platform === b.target.platform && a.target.kind === b.target.kind && a.target.id === b.target.id;
const termKey = (t: Term) => `${t.match}\u0000${t.text.toLowerCase()}`;

/** Is `action` exactly the undo of `original`? */
function inverts(action: CompiledAction, original: CompiledAction): boolean {
  if (action.type === "budget_change" && original.type === "budget_change") return sameTarget(action, original) && action.currency === original.currency && action.from === original.to && action.to === original.from;
  if (action.type === "status_change" && original.type === "status_change") return sameTarget(action, original) && action.from === original.to && action.to === original.from;
  const pair = (action.type === "remove_negative_keywords" && original.type === "add_negative_keywords") || (action.type === "add_negative_keywords" && original.type === "remove_negative_keywords");
  if (pair && "terms" in action && "terms" in original) {
    const had = new Set(original.terms.map(termKey));
    return sameTarget(action, original) && action.terms.every((t) => had.has(termKey(t)));
  }
  return false;
}

/** A rollback may only undo what the original plan did; budget increases that restore a budget are tagged so policy treats them as a restoration. */
function asRollback(actions: CompiledAction[], original: CompiledAction[]): CompiledAction[] {
  return actions.map((action) => {
    if (!original.some((o) => inverts(action, o))) {
      throw new PlanInputError(`action ${action.id} (${action.type}) is not the exact inverse of any action in the plan being rolled back`);
    }
    return action.type === "budget_change" ? { ...action, restores: true } : action;
  });
}

function toAction(proposal: Proposal, index: number): CompiledAction {
  const id = `a${index + 1}`;
  switch (proposal.type) {
    case "budget_change":
      return { ...proposal, id, irreversible: false, inverse: { type: "budget_change", to: proposal.from } };
    case "status_change":
      return { ...proposal, id, irreversible: false, inverse: { type: "status_change", to: proposal.from } };
    case "add_negative_keywords":
      return { ...proposal, id, irreversible: false, inverse: { type: "remove_negative_keywords", terms: proposal.terms } };
    case "remove_negative_keywords":
      return { ...proposal, id, irreversible: false, inverse: { type: "add_negative_keywords", terms: proposal.terms } };
    case "code_patch":
      return { ...proposal, id, irreversible: false, executor: "patch", deploy: "never_automatic", inverse: { type: "revert_patch" } };
    case "register_experiment":
      return { ...proposal, id, irreversible: false, executor: "record", inverse: { type: "archive_experiment" } };
  }
}

export function policyActions(actions: CompiledAction[]): PolicyAction[] {
  return actions.map((a) => {
    const target = "target" in a ? { platform: a.target.platform, kind: a.target.kind, id: a.target.id } : { platform: "workspace", kind: a.type, id: a.id };
    const base: PolicyAction = { id: a.id, type: a.type, target, irreversible: a.irreversible };
    return a.type === "budget_change" ? { ...base, from: a.from, to: a.to, currency: a.currency, ...(a.restores ? { restores: true } : {}) } : base;
  });
}

const entityOf = (a: { target: { platform: string; kind: string; id: string } }) => `${a.target.platform}:${a.target.kind}/${a.target.id}`;

function preconditionsOf(actions: CompiledAction[]): PlanBody["preconditions"] {
  return actions.flatMap((a): PlanBody["preconditions"] => {
    if (a.type === "budget_change") return [{ entity: entityOf(a), field: "daily_budget", expect: a.from, currency: a.currency }];
    if (a.type === "status_change") return [{ entity: entityOf(a), field: "status", expect: a.from }];
    return [];
  });
}

/** SHA-256 over everything except the hash itself and the approvals, which change after review. */
export function computePlanHash(plan: Omit<Plan, "plan_hash" | "approvals"> | Plan): string {
  const { plan_hash: _hash, approvals: _approvals, ...body } = plan as Plan;
  return sha256(canonicalJson(body));
}

export function verifyPlanHash(plan: Plan): boolean {
  return computePlanHash(plan) === plan.plan_hash;
}

export function serializePlan(plan: Plan): string {
  return `${canonicalJsonPretty(plan)}\n`;
}

export function compilePlan(input: CompileInput, context: CompileContext): { plan: Plan } {
  const origin = OriginSchema.safeParse(input.origin);
  if (!origin.success) {
    throw new PlanInputError("origin is invalid", origin.error.issues.map((i) => ({ path: `origin.${i.path.join(".")}`, message: i.message })));
  }
  const simulation = input.simulation === undefined ? undefined : SimulationSchema.parse(input.simulation);
  const proposals = validate(input.proposals);
  if (origin.data.rollback_of !== undefined && input.rollbackOf === undefined) {
    throw new PlanInputError("origin.rollback_of is set by `mdj rollback` only; a proposals file cannot claim to be a rollback");
  }
  const built = proposals.map(toAction);
  const actions = input.rollbackOf ? asRollback(built, input.rollbackOf.actions) : built;
  const originFinal = input.rollbackOf ? { ...origin.data, rollback_of: input.rollbackOf.plan_id } : origin.data;

  const created_at = input.now.toISOString();
  const expires_at = new Date(input.now.getTime() + (input.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 3_600_000).toISOString();
  const plan_id = `pl_${sha256(canonicalJson({ workspace: input.workspace, client: input.client ?? null, origin: originFinal, proposals, simulation: simulation ?? null, created_at })).slice(0, 12)}`;

  const policy_result = checkPolicy(
    context.policy,
    { ...(input.client === undefined ? {} : { client: input.client }), actions: policyActions(actions), simulation: simulation },
    { stage: "propose", ...(context.baselineDailySpend ? { baselineDailySpend: context.baselineDailySpend } : {}) },
  );
  const currencies = new Set(actions.flatMap((a) => (a.type === "budget_change" ? [a.currency] : [])));

  const body: PlanBody = {
    plan_version: 1,
    plan_id,
    workspace: input.workspace,
    ...(input.client === undefined ? {} : { client: input.client }),
    created_at,
    expires_at,
    origin: originFinal,
    preconditions: preconditionsOf(actions),
    actions,
    ...(simulation === undefined ? {} : { simulation }),
    impact_estimate: {
      daily_spend_delta: { ...policy_result.daily_delta, currency: currencies.size === 1 ? ([...currencies][0] as string) : null },
      basis: "sum of budget_change actions (gross = total absolute change, net = signed total)",
    },
    policy_result,
  };
  return { plan: { ...body, plan_hash: computePlanHash(body), approvals: [] } };
}
