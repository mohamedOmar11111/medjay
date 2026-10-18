// The Shield's decision logic: pure functions, no I/O. Used at compile time (to block a plan that
// breaks policy), at approval time and again at strike time (policy may have changed).
import type { Effect, Policy, Rule } from "./policy.js";

export interface PolicyTarget {
  platform: string;
  kind: string;
  id: string;
}

export interface PolicyAction {
  id: string;
  type: string;
  target: PolicyTarget;
  /** budget_change only: daily budget before and after, in `currency`. */
  from?: number;
  to?: number;
  currency?: string;
  /** budget_change only: this exactly restores a budget an earlier approved plan changed (a rollback). */
  restores?: boolean;
  irreversible: boolean;
}

/** The numbers of the simulation a plan cites; the policy only needs these. */
export interface PolicySimulation {
  id: string;
  p50: number;
  p_positive: number;
}

export interface PolicySubject {
  client?: string;
  actions: PolicyAction[];
  simulation?: PolicySimulation | undefined;
}

export interface PolicyContext {
  /** Current total daily spend across the workspace, for the spend-cap projection. */
  baselineDailySpend?: { amount: number; currency: string };
  /**
   * "propose": a missing simulation is reported as not yet evaluated, so the plan can be stored and
   * simulated. "execute" (approve and strike, the default): a missing simulation fails.
   */
  stage?: "propose" | "execute";
}

export interface PolicyCheck {
  rule: string;
  /** null means "could not be evaluated" (never a silent pass). */
  ok: boolean | null;
  action_id?: string;
  limit?: number;
  actual?: number;
  note?: string;
}

export interface PolicyResult {
  status: "pass" | "fail";
  checks: PolicyCheck[];
  two_step_required: boolean;
  daily_delta: { gross: number; net: number };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const EPSILON = 1e-9;

const wildcardToRegex = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** The last matching rule wins; with no match, the default effect applies. */
export function evaluateRules(rules: readonly Rule[], action: string, resource: string, defaultEffect: Effect): Effect {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i] as Rule;
    if (wildcardToRegex(rule.action).test(action) && wildcardToRegex(rule.resource).test(resource)) return rule.effect;
  }
  return defaultEffect;
}

const resourceOf = (target: PolicyTarget) => `${target.platform}:${target.kind}/${target.id}`;

const isBudget = (a: PolicyAction): a is PolicyAction & { from: number; to: number } =>
  a.type === "budget_change" && typeof a.from === "number" && typeof a.to === "number";

export function checkPolicy(policy: Policy, subject: PolicySubject, context: PolicyContext = {}): PolicyResult {
  const checks: PolicyCheck[] = [];
  const budgets = subject.actions.filter(isBudget);

  for (const action of subject.actions) {
    if (policy.forbidden_actions.includes(action.type)) {
      checks.push({ rule: "forbidden_actions", ok: false, action_id: action.id, note: `${action.type} is forbidden` });
    }
    const resources = [resourceOf(action.target), ...(subject.client ? [`client:${subject.client}`] : [])];
    const denied = resources.find((resource) => evaluateRules(policy.rules, `write.${action.type}`, resource, policy.defaults.effect) === "deny");
    if (denied) checks.push({ rule: "rules", ok: false, action_id: action.id, note: `write.${action.type} on ${denied} is denied by a policy rule` });
  }

  for (const action of budgets) {
    if (action.to > action.from && action.restores) {
      checks.push({ rule: "max_daily_budget_increase_pct", ok: true, action_id: action.id, note: "restores a budget an approved plan changed (rollback)" });
    } else if (action.to > action.from) {
      const pct = action.from > 0 ? round6(((action.to - action.from) / action.from) * 100) : Number.POSITIVE_INFINITY;
      const limit = policy.limits.max_daily_budget_increase_pct;
      const check: PolicyCheck = { rule: "max_daily_budget_increase_pct", ok: pct <= limit + EPSILON, action_id: action.id, limit };
      if (Number.isFinite(pct)) check.actual = pct;
      else check.note = "raising a zero budget has no bounded percentage";
      checks.push(check);
    } else if (action.to < action.from) {
      const pct = round6(((action.from - action.to) / action.from) * 100);
      const limit = policy.limits.max_daily_budget_decrease_pct;
      checks.push({ rule: "max_daily_budget_decrease_pct", ok: pct <= limit + EPSILON, action_id: action.id, limit, actual: pct });
    }
  }

  if (policy.limits.require_simulation_for_scale && budgets.some((a) => a.to > a.from && !a.restores)) {
    const sim = subject.simulation;
    if (!sim) {
      checks.push({
        rule: "scale_requires_simulation",
        ok: context.stage === "propose" ? null : false,
        note: context.stage === "propose" ? "raises a budget; run `mdj simulate --plan <number>` before it can be approved" : "raises a budget and cites no simulation",
      });
    } else {
      const min = policy.limits.min_simulation_p_positive;
      checks.push({ rule: "simulation_passes", ok: sim.p50 > 0 && sim.p_positive >= min - EPSILON, limit: min, actual: sim.p_positive, note: `${sim.id}: P50 ${sim.p50}, needs P50 above 0 and P(above zero) of at least ${min}` });
    }
  }

  const deltas = budgets.map((a) => a.to - a.from);
  const net = round6(deltas.reduce((sum, d) => sum + d, 0));
  const gross = round6(deltas.reduce((sum, d) => sum + Math.abs(d), 0));

  const cap = policy.limits.max_total_spend_cap;
  if (cap) {
    const base = { rule: "max_total_spend_cap", limit: cap.amount } as const;
    const baseline = context.baselineDailySpend;
    if (cap.period !== "day") {
      checks.push({ ...base, ok: null, note: `a ${cap.period} cap is not evaluated yet (only daily caps are)` });
    } else if (!baseline) {
      checks.push({ ...base, ok: null, note: "current daily spend is unknown, so the cap could not be checked" });
    } else if (baseline.currency !== cap.currency || budgets.some((a) => a.currency !== cap.currency)) {
      checks.push({ ...base, ok: null, note: "currencies differ from the cap and Medjay never converts silently" });
    } else {
      const projected = round6(baseline.amount + net);
      checks.push({ ...base, ok: projected <= cap.amount + EPSILON, actual: projected });
    }
  }

  const threshold = policy.require_two_step_if.daily_spend_delta_abs_gte;
  const twoStep =
    (policy.require_two_step_if.irreversible && subject.actions.some((a) => a.irreversible)) ||
    (threshold !== undefined && gross >= threshold);

  return {
    status: checks.some((c) => c.ok === false) ? "fail" : "pass",
    checks,
    two_step_required: twoStep,
    daily_delta: { gross, net },
  };
}
