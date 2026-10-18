// Plain-text views of scout, diagnose and simulate results. Pure functions; the CLI prints them.
// Every report states its definitions and assumptions, and numbers that came from data cite their source.
import type { FileReport, IngestReport } from "../ingest/ingest.js";
import type { Diagnosis } from "./diagnose.js";
import type { Snapshot } from "./scout.js";
import type { SimulationResult } from "./simulate.js";

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const n2 = (n: number | null) => (n === null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const pad = (s: string, w: number) => s.padEnd(w);
const rpad = (s: string, w: number) => s.padStart(w);

const STATUS_WORD: Record<FileReport["status"], string> = { ingested: "read", unchanged: "unchanged", rejected: "REJECTED" };

export function renderIngest(report: IngestReport): string {
  const lines = ["Files"];
  for (const f of report.files) {
    const warn = f.issues.filter((i) => i.severity === "warn").length;
    const err = f.issues.filter((i) => i.severity === "error").length;
    lines.push(`  ${pad(STATUS_WORD[f.status], 10)} ${pad(f.file, 46)} ${rpad(String(f.rows), 5)} rows${f.period ? `  ${f.period.start}..${f.period.end}` : ""}${err ? `  ${err} error(s)` : ""}${warn ? `  ${warn} warning(s)` : ""}`);
    for (const i of f.issues.filter((x) => x.severity === "error")) lines.push(`      error: ${i.message}`);
  }
  for (const m of report.missing) lines.push(`  missing    no file matched mapping "${m}"`);
  for (const u of report.unmapped) lines.push(`  unmapped   ${u} (no mapping claims this file; it was not read)`);
  return lines.join("\n");
}

export function renderSnapshot(s: Snapshot): string {
  if (s.status === "no_data" || !s.period) return "No ad data ingested yet. Put your exports in data/imports/ and check ingestion.mappings.yaml.";
  const cur = s.currency;
  const t = s.totals;
  const out: string[] = [];
  out.push(`Snapshot ${s.period.start}..${s.period.end} (${s.period.days} days), all amounts in ${cur}`, "");
  out.push(`Spend ${n0(t.spend)}   Leads (CRM) ${t.leads}   Qualified ${t.qualified}   Deals ${t.deals}   Revenue of those leads ${n0(t.revenue)}`);
  out.push(`Blended MER ${n2(t.blended_mer)}   Cost per lead ${n2(t.cost_per_lead)}   Cost per deal ${n2(t.cost_per_deal)}`, "");
  out.push(`${pad("Platform", 9)}${rpad("Spend", 9)}${rpad("Reported", 10)}${rpad("CRM leads", 10)}${rpad("Ratio", 7)}${rpad("Qual.", 6)}${rpad("Deals", 6)}${rpad("Cost/deal", 11)}${rpad("Plat. ROAS", 11)}`);
  for (const p of s.platforms) {
    out.push(`${pad(p.platform, 9)}${rpad(n0(p.spend), 9)}${rpad(String(p.platform_conversions), 10)}${rpad(String(p.leads), 10)}${rpad(n2(p.calibration_ratio), 7)}${rpad(String(p.qualified), 6)}${rpad(String(p.deals), 6)}${rpad(n2(p.cost_per_deal), 11)}${rpad(n2(p.platform_roas), 11)}`);
  }
  out.push("", `${pad("Ad set", 34)}${pad("Platform", 9)}${rpad("Spend", 8)}${rpad("Reported", 9)}${rpad("Leads", 6)}${rpad("Qual.", 6)}${rpad("Deals", 6)}`);
  for (const a of s.adsets) out.push(`${pad(a.adset.slice(0, 32), 34)}${pad(a.platform, 9)}${rpad(n0(a.spend), 8)}${rpad(String(a.platform_conversions), 9)}${rpad(String(a.leads), 6)}${rpad(String(a.qualified), 6)}${rpad(String(a.deals), 6)}`);
  out.push("", `Match rate ${pct(s.match.rate)}: ${s.match.matched} of ${t.leads} CRM leads tied to a campaign (${s.match.matched_by_prefix} through a shortened UTM).`);
  if (s.match.unmatched > 0) {
    const reasons = new Map<string, number>();
    for (const u of s.match.unmatched_leads) reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1);
    out.push(`Unmatched: ${s.match.unmatched} (${[...reasons].map(([r, c]) => `${c} ${r}`).join(", ")}${s.match.unmatched > s.match.unmatched_listed ? `; first ${s.match.unmatched_listed} listed in --json` : ""}), ${s.match.unmatched_leads.filter((u) => u.has_deal).length} with a deal.`);
  }
  out.push(`Conversations: median first reply ${s.conversations.median_first_response_seconds === null ? "n/a" : `${Math.round(s.conversations.median_first_response_seconds)} s`}, ${pct(s.conversations.ghost_rate)} quiet after price.`);
  if (s.excluded.ad_rows_other_currency + s.excluded.deals_other_currency > 0) out.push(`Excluded (not ${cur}, never converted): ${s.excluded.ad_rows_other_currency} ad rows, ${s.excluded.deals_other_currency} deals.`);
  for (const src of s.sources.filter((x) => x.stale)) out.push(`STALE: ${src.source_id} is ${src.age_days} day(s) old.`);
  out.push("", "Definitions", ...Object.values(s.definitions).map((d) => `  ${d}`));
  return out.join("\n");
}

