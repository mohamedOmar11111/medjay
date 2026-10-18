// Plan schema. Proposals (what an agent or a human asks for) are validated here; the compiler
// turns them into compiled actions with ids, executors and inverses. Plan files read from disk
// are validated against PlanSchema too, so a hand-edited file cannot smuggle in unknown fields.
import { z } from "zod";
import { isIsoCurrency } from "../constants.js";

const slug = /^[a-z][a-z0-9_]*$/;

export const TargetSchema = z
  .object({
    platform: z.string().regex(slug),
    kind: z.string().regex(slug),
    id: z.string().regex(/^[A-Za-z0-9_.:-]+$/),
    name: z.string().min(1).max(200).optional(),
    /** The campaign an ad group belongs to (Google Ads Editor identifies an ad group by campaign and name). */
    parent_name: z.string().min(1).max(200).optional(),
  })
  .strict();
export type Target = z.infer<typeof TargetSchema>;

const Currency = z.string().refine(isIsoCurrency, "not a known ISO 4217 currency code");
const Budget = z.number().finite().min(0);
const Executor = z.enum(["export", "mcp"]);
const Status = z.enum(["ENABLED", "PAUSED"]);
const Match = z.enum(["BROAD", "PHRASE", "EXACT"]);

/** Keyword text that is safe to write into a spreadsheet: no formula starters, no control characters. */
const KeywordText = z
  .string()
  .min(1)
  .max(80)
  .refine((text) => !/^[=+\-@\t\r]/.test(text), "must not start with = + - @ or a tab (spreadsheet formula risk)")
  .refine((text) => !/[\u0000-\u001f\u007f]/.test(text), "must not contain control characters");
const Term = z.object({ text: KeywordText, match: Match }).strict();
export type Term = z.infer<typeof Term>;

const budgetShape = { target: TargetSchema, from: Budget, to: Budget, currency: Currency, executor: Executor.default("export") };
const statusShape = { target: TargetSchema, from: Status, to: Status, executor: Executor.default("export") };
const negativesShape = { target: TargetSchema, terms: z.array(Term).min(1).max(500), executor: Executor.default("export") };
const patchShape = { artifact: z.string().regex(/^patches\/[A-Za-z0-9_.-]+\.diff$/, "must be patches/<name>.diff inside the plans folder") };
const experimentShape = {
  experiment_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  tactic_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  hypothesis: z.string().min(1),
  metric: z.string().min(1),
};

export const ProposalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("budget_change"), ...budgetShape }).strict().refine((a) => a.from !== a.to, "from and to are the same (no change)"),
  z.object({ type: z.literal("status_change"), ...statusShape }).strict().refine((a) => a.from !== a.to, "from and to are the same (no change)"),
  z.object({ type: z.literal("add_negative_keywords"), ...negativesShape }).strict(),
  z.object({ type: z.literal("remove_negative_keywords"), ...negativesShape }).strict(),
  z.object({ type: z.literal("code_patch"), ...patchShape }).strict(),
  z.object({ type: z.literal("register_experiment"), ...experimentShape }).strict(),
]);
export type ProposalInput = z.input<typeof ProposalSchema>;
export type Proposal = z.output<typeof ProposalSchema>;

const base = { id: z.string().regex(/^a\d+$/), irreversible: z.boolean() };

const CompiledActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("budget_change"), ...base, ...budgetShape, restores: z.literal(true).optional(), inverse: z.object({ type: z.literal("budget_change"), to: Budget }).strict() }).strict(),
  z.object({ type: z.literal("status_change"), ...base, ...statusShape, inverse: z.object({ type: z.literal("status_change"), to: Status }).strict() }).strict(),
  z.object({
    type: z.literal("add_negative_keywords"),
    ...base,
    ...negativesShape,
    inverse: z.object({ type: z.literal("remove_negative_keywords"), terms: z.array(Term) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("remove_negative_keywords"),
    ...base,
    ...negativesShape,
    inverse: z.object({ type: z.literal("add_negative_keywords"), terms: z.array(Term) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("code_patch"),
    ...base,
    ...patchShape,
    executor: z.literal("patch"),
    deploy: z.literal("never_automatic"),
    inverse: z.object({ type: z.literal("revert_patch") }).strict(),
  }).strict(),
  z.object({
    type: z.literal("register_experiment"),
    ...base,
    ...experimentShape,
    executor: z.literal("record"),
    inverse: z.object({ type: z.literal("archive_experiment") }).strict(),
  }).strict(),
]);
export type CompiledAction = z.infer<typeof CompiledActionSchema>;

const PolicyCheckSchema = z
  .object({
    rule: z.string(),
    ok: z.boolean().nullable(),
    action_id: z.string().optional(),
    limit: z.number().optional(),
    actual: z.number().optional(),
    note: z.string().optional(),
  })
  .strict();

const PolicyResultSchema = z
  .object({
    status: z.enum(["pass", "fail"]),
    checks: z.array(PolicyCheckSchema),
    two_step_required: z.boolean(),
    daily_delta: z.object({ gross: z.number(), net: z.number() }).strict(),
  })
  .strict();

export const ApprovalSchema = z
  .object({
    approver: z.string().min(1),
    channel: z.string().min(1),
    ts: z.iso.datetime(),
    nonce: z.string().min(1),
    plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().min(1),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

const OriginSchema = z
  .object({
    job: z.string().min(1),
    finding_ids: z.array(z.string()).default([]),
    tactic_id: z.string().optional(),
    experiment_id: z.string().optional(),
    /** Set only by `mdj rollback`: the plan this one undoes. */
    rollback_of: z.string().regex(/^pl_[0-9a-f]{12}$/).optional(),
  })
  .strict();
export type Origin = z.input<typeof OriginSchema>;

const SimulationSchema = z
  .object({ id: z.string(), seed: z.number().int(), p10: z.number(), p50: z.number(), p90: z.number(), p_positive: z.number().min(0).max(1) })
  .strict();

export const PlanSchema = z
  .object({
    plan_version: z.literal(1),
    plan_id: z.string().regex(/^pl_[0-9a-f]{12}$/),
    workspace: z.string().min(1),
    client: z.string().min(1).optional(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    origin: OriginSchema,
    preconditions: z.array(
      z.object({ entity: z.string(), field: z.string(), expect: z.union([z.number(), z.string()]), currency: z.string().optional() }).strict(),
    ),
    actions: z.array(CompiledActionSchema).min(1),
    simulation: SimulationSchema.optional(),
    impact_estimate: z
      .object({ daily_spend_delta: z.object({ gross: z.number(), net: z.number(), currency: z.string().nullable() }).strict(), basis: z.string() })
      .strict(),
    policy_result: PolicyResultSchema,
    plan_hash: z.string().regex(/^[0-9a-f]{64}$/),
    approvals: z.array(ApprovalSchema),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;
export type PlanBody = Omit<Plan, "plan_hash" | "approvals">;
export type SimulationRef = z.infer<typeof SimulationSchema>;
export { OriginSchema, SimulationSchema };
