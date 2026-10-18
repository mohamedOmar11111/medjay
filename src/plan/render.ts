// Human-readable plan diff for the terminal. Plain text, no color, so it also pastes into chat.
import type { CompiledAction, Plan } from "./types.js";

const money = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const entity = (a: { target: { platform: string; kind: string; id: string; name?: string | undefined } }) =>
  `${a.target.platform}:${a.target.kind}/${a.target.id}${a.target.name ? ` "${a.target.name}"` : ""}`;

function renderAction(action: CompiledAction): string[] {
  switch (action.type) {
    case "budget_change": {
      const pct = action.from > 0 ? ((action.to - action.from) / action.from) * 100 : undefined;
      return [
        `${action.id}  budget_change  ${entity(action)}`,
        `    - daily_budget: ${money(action.from)} ${action.currency}`,
        `    + daily_budget: ${money(action.to)} ${action.currency}${pct === undefined ? "" : `   (${signed(pct)})`}`,
      ];
    }
    case "status_change":
      return [`${action.id}  status_change  ${entity(action)}`, `    - status: ${action.from}`, `    + status: ${action.to}`];
    case "add_negative_keywords":
      return [`${action.id}  add_negative_keywords  ${entity(action)}`, ...action.terms.map((t) => `    + negative [${t.match.toLowerCase()}]: ${t.text}`)];
    case "code_patch":
      return [`${action.id}  code_patch  ${action.artifact}   (exported for review, never deployed automatically)`];
    case "register_experiment":
      return [`${action.id}  register_experiment  ${action.experiment_id}`, `    hypothesis: ${action.hypothesis}`, `    metric: ${action.metric}`];
  }
}

export function renderPlan(plan: Plan, meta?: { number: number; state: string }): string {
  const lines: string[] = [];
  lines.push(meta ? `PLAN #${meta.number}  ${plan.plan_id}  [${meta.state}]  expires ${plan.expires_at}` : `PLAN ${plan.plan_id}  expires ${plan.expires_at}`);
  lines.push(`hash ${plan.plan_hash}`);
  const delta = plan.impact_estimate.daily_spend_delta;
  const cur = delta.currency ? ` ${delta.currency}` : "";
  lines.push(`daily budget change: gross ${money(delta.gross)}${cur}, net ${money(delta.net)}${cur}`);
  const origin = plan.origin;
  lines.push(`origin: ${origin.job}${origin.tactic_id ? `, tactic ${origin.tactic_id}` : ""}${origin.experiment_id ? `, experiment ${origin.experiment_id}` : ""}`);
  if (plan.simulation) {
    const s = plan.simulation;
    lines.push(`simulation ${s.id} (seed ${s.seed}): P10 ${s.p10}, P50 ${s.p50}, P90 ${s.p90}, P(>0) ${(s.p_positive * 100).toFixed(0)}%`);
  }
  lines.push("");
  for (const action of plan.actions) lines.push(...renderAction(action));
  lines.push("");
  const result = plan.policy_result;
  lines.push(`policy: ${result.status === "pass" ? "PASS" : "FAIL"}${result.two_step_required ? "  (two-step approval required)" : ""}`);
  for (const check of result.checks.filter((c) => c.ok !== true)) {
    const where = check.action_id ? ` ${check.action_id}` : "";
    const detail = check.note ?? `limit ${check.limit}, actual ${check.actual}`;
    lines.push(`  ${check.ok === false ? "FAIL" : "unknown"}  ${check.rule}${where}: ${detail}`);
  }
  return lines.join("\n");
}