export function renderDiagnosis(d: Diagnosis): string {
  if (d.status === "no_data" || !d.period) return "No ad data ingested yet, nothing to diagnose.";
  const out = [`Diagnosis ${d.period.start}..${d.period.end}: ${d.findings.length} finding(s)`, ""];
  if (d.findings.length === 0) out.push("No anomalies above the thresholds.");
  for (const f of d.findings) {
    const money = f.wasted_spend !== null ? `  wasted ${n0(f.wasted_spend)} ${d.currency}` : f.spend_at_risk !== null ? `  at risk ${n0(f.spend_at_risk)} ${d.currency}` : "";
    out.push(`${d.top.includes(f.id) ? `#${d.top.indexOf(f.id) + 1}` : "  "} [${f.severity.toUpperCase()}] ${f.title}${money}`);
    out.push(`      ${f.summary}`);
    for (const e of f.evidence) out.push(`      source: ${e.source}${e.as_of ? ` (as of ${e.as_of})` : ""}`);
    out.push(`      next: ${f.recommendation}`, "");
  }
  return out.join("\n").trimEnd();
}

export function renderSimulation(r: SimulationResult, currency: string): string {
  if (r.status === "insufficient_inputs") {
    return ["Cannot simulate: these inputs in context/unit-economics.md need fixing (each needs value, low, high and source).", ...r.problems.map((p) => `  ${p.input}: ${p.message}`)].join("\n");
  }
  const out = [`Simulation at ${n0(r.spend)} ${currency} spend (${r.method})`, ""];
  out.push(`${pad("", 13)}${rpad("Pessimistic", 13)}${rpad("Base", 13)}${rpad("Optimistic", 13)}`);
  const row = (label: string, pick: (s: SimulationResultScenario) => number | null) => out.push(`${pad(label, 13)}${r.scenarios.map((s) => rpad(n2(pick(s)), 13)).join("")}`);
  type SimulationResultScenario = (typeof r.scenarios)[number];
  row("Leads", (s) => s.outcome.leads);
  row("Qualified", (s) => s.outcome.qualified);
  row("Deals", (s) => s.outcome.deals);
  row("Cost / deal", (s) => s.outcome.cost_per_deal);
  row("Revenue", (s) => s.outcome.revenue);
  row("MER", (s) => s.outcome.mer);
  row("Contribution", (s) => s.outcome.contribution);
  if (r.scale) {
    out.push("", `Scale ${r.scale.pct > 0 ? "+" : ""}${r.scale.pct}% to ${n0(r.scale.spend)} ${currency} (CPC x${r.scale.cpc_multiplier}, elasticity ${r.scale.elasticity} assumed)`);
    row("Contribution", (s) => s.scaled?.contribution ?? null);
    row("Change", (s) => s.contribution_delta ?? null);
  }
  const mc = r.monte_carlo;
  out.push("", `Monte Carlo (${n0(mc.draws)} draws, seed ${mc.seed}) of ${mc.target === "contribution_delta" ? "the change in contribution from scaling" : "contribution"}: P10 ${n0(mc.p10)}, P50 ${n0(mc.p50)}, P90 ${n0(mc.p90)}, P(above zero) ${(mc.p_positive * 100).toFixed(0)}%`);
  out.push("  P(above zero) is conditional on the model and the input ranges; it is not a forecast of reality.");
  out.push("", `Break-even: cost per deal ${n2(r.break_even.cost_per_deal)} ${currency}, ROAS ${n2(r.break_even.roas)}`);
  if (r.observed_check) {
    const o = r.observed_check;
    out.push(`Against scout: cost per deal ${n2(o.observed_cost_per_deal)} observed vs ${n2(o.model_cost_per_deal)} modelled; MER ${n2(o.observed_mer)} observed vs ${n2(o.model_mer)} modelled.`);
  }
  out.push("", "What moves the result most (contribution swing, one input at a time)");
  for (const s of r.sensitivity.slice(0, 5)) out.push(`  ${pad(s.label, 34)}${rpad(n0(s.contribution_at_worst), 9)} .. ${n0(s.contribution_at_best)}`);
  out.push("", "Assumptions", ...r.assumptions.map((a) => `  ${a}`));
  return out.join("\n");
}
