// The numbers behind the media-buyer rules. Every threshold lives here, grouped by where it came
// from, so a rule never invents one. A workspace can override any of them in context/media-rules.yaml
// (validated, with sane ranges); the defaults below are the pack's.
//
// Provenance (from the guide these rules were ported from, "20 Claude Skills for Media Buyers"):
// most thresholds are single practitioners' rules of thumb for ecommerce accounts, not laws. They
// are defaults to argue with, not benchmarks. The group "pack defaults" is not sourced at all.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const RULE_DEFAULTS = {
  // @zackpaid, X, 18 Sep 2026
  concepts_min: 15,
  concepts_max: 25,
  thumbstop_floor: 0.25,
  fatigue_cpm_rise: 0.2,
  fatigue_ctr_drop: 0.15,
  fatigue_freq: 3.0,
  fatigue_signals: 2,
  hands_off_hours: 72,
  bench_min: 10,
  rotate_days: 21,
  load_max_s: 2.0,
  // @adriamatz, X article, 24 Sep 2026
  impr_floor: 1000,
  impr_read: 2000,
  impr_pause: 3000,
  step_low: 0.15,
  step_high: 0.2,
  favourite_share: 0.5,
  // @Peter_Quadrel, X, 2 Oct 2026
  unfunded_spend: 100,
  top_decile_ref: 0.66,
  turnover_drop: 0.5,
  // @benradack 30 Sep 2026 vs @mannybarbas_ 1 Oct 2026 (the two disagree, so both are shown)
  batch_cpa_multiple: 4,
  batch_big: "20-30",
  batch_small: "10-15",
  // @lifemaximised, X, 9 Sep 2026
  brand_roas_floor: 6.0,
  brand_roas_ideal: 10.0,
  manual_bids: ["manual_cpc", "target_impression_share"] as string[],
  // pack defaults, not sourced
  min_conversions: 30,
  min_days: 7,
  lag_days: 2,
  z_crit: 1.96,
  dsa_promote_conv: 2,
  match_min: 0.6,
  cpa_slack: 0.2,
  turnover_min_peak: 0.1,
};

export type RuleConfig = typeof RULE_DEFAULTS;

const pos = z.number().positive();
const frac = z.number().min(0).max(1);

export const RuleOverridesSchema = z
  .object({
    concepts_min: z.number().int().min(1),
    concepts_max: z.number().int().min(1),
    thumbstop_floor: frac,
    fatigue_cpm_rise: frac,
    fatigue_ctr_drop: frac,
    fatigue_freq: pos,
    fatigue_signals: z.number().int().min(1).max(3),
    hands_off_hours: z.number().min(0).max(24 * 30),
    bench_min: z.number().int().min(1),
    rotate_days: z.number().int().min(1),
    load_max_s: pos,
    impr_floor: z.number().int().min(1),
    impr_read: z.number().int().min(1),
    impr_pause: z.number().int().min(1),
    step_low: frac,
    step_high: frac,
    favourite_share: frac,
    unfunded_spend: z.number().min(0),
    top_decile_ref: frac,
    turnover_drop: frac,
    batch_cpa_multiple: pos,
    batch_big: z.string().min(1).max(20),
    batch_small: z.string().min(1).max(20),
    brand_roas_floor: pos,
    brand_roas_ideal: pos,
    manual_bids: z.array(z.string().min(1)).min(1),
    min_conversions: z.number().int().min(1),
    min_days: z.number().int().min(1),
    lag_days: z.number().int().min(0).max(14),
    z_crit: pos,
    dsa_promote_conv: z.number().int().min(1),
    match_min: frac,
    cpa_slack: z.number().min(0).max(5),
    turnover_min_peak: frac,
  })
  .partial()
  .strict();

export class RuleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleConfigError";
  }
}

/** Defaults with the overrides applied, after checking the pairs that have to stay in order. */
export function resolveRuleConfig(overrides: z.infer<typeof RuleOverridesSchema> = {}): RuleConfig {
  const cfg: RuleConfig = { ...RULE_DEFAULTS, ...overrides };
  const need = (ok: boolean, message: string) => {
    if (!ok) throw new RuleConfigError(message);
  };
  need(cfg.concepts_min <= cfg.concepts_max, "concepts_min must not exceed concepts_max");
  need(cfg.impr_floor <= cfg.impr_read && cfg.impr_read <= cfg.impr_pause, "impressions must satisfy impr_floor <= impr_read <= impr_pause");
  need(cfg.step_low <= cfg.step_high, "step_low must not exceed step_high");
  need(cfg.brand_roas_floor <= cfg.brand_roas_ideal, "brand_roas_floor must not exceed brand_roas_ideal");
  return cfg;
}

export const RULES_FILE = join("context", "media-rules.yaml");

/** context/media-rules.yaml holds overrides only, for example `thumbstop_floor: 0.3`. Absent means defaults. */
export async function loadRuleConfig(workspaceDir: string): Promise<RuleConfig> {
  let text: string;
  try {
    text = await readFile(join(workspaceDir, RULES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveRuleConfig();
    throw error;
  }
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (error) {
    throw new RuleConfigError(`${RULES_FILE} is not valid YAML: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`);
  }
  const parsed = RuleOverridesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RuleConfigError(`${RULES_FILE} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return resolveRuleConfig(parsed.data);
}
