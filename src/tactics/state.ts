// The tactic state machine, as pure functions: each returns a NEW tactic (or says why it cannot).
//   unverified -> hypothesized   needs a complete pre-registered experiment
//   hypothesized -> validated | invalidated   only when the test was big and long enough AND the
//                    confidence is decisive; underpowered or grey-zone readings are kept as interim
//                    and the tactic stays hypothesized (it is never promoted on a hunch)
//   validated -> retired         on contradicting evidence or a shelf life; the result stays attached
// An invalidated tactic stays in the log so a bad idea is not proposed again.
import { ExperimentSchema, ResultSchema, TacticSchema, type ExperimentInput, type Result, type ResultInput, type Tactic } from "./schema.js";

export class TacticError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(issues.length === 0 ? message : `${message}\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "TacticError";
  }
}

/** Confidence at or above this validates; at or below its complement invalidates; in between is inconclusive. */
export const DECISIVE_CONFIDENCE = 0.9;

const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }) => error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

const validDays = (range: string): number => {
  const [a, b] = range.split("..") as [string, string];
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new TacticError(`date_range "${range}" is not a valid range (start must not be after end)`);
  return Math.round((end - start) / 86_400_000) + 1;
};

export function hypothesize(tactic: Tactic, experiment: ExperimentInput): Tactic {
  if (tactic.state !== "unverified") throw new TacticError(`${tactic.id} is ${tactic.state}; only an unverified tactic can become hypothesized`);
  const parsed = ExperimentSchema.safeParse(experiment);
  if (!parsed.success) throw new TacticError(`the experiment for ${tactic.id} is incomplete`, issuesOf(parsed.error));
  validDays(parsed.data.baseline.range);
  // once it has its own pre-registered test it is a workspace tactic; the prior it came with stays as history
  return TacticSchema.parse({ ...tactic, evidence_scope: "workspace", state: "hypothesized", experiment: parsed.data });
}

export type ConcludeOutcome =
  | { outcome: "validated" | "invalidated"; tactic: Tactic }
  | { outcome: "directional" | "inconclusive"; tactic: Tactic; reason: string };

export function conclude(tactic: Tactic, input: ResultInput): ConcludeOutcome {
  if (tactic.state !== "hypothesized" || !tactic.experiment) throw new TacticError(`${tactic.id} is ${tactic.state}; only a hypothesized tactic can be concluded`);
  const parsed = ResultSchema.safeParse(input);
  if (!parsed.success) throw new TacticError(`the result for ${tactic.id} is incomplete`, issuesOf(parsed.error));
  const result: Result = parsed.data;
  if ((result.outcome_source === "platform_proxy") !== (result.grading === "proxy")) {
    throw new TacticError(`grading must be "proxy" exactly when the outcome source is platform_proxy`);
  }
  const { design } = tactic.experiment;
  const days = validDays(result.date_range);

  const interim = (outcome: "directional" | "inconclusive", reason: string): ConcludeOutcome => ({
    outcome,
    reason,
    tactic: TacticSchema.parse({ ...tactic, experiment: { ...tactic.experiment, interim: [...tactic.experiment!.interim, result] } }),
  });

  if (result.sample_size < design.min_sample || days < design.duration_days) {
    const why = [
      result.sample_size < design.min_sample ? `sample ${result.sample_size} is below the pre-registered ${design.min_sample}` : "",
      days < design.duration_days ? `${days} day(s) is shorter than the pre-registered ${design.duration_days}` : "",
    ].filter(Boolean);
    return interim("directional", `underpowered: ${why.join("; ")}. Kept as a directional reading; the tactic stays hypothesized.`);
  }
  if (result.confidence >= DECISIVE_CONFIDENCE) {
    return { outcome: "validated", tactic: TacticSchema.parse({ ...tactic, state: "validated", result }) };
  }
  if (result.confidence <= 1 - DECISIVE_CONFIDENCE) {
    return { outcome: "invalidated", tactic: TacticSchema.parse({ ...tactic, state: "invalidated", result }) };
  }
  return interim("inconclusive", `confidence ${result.confidence} is between ${(1 - DECISIVE_CONFIDENCE).toFixed(2)} and ${DECISIVE_CONFIDENCE.toFixed(2)}. Extend the test or stop it; the tactic stays hypothesized.`);
}

export function retire(tactic: Tactic, reason: string, today: string): Tactic {
  if (tactic.state !== "validated") throw new TacticError(`${tactic.id} is ${tactic.state}; only a validated tactic can be retired`);
  return TacticSchema.parse({ ...tactic, state: "retired", retired: { reason, date: today } });
}
