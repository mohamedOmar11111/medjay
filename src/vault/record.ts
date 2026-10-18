// What a validated tactic becomes when it leaves a workspace: a record of the tactic itself (its text,
// tags and a few bands of evidence) and nothing about the client. Allowlist, not blocklist: the
// record is BUILT from named fields, so a field nobody thought about is simply absent.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/canonical.js";
import { looksLikeInstruction } from "../ingest/values.js";
import { FUNNEL_STAGES, TacticSchema, type Prior, type Tactic } from "../tactics/schema.js";
import { findLeaks, forbiddenTokens, sanitizeText, type LeakContext } from "./sanitize.js";

export class PromotionError extends Error {
  constructor(
    message: string,
    readonly leaks: string[] = [],
    readonly where: string[] = [],
  ) {
    super(message);
    this.name = "PromotionError";
  }
}

const Tag = z.array(z.string().min(1).max(40)).default([]);
export const VaultRecordSchema = z
  .object({
    schema: z.literal(1),
    global_id: z.string().regex(/^GT-[0-9a-f]{12}$/),
    title: z.string().min(1).max(200),
    hypothesis: z.string().max(500).default(""),
    playbook: z.string().max(4000),
    pillars: z.array(z.number().int().min(1).max(11)).default([]),
    jobs: z.array(z.string().min(1).max(40)).default([]),
    matches: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    funnel_stage: z.enum(FUNNEL_STAGES).optional(),
    tags: z.object({ markets: Tag, verticals: Tag, seasons: Tag, languages: Tag }).strict(),
    evidence: z
      .object({
        metric: z.string().min(1).max(80),
        effect_band: z.string().min(1).max(40),
        sample_band: z.string().min(1).max(40),
        confidence_band: z.string().min(1).max(40),
        method: z.enum(["bayesian", "frequentist"]),
        outcome_source: z.enum(["crm", "ga4", "platform_proxy"]),
        grading: z.enum(["outcome", "proxy"]),
        period: z.string().regex(/^\d{4}-Q[1-4]$/),
      })
      .strict(),
  })
  .strict();
export type VaultRecord = z.infer<typeof VaultRecordSchema>;

// ---- bands

export function effectBand(effect: number): string {
  const sign = effect < 0 ? "-" : "+";
  const mag = Math.abs(effect);
  if (mag > 0.5) return effect < 0 ? "below -50%" : "above +50%";
  const edges = [0, 0.05, 0.15, 0.3, 0.5];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const [lo, hi] = [edges[i] as number, edges[i + 1] as number];
    if (mag < hi || (i === edges.length - 2 && mag <= hi)) return `${sign}${Math.round(lo * 100)}% to ${sign}${Math.round(hi * 100)}%`;
  }
  return "above +50%";
}

export function sampleBand(n: number): string {
  if (n < 100) return "under 100";
  if (n < 500) return "100-500";
  if (n <= 2000) return "500-2000";
  return "over 2000";
}

export function confidenceBand(p: number): string {
  if (p >= 0.99) return "0.99 or more";
  if (p >= 0.95) return "0.95-0.99";
  if (p >= 0.9) return "0.90-0.95";
  if (p <= 0.1) return "0.10 or less";
  return "0.10-0.90";
}

const quarter = (day: string): string => {
  const [y, m] = day.split("-") as [string, string];
  return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
};

const CURRENCY_WORDS = new Set(["sar", "aed", "egp", "qar", "usd", "eur", "gbp", "kwd", "bhd", "omr", "jod", "jpy", "krw"]);
/** "cost_per_deal_sar" -> "cost per deal": a metric name without a currency or a client's naming. */
export const metricLabel = (metric: string): string => metric.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !CURRENCY_WORDS.has(w)).join(" ");

// ---- promotion

export interface PromotionOptions {
  /** Words a human has reviewed and accepts (for example a generic word that also appears in a campaign name). */
  allowTokens?: string[];
}

export interface DiffEntry {
  field: string;
  before: string;
  after: string;
}

export interface Promotion {
  record: VaultRecord;
  diff: DiffEntry[];
  removed: Record<string, number>;
  dropped: string[];
  overridden: string[];
}

const DROPPED = ["id", "source", "experiment id and design", "exact dates", "caveats", "baseline value and snapshot", "workspace, brand and campaign names"];

