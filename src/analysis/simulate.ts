// mdj simulate: deterministic funnel math from context/unit-economics.md, before money moves.
//   spend -> clicks (CPC) -> leads (landing/chat CVR) -> conversations -> qualified -> deals -> margin
// Every input is {value, low, high, source}. Missing or unranged inputs stop the run
// (insufficient_inputs): a bare point estimate is never produced. Results are three scenarios
// (low, base, high) plus a one-at-a-time sensitivity ranking. The scale elasticity is an ASSUMPTION
// (default 0.25) and is printed as one. No Monte Carlo yet; nothing here is random.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const ELASTICITY_DEFAULT = 0.25;

export const INPUTS = [
  { key: "cpc", label: "cost per click", kind: "money", required: true },
  { key: "landing_page_cvr", label: "click to lead/chat rate", kind: "rate", required: true },
  { key: "lead_to_chat", label: "lead to conversation rate", kind: "rate", required: true },
  { key: "chat_to_qualified", label: "conversation to qualified rate", kind: "rate", required: true },
  { key: "qualified_to_deal", label: "qualified to deal rate", kind: "rate", required: true },
  { key: "average_deal_value", label: "revenue per deal", kind: "money", required: true },
  { key: "gross_margin", label: "gross margin", kind: "rate", required: true },
  { key: "refund_rate", label: "refund rate", kind: "rate", required: false },
  { key: "bnpl_fee", label: "BNPL fee, share of deal value", kind: "rate", required: false },
] as const;

export type InputKey = (typeof INPUTS)[number]["key"];

export interface RangedInput {
  value: number;
  low: number;
  high: number;
  source: string;
}

export interface InputProblem {
  input: string;
  problem: "missing" | "no_range" | "out_of_range" | "invalid";
  message: string;
}

