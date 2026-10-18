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
    return proposal.type === "add_negative_keywords" ? { ...proposal, terms: dedupeTerms(proposal.terms) } : proposal;
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
    return a.type === "budget_change" ? { ...base, from: a.from, to: a.to, currency: a.currency } : base;
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
  const actions = proposals.map(toAction);

  const created_at = input.now.toISOString();
  const expires_at = new Date(input.now.getTime() + (input.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 3_600_000).toISOString();
  const plan_id = `pl_${sha256(canonicalJson({ workspace: input.workspace, client: input.client ?? null, origin: origin.data, proposals, simulation: simulation ?? null, created_at })).slice(0, 12)}`;

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
    origin: origin.data,
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