export function buildPromotion(tactic: Tactic, body: string, ctx: Omit<LeakContext, "publicTags">, options: PromotionOptions = {}): Promotion {
  if (tactic.evidence_scope === "vault_prior") throw new PromotionError(`${tactic.id} is already from the vault; a prior is not promoted again`);
  if (tactic.state !== "validated" || !tactic.result || !tactic.experiment) throw new PromotionError(`only a validated tactic can be promoted; ${tactic.id} is ${tactic.state}`);
  const { result, experiment } = tactic;

  const removed: Record<string, number> = {};
  const clean = (text: string): string => {
    const s = sanitizeText(text);
    for (const [k, n] of Object.entries(s.removed)) removed[k] = (removed[k] ?? 0) + n;
    return s.text.trim();
  };
  const title = clean(tactic.title);
  const hypothesis = clean(experiment.hypothesis);
  const playbook = clean(body).slice(0, 4000);
  const metric = metricLabel(experiment.metric);

  const publicTags = [...tactic.tags.markets, ...tactic.tags.verticals, ...tactic.tags.seasons, ...tactic.tags.languages];
  const allowed = new Set((options.allowTokens ?? []).map((t) => t.toLowerCase()));
  const tokens = forbiddenTokens({ ...ctx, publicTags });
  const fields = { title, hypothesis, playbook, metric };
  const hits = Object.entries(fields).map(([where, text]) => ({ where, leaks: findLeaks(text, tokens) }));
  const flagged = [...new Set(hits.flatMap((h) => h.leaks))];
  const blocking = flagged.filter((t) => !allowed.has(t));
  if (blocking.length > 0) {
    const where = hits.filter((h) => h.leaks.some((t) => blocking.includes(t))).map((h) => h.where);
    throw new PromotionError(
      `the promoted text still contains words that identify this workspace: ${blocking.join(", ")} (in ${where.join(", ")}). Reword the tactic, or pass --allow-token for a word you have checked is generic.`,
      blocking,
      where,
    );
  }

  const body2 = {
    schema: 1 as const,
    title,
    hypothesis,
    playbook,
    pillars: tactic.pillars,
    jobs: tactic.jobs,
    matches: tactic.matches,
    ...(tactic.funnel_stage ? { funnel_stage: tactic.funnel_stage } : {}),
    tags: { markets: tactic.tags.markets, verticals: tactic.tags.verticals, seasons: tactic.tags.seasons, languages: tactic.tags.languages },
    evidence: {
      metric,
      effect_band: effectBand(result.effect),
      sample_band: sampleBand(result.sample_size),
      confidence_band: confidenceBand(result.confidence),
      method: result.method,
      outcome_source: result.outcome_source,
      grading: result.grading,
      period: quarter(result.date_range.slice(0, 10)),
    },
  };
  const global_id = `GT-${createHash("sha256").update(canonicalJson(body2), "utf8").digest("hex").slice(0, 12)}`;
  const record = VaultRecordSchema.parse({ ...body2, global_id });

  const diff: DiffEntry[] = [
    { field: "title", before: tactic.title, after: title },
    { field: "hypothesis", before: experiment.hypothesis, after: hypothesis },
    { field: "playbook", before: body.trim(), after: playbook },
    { field: "evidence.metric", before: experiment.metric, after: metric },
    { field: "evidence.effect_band", before: String(result.effect), after: record.evidence.effect_band },
    { field: "evidence.sample_band", before: String(result.sample_size), after: record.evidence.sample_band },
    { field: "evidence.confidence_band", before: String(result.confidence), after: record.evidence.confidence_band },
    { field: "evidence.period", before: result.date_range, after: record.evidence.period },
  ];
  return { record, diff, removed, dropped: DROPPED, overridden: flagged.filter((t) => allowed.has(t)) };
}

// ---- pull

/** A vault record as a local, UNVERIFIED tactic: a prior to test here, never a result to trust. */
export function importPrior(record: VaultRecord, now: Date): { tactic: Tactic; body: string } {
  for (const text of [record.title, record.hypothesis, record.playbook]) {
    if (looksLikeInstruction(text)) throw new PromotionError(`vault record ${record.global_id} reads like an instruction to an AI and was not imported`);
  }
  const prior: Prior = { global_id: record.global_id, ...pickEvidence(record) };
  const tactic = {
    id: `TACTIC-VAULT-${record.global_id.slice(3, 11)}`,
    title: record.title,
    pillars: record.pillars,
    jobs: record.jobs,
    matches: record.matches,
    ...(record.funnel_stage ? { funnel_stage: record.funnel_stage } : {}),
    source: { kind: "own_test" as const, ref: `vault:${record.global_id}`, date: now.toISOString().slice(0, 10) },
    state: "unverified" as const,
    evidence_scope: "vault_prior" as const,
    prior,
    tags: record.tags,
  };
  const body = `# ${record.title}\n\n> A prior from another workspace, not proof here. It was ${record.evidence.grading === "proxy" ? "graded on platform data" : "graded on outcome data"} (${record.evidence.outcome_source}), effect ${record.evidence.effect_band} on ${record.evidence.metric}, sample ${record.evidence.sample_band}, confidence ${record.evidence.confidence_band}, ${record.evidence.period}. Test it here before relying on it.\n\n${record.playbook}\n`;
  return { tactic: parsePulled(tactic), body };
}

function pickEvidence(r: VaultRecord): Omit<Prior, "global_id"> {
  const e = r.evidence;
  return { effect_band: e.effect_band, confidence_band: e.confidence_band, sample_band: e.sample_band, method: e.method, outcome_source: e.outcome_source, grading: e.grading, period: e.period, metric: e.metric };
}

const parsePulled = (input: unknown): Tactic => TacticSchema.parse(input);