export interface UnitEconomics {
  currency: string;
  inputs: Partial<Record<InputKey, RangedInput>>;
  problems: InputProblem[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseUnitEconomics(text: string): UnitEconomics {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  const front = (match ? parseYaml(match[1] as string) : null) as Record<string, unknown> | null;
  const problems: InputProblem[] = [];
  const currency = typeof front?.currency === "string" ? front.currency : "";
  if (!/^[A-Z]{3}$/.test(currency)) problems.push({ input: "currency", problem: "invalid", message: "currency must be an ISO 4217 code such as SAR" });

  const inputs: Partial<Record<InputKey, RangedInput>> = {};
  for (const spec of INPUTS) {
    const raw = front?.[spec.key];
    if (raw === undefined || raw === null) {
      if (spec.required) problems.push({ input: spec.key, problem: "missing", message: `${spec.label} is not set` });
      continue;
    }
    if (typeof raw === "number") {
      problems.push({ input: spec.key, problem: "no_range", message: `${spec.label} is a bare number; it needs value, low, high and source` });
      continue;
    }
    const o = raw as Record<string, unknown>;
    const [value, low, high] = [num(o.value), num(o.low), num(o.high)];
    if (value === null) {
      if (spec.required) problems.push({ input: spec.key, problem: "missing", message: `${spec.label} has no value` });
      continue;
    }
    if (low === null || high === null) {
      problems.push({ input: spec.key, problem: "no_range", message: `${spec.label} needs low and high (a bare number is not enough)` });
      continue;
    }
    const bounded = spec.kind === "rate" ? low >= 0 && high <= 1 : low > 0;
    if (!(low <= value && value <= high) || !bounded) {
      problems.push({ input: spec.key, problem: "out_of_range", message: `${spec.label}: need low <= value <= high${spec.kind === "rate" ? ", all between 0 and 1" : ", all above 0"}` });
      continue;
    }
    inputs[spec.key] = { value, low, high, source: typeof o.source === "string" ? o.source : "" };
  }
  return { currency, inputs, problems };
}

export async function loadUnitEconomics(workspaceDir: string): Promise<UnitEconomics> {
  try {
    return parseUnitEconomics(await readFile(join(workspaceDir, "context", "unit-economics.md"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { currency: "", inputs: {}, problems: [{ input: "context/unit-economics.md", problem: "missing", message: "the file does not exist" }] };
    }
    throw error;
  }
}

type Values = Record<InputKey, number>;

export interface Outcome {
  clicks: number;
  leads: number;
  conversations: number;
  qualified: number;
  deals: number;
  revenue: number;
  gross_profit: number;
  bnpl_fees: number;
  contribution: number;
  cost_per_deal: number | null;
  mer: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The funnel for one set of input values at a given spend. */
export function funnel(v: Values, spend: number, cpcMultiplier = 1): Outcome {
  const clicks = spend / (v.cpc * cpcMultiplier);
  const leads = clicks * v.landing_page_cvr;
  const conversations = leads * v.lead_to_chat;
  const qualified = conversations * v.chat_to_qualified;
  const deals = qualified * v.qualified_to_deal;
  const revenue = deals * v.average_deal_value * (1 - v.refund_rate);
  const grossProfit = revenue * v.gross_margin;
  const bnpl = revenue * v.bnpl_fee;
  return {
    clicks: r2(clicks),
    leads: r2(leads),
    conversations: r2(conversations),
    qualified: r2(qualified),
    deals: r2(deals),
    revenue: r2(revenue),
    gross_profit: r2(grossProfit),
    bnpl_fees: r2(bnpl),
    contribution: r2(grossProfit - bnpl - spend),
    cost_per_deal: deals > 0 ? r2(spend / deals) : null,
    mer: spend > 0 ? r2(revenue / spend) : 0,
  };
}

const GOOD_WHEN_HIGH: Record<InputKey, boolean> = {
  cpc: false,
  landing_page_cvr: true,
  lead_to_chat: true,
  chat_to_qualified: true,
  qualified_to_deal: true,
  average_deal_value: true,
  gross_margin: true,
  refund_rate: false,
  bnpl_fee: false,
};

export interface SimulateOptions {
  spend: number;
  /** Percent change in spend to test, e.g. 50 for +50%. */
  scalePct?: number;
  elasticity?: number;
  /** What scout measured, to show how far the model is from reality. */
  observed?: { cost_per_deal: number | null; blended_mer: number | null } | undefined;
}

export interface Scenario {
  name: "pessimistic" | "base" | "optimistic";
  outcome: Outcome;
  scaled?: Outcome;
  contribution_delta?: number;
}

export interface Sensitivity {
  input: InputKey;
  label: string;
  contribution_at_worst: number;
  contribution_at_best: number;
  swing: number;
}

export type SimulationResult =
  | { status: "insufficient_inputs"; problems: InputProblem[] }
  | {
      status: "ok";
      currency: string;
      method: string;
      spend: number;
      scale: { pct: number; elasticity: number; cpc_multiplier: number; spend: number } | null;
      inputs: Partial<Record<InputKey, RangedInput>>;
      scenarios: Scenario[];
      break_even: { cost_per_deal: number; roas: number };
      sensitivity: Sensitivity[];
      assumptions: string[];
      observed_check: { observed_cost_per_deal: number | null; model_cost_per_deal: number | null; observed_mer: number | null; model_mer: number } | null;
    };

export function simulate(economics: UnitEconomics, options: SimulateOptions): SimulationResult {
  if (economics.problems.length > 0) return { status: "insufficient_inputs", problems: economics.problems };
  if (!(options.spend > 0)) throw new RangeError("spend must be a positive number");
  const elasticity = options.elasticity ?? ELASTICITY_DEFAULT;
  if (elasticity < 0 || elasticity > 2) throw new RangeError("elasticity must be between 0 and 2");

  const pick = (which: "low" | "value" | "high"): Values => {
    const out = {} as Values;
    for (const spec of INPUTS) {
      const given = economics.inputs[spec.key];
      if (!given) {
        out[spec.key] = 0;
        continue;
      }
      if (which === "value") out[spec.key] = given.value;
      else {
        // "low" scenario = every input at its worse end, "high" = every input at its better end
        const useHigh = which === "high" ? GOOD_WHEN_HIGH[spec.key] : !GOOD_WHEN_HIGH[spec.key];
        out[spec.key] = useHigh ? given.high : given.low;
      }
    }
    return out;
  };

  const scalePct = options.scalePct;
  const multiplier = scalePct === undefined ? 1 : (1 + scalePct / 100) ** elasticity;
  const scaledSpend = scalePct === undefined ? null : options.spend * (1 + scalePct / 100);
  if (scaledSpend !== null && !(scaledSpend > 0)) throw new RangeError("scale-pct must stay above -100");

  const scenario = (name: Scenario["name"], values: Values): Scenario => {
    const outcome = funnel(values, options.spend);
    if (scaledSpend === null) return { name, outcome };
    const scaled = funnel(values, scaledSpend, multiplier);
    return { name, outcome, scaled, contribution_delta: r2(scaled.contribution - outcome.contribution) };
  };
  const base = pick("value");
  const scenarios = [scenario("pessimistic", pick("low")), scenario("base", base), scenario("optimistic", pick("high"))];

  // one at a time: move a single input to its worst and best end, the rest at base
  const measure = (values: Values) => (scaledSpend === null ? funnel(values, options.spend).contribution : funnel(values, scaledSpend, multiplier).contribution - funnel(values, options.spend).contribution);
  const sensitivity: Sensitivity[] = INPUTS.flatMap((spec) => {
    const given = economics.inputs[spec.key];
    if (!given || given.low === given.high) return [];
    const worstEnd = GOOD_WHEN_HIGH[spec.key] ? given.low : given.high;
    const bestEnd = GOOD_WHEN_HIGH[spec.key] ? given.high : given.low;
    const worst = measure({ ...base, [spec.key]: worstEnd });
    const best = measure({ ...base, [spec.key]: bestEnd });
    return [{ input: spec.key, label: spec.label, contribution_at_worst: r2(worst), contribution_at_best: r2(best), swing: r2(best - worst) }];
  }).sort((a, b) => b.swing - a.swing || a.input.localeCompare(b.input));

  const perDeal = base.average_deal_value * (1 - base.refund_rate) * (base.gross_margin - base.bnpl_fee);
  const marginPerRevenue = base.gross_margin - base.bnpl_fee;
  const model = scenarios[1]!.outcome;
  const assumptions = [
    ...INPUTS.filter((s) => !s.required && !economics.inputs[s.key]).map((s) => `${s.label} is not set and is treated as 0`),
    `Scenarios put every input at its worse (pessimistic) or better (optimistic) end together; real outcomes rarely hit all ends at once.`,
    ...(scaledSpend === null ? [] : [`ASSUMPTION: cost per click rises with spend as (1 + scale)^${elasticity}. This is not estimated from your data yet; check it against a real scale-up.`]),
    "Rates are taken as constant across spend levels; audience saturation beyond the CPC effect is not modelled.",
  ];

  return {
    status: "ok",
    currency: economics.currency,
    method: "deterministic scenarios and one-at-a-time sensitivity; no random draws",
    spend: options.spend,
    scale: scaledSpend === null ? null : { pct: scalePct as number, elasticity, cpc_multiplier: r2(multiplier), spend: r2(scaledSpend) },
    inputs: economics.inputs,
    scenarios,
    break_even: { cost_per_deal: r2(perDeal), roas: marginPerRevenue > 0 ? r2(1 / marginPerRevenue) : Number.POSITIVE_INFINITY },
    sensitivity,
    assumptions,
    observed_check: options.observed ? { observed_cost_per_deal: options.observed.cost_per_deal, model_cost_per_deal: model.cost_per_deal, observed_mer: options.observed.blended_mer, model_mer: model.mer } : null,
  };
}
