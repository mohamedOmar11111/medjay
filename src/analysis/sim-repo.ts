// Simulations a plan can be bound to. The id is a hash of the numbers, so a plan can only cite a
// simulation that was really run: a hand-typed "P50 +9999" has no id in the store and is refused.
import { createHash } from "node:crypto";
import { canonicalJson } from "../audit/canonical.js";
import type { Store } from "../store/db.js";
import type { MonteCarlo, RangedInput, SimulationResult } from "./simulate.js";

export interface SimulationRecord {
  sim_id: string;
  created_at: string;
  seed: number;
  draws: number;
  spend: number;
  scale_pct: number | null;
  elasticity: number;
  currency: string;
  horizon_days: number;
  inputs_hash: string;
  source_plan_hash: string | null;
  target: MonteCarlo["target"];
  p10: number;
  p50: number;
  p90: number;
  p_positive: number;
}

type Fields = Omit<SimulationRecord, "sim_id" | "created_at" | "source_plan_hash">;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const inputsHash = (currency: string, inputs: Partial<Record<string, RangedInput>>): string => sha256(canonicalJson({ currency, inputs }));

/** Content-addressed: the same simulation always has the same id. */
export const simulationId = (f: Fields): string => `sim_${sha256(canonicalJson(f)).slice(0, 12)}`;

export function recordOf(result: Extract<SimulationResult, { status: "ok" }>, horizonDays: number, sourcePlanHash: string | null, now: Date): SimulationRecord {
  const mc = result.monte_carlo;
  const fields: Fields = {
    seed: mc.seed,
    draws: mc.draws,
    spend: result.spend,
    scale_pct: result.scale ? result.scale.pct : null,
    elasticity: result.scale ? result.scale.elasticity : 0,
    currency: result.currency,
    horizon_days: horizonDays,
    inputs_hash: inputsHash(result.currency, result.inputs),
    target: mc.target,
    p10: mc.p10,
    p50: mc.p50,
    p90: mc.p90,
    p_positive: mc.p_positive,
  };
  return { sim_id: simulationId(fields), created_at: now.toISOString(), source_plan_hash: sourcePlanHash, ...fields };
}

export class SimulationRepo {
  constructor(private readonly store: Store) {}

  put(record: SimulationRecord): SimulationRecord {
    this.store
      .database()
      .prepare(
        `INSERT OR IGNORE INTO simulations (sim_id, created_at, seed, draws, spend, scale_pct, elasticity, currency, horizon_days, inputs_hash, source_plan_hash, target, p10, p50, p90, p_positive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.sim_id, record.created_at, record.seed, record.draws, record.spend, record.scale_pct, record.elasticity, record.currency, record.horizon_days, record.inputs_hash, record.source_plan_hash, record.target, record.p10, record.p50, record.p90, record.p_positive);
    return this.require(record.sim_id);
  }

  get(id: string): SimulationRecord | undefined {
    const row = this.store.database().prepare("SELECT * FROM simulations WHERE sim_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record: SimulationRecord = {
      sim_id: String(row.sim_id),
      created_at: String(row.created_at),
      seed: Number(row.seed),
      draws: Number(row.draws),
      spend: Number(row.spend),
      scale_pct: row.scale_pct === null ? null : Number(row.scale_pct),
      elasticity: Number(row.elasticity),
      currency: String(row.currency),
      horizon_days: Number(row.horizon_days),
      inputs_hash: String(row.inputs_hash),
      source_plan_hash: (row.source_plan_hash as string | null) ?? null,
      target: row.target as MonteCarlo["target"],
      p10: Number(row.p10),
      p50: Number(row.p50),
      p90: Number(row.p90),
      p_positive: Number(row.p_positive),
    };
    const { sim_id: _id, created_at: _c, source_plan_hash: _s, ...fields } = record;
    if (simulationId(fields) !== record.sim_id) throw new Error(`simulation ${record.sim_id} does not match its stored numbers; the database was edited`);
    return record;
  }

  require(id: string): SimulationRecord {
    const record = this.get(id);
    if (!record) throw new Error(`no simulation ${id}; run \`mdj simulate\` (with --plan <n>) first`);
    return record;
  }
}

/** The reference a plan carries. */
export const refOf = (r: SimulationRecord) => ({ id: r.sim_id, seed: r.seed, p10: r.p10, p50: r.p50, p90: r.p90, p_positive: r.p_positive });

export interface BudgetMove {
  from: number;
  to: number;
  currency: string;
}

export type ScaleDerivation =
  | { ok: true; spend: number; scalePct: number; currency: string }
  | { ok: false; reason: "no_budget_change" | "mixed_currency" | "no_baseline" | "not_a_scale_up" };

/** The spend and the percentage change a plan's budget moves add up to, over `horizonDays`. */
export function scaleOf(moves: BudgetMove[], horizonDays: number): ScaleDerivation {
  if (moves.length === 0) return { ok: false, reason: "no_budget_change" };
  const currencies = new Set(moves.map((m) => m.currency));
  if (currencies.size > 1) return { ok: false, reason: "mixed_currency" };
  const from = moves.reduce((a, m) => a + m.from, 0);
  const to = moves.reduce((a, m) => a + m.to, 0);
  if (from <= 0) return { ok: false, reason: "no_baseline" };
  if (to <= from) return { ok: false, reason: "not_a_scale_up" };
  return { ok: true, spend: from * horizonDays, scalePct: Math.round(((to / from - 1) * 100) * 1e6) / 1e6, currency: [...currencies][0] as string };
}

/**
 * Why a stored simulation does not belong to these budget moves, or null when it does. A simulation
 * of "+15%" cannot be reused for a plan that raises budgets by 80%.
 */
export function bindingProblem(record: SimulationRecord, moves: BudgetMove[]): string | null {
  const scale = scaleOf(moves, record.horizon_days);
  if (!scale.ok) return scale.reason === "not_a_scale_up" ? "the plan does not raise any budget, so a scale simulation does not apply" : `the plan's budget moves cannot be simulated (${scale.reason})`;
  if (record.target !== "contribution_delta" || record.scale_pct === null) return `${record.sim_id} simulated a fixed spend, not a scale-up`;
  if (record.currency !== scale.currency) return `${record.sim_id} is in ${record.currency}, the plan's budgets are in ${scale.currency}`;
  if (Math.abs(record.scale_pct - scale.scalePct) > 0.01 || Math.abs(record.spend - scale.spend) > 0.01) {
    return `${record.sim_id} simulated +${record.scale_pct}% on ${record.spend}, but this plan is +${scale.scalePct}% on ${scale.spend}`;
  }
  return null;
}
