// The Tested-Tactics Log (SPEC section 15). Each tactic is a Markdown file under tactics/ whose
// frontmatter holds its state. The schema itself enforces the honesty rules: a tactic cannot be
// "validated" or "invalidated" without the result that earned it, "hypothesized" needs a complete
// pre-registered experiment, and "unverified" carries neither. A pack therefore cannot ship a
// validated tactic without attached data.
import { z } from "zod";

export const FUNNEL_STAGES = ["awareness", "consideration", "conversion", "retention"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const TACTIC_STATES = ["unverified", "hypothesized", "validated", "invalidated", "retired"] as const;
export type TacticState = (typeof TACTIC_STATES)[number];

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/, "letters, digits, dash or underscore");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Range = z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD..YYYY-MM-DD");
const Tag = z.array(z.string().min(1).max(40)).default([]);

export const SourceSchema = z.object({ kind: z.enum(["vendor", "practitioner", "own_test"]), ref: z.string().min(1).max(300), date: Day }).strict();

export const DesignSchema = z
  .object({
    type: z.enum(["before_after", "holdout", "ab"]),
    min_sample: z.number().int().positive(),
    duration_days: z.number().int().positive(),
    /** The smallest relative effect worth acting on, e.g. 0.15 for +15%. */
    min_effect: z.number().positive(),
  })
  .strict();

export const ExperimentSchema = z
  .object({
    id: Id,
    hypothesis: z.string().min(1).max(500),
    metric: z.string().min(1).max(100),
    baseline: z.object({ value: z.number().finite(), range: Range, snapshot_id: Id }).strict(),
    design: DesignSchema,
    /** Readings taken before the test was conclusive (underpowered or in the grey zone). Never promoted. */
    interim: z.array(z.lazy(() => ResultSchema)).default([]),
  })
  .strict();

export const ResultSchema = z
  .object({
    /** Probability, under the declared method, that the true effect is at least the design's min_effect. */
    confidence: z.number().min(0).max(1),
    method: z.enum(["bayesian", "frequentist"]),
    sample_size: z.number().int().positive(),
    date_range: Range,
    /** Observed relative effect, e.g. 0.31 for +31%. */
    effect: z.number().finite(),
    outcome_source: z.enum(["crm", "ga4", "platform_proxy"]),
    /** `proxy` when only platform-reported data was available. */
    grading: z.enum(["outcome", "proxy"]),
    caveats: z.array(z.string().min(1).max(200)).default([]),
  })
  .strict();

/** What a tactic validated in ANOTHER workspace showed, in bands. A prior suggests; it never validates. */
export const PriorSchema = z
  .object({
    global_id: z.string().regex(/^GT-[0-9a-f]{12}$/),
    effect_band: z.string().min(1).max(40),
    confidence_band: z.string().min(1).max(40),
    sample_band: z.string().min(1).max(40),
    method: z.enum(["bayesian", "frequentist"]),
    outcome_source: z.enum(["crm", "ga4", "platform_proxy"]),
    grading: z.enum(["outcome", "proxy"]),
    period: z.string().regex(/^\d{4}-Q[1-4]$/),
    metric: z.string().min(1).max(80),
  })
  .strict();
export type Prior = z.infer<typeof PriorSchema>;

export const TacticSchema = z
  .object({
    id: Id,
    title: z.string().min(1).max(200),
    pillars: z.array(z.number().int().min(1).max(11)).default([]),
    jobs: z.array(z.string().min(1).max(40)).default([]),
    /** Finding kinds from `mdj diagnose` this tactic is a response to (for example bleeding_adset). */
    matches: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    funnel_stage: z.enum(FUNNEL_STAGES).optional(),
    prior: PriorSchema.optional(),
    source: SourceSchema,
    state: z.enum(TACTIC_STATES),
    evidence_scope: z.enum(["workspace", "vault_prior"]).default("workspace"),
    experiment: ExperimentSchema.optional(),
    result: ResultSchema.optional(),
    tags: z.object({ markets: Tag, verticals: Tag, seasons: Tag, languages: Tag }).strict().prefault({}),
    retired: z.object({ reason: z.string().min(1).max(300), date: Day }).strict().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    switch (t.state) {
      case "unverified":
        need(t.experiment === undefined, "experiment", "an unverified tactic has no experiment yet");
        need(t.result === undefined, "result", "an unverified tactic has no result");
        break;
      case "hypothesized":
        need(t.experiment !== undefined, "experiment", "a hypothesized tactic needs a pre-registered experiment (id, metric, baseline, design)");
        need(t.result === undefined, "result", "a hypothesized tactic has no final result yet");
        break;
      case "validated":
      case "invalidated":
        need(t.experiment !== undefined, "experiment", `a ${t.state} tactic must keep the experiment that tested it`);
        need(t.result !== undefined, "result", `a ${t.state} tactic must carry its result; no tactic is ${t.state} without data`);
        break;
      case "retired":
        need(t.result !== undefined, "result", "only a validated tactic can be retired, so its result stays attached");
        need(t.retired !== undefined, "retired", "a retired tactic records why and when");
        break;
    }
    if (t.evidence_scope === "vault_prior") {
      need(t.prior !== undefined, "prior", "a vault_prior tactic must carry its prior (the bands it was promoted with)");
      need(t.state === "unverified", "state", "a tactic pulled from the vault stays unverified until it is tested in this workspace");
    }
    if (t.state !== "retired") need(t.retired === undefined, "retired", "only a retired tactic has retirement details");
  });

export type Tactic = z.infer<typeof TacticSchema>;
export type Experiment = z.infer<typeof ExperimentSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type ExperimentInput = z.input<typeof ExperimentSchema>;
export type ResultInput = z.input<typeof ResultSchema>;
