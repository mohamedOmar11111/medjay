// What the side panel shows, read straight from the workspace (no ingest, no writes, no model).
// Every section is read on its own, so one missing piece (no mapping yet, no plans) never blanks the rest.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../audit/ledger.js";
import { scout } from "../analysis/scout.js";
import { loadMappings } from "../ingest/mapping.js";
import { PlanRepo } from "../plan/repo.js";
import { loadPolicy } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { loadWorkspace } from "../workspace/load.js";
import { sourceName } from "./answers.js";

const LEDGER_FILE = join(".medjay", "audit-log.jsonl");
const STORE_FILE = join(".medjay", "experiments.db");
const PERIOD_DAYS = { day: 1, week: 7, month: 30 } as const;

export interface Dashboard {
  workspace: { id: string; name: string; currency: string; timezone: string } | null;
  ledger: { seq: number; head: string } | null;
  plans: { number: number; state: string; id: string; expires_at: string }[];
  data: { status: "none" | "unmapped" | "ok"; period?: { start: string; end: string; days: number }; spend?: number; avgDaily?: number; sources: { id: string; ageDays: number | null; stale: boolean; errors: number }[] };
  cap: { amount: number; currency: string; period: "day" | "week" | "month"; perDay: number } | null;
  gate: { required: boolean; minChance: number } | null;
  problems: string[];
}

export const emptyDashboard = (): Dashboard => ({ workspace: null, ledger: null, plans: [], data: { status: "none", sources: [] }, cap: null, gate: null, problems: [] });

const describe = (error: unknown) => (error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));

export async function loadDashboard(dir: string, now: () => Date = () => new Date()): Promise<Dashboard> {
  const d = emptyDashboard();
  let freshnessSlaHours = 24;
  try {
    const { config } = await loadWorkspace(dir);
    d.workspace = { id: config.workspace.id, name: config.workspace.name, currency: config.workspace.base_currency, timezone: config.workspace.timezone };
    freshnessSlaHours = config.ingestion.freshness_sla_hours;
  } catch (error) {
    d.problems.push(`workspace: ${describe(error)}`);
    return d;
  }
  try {
    const head = await new Ledger(join(dir, LEDGER_FILE)).head();
    d.ledger = { seq: head.seq, head: head.hash };
  } catch (error) {
    d.problems.push(`ledger: ${describe(error)}`);
  }
  try {
    const policy = await loadPolicy(dir);
    const cap = policy.limits.max_total_spend_cap;
    if (cap) d.cap = { amount: cap.amount, currency: cap.currency, period: cap.period, perDay: cap.amount / PERIOD_DAYS[cap.period] };
    d.gate = { required: policy.limits.require_simulation_for_scale, minChance: policy.limits.min_simulation_p_positive };
  } catch (error) {
    d.problems.push(`policy: ${describe(error)}`);
  }
  let store: Store | undefined;
  // Opening the store creates and migrates it, so a workspace that has none yet is reported, not opened.
  if (!existsSync(join(dir, STORE_FILE))) {
    d.data = { status: existsSync(join(dir, "ingestion.mappings.yaml")) ? "none" : "unmapped", sources: [] };
    return d;
  }
  try {
    store = Store.open(join(dir, STORE_FILE));
    d.plans = new PlanRepo(store).list().map((r) => ({ number: r.number, state: r.state, id: r.plan_id, expires_at: r.expires_at }));
    try {
      const mappings = await loadMappings(dir);
      const snap = scout({ store, mappings, baseCurrency: d.workspace.currency, timezone: d.workspace.timezone, now: now(), days: 7, freshnessSlaHours });
      const sources = snap.sources.map((s) => ({ id: s.source_id, ageDays: s.age_days, stale: s.stale, errors: s.issues.errors }));
      if (snap.status === "ok" && snap.period) d.data = { status: "ok", period: snap.period, spend: snap.totals.spend, avgDaily: snap.totals.spend / snap.period.days, sources };
      else d.data = { status: "none", sources };
    } catch (error) {
      d.data = { status: "unmapped", sources: [] };
      if (!/no ingestion\.mappings\.yaml/.test(describe(error))) d.problems.push(`data: ${describe(error)}`);
    }
  } catch (error) {
    d.problems.push(`store: ${describe(error)}`);
  } finally {
    store?.close();
  }
  return d;
}

export type Tone = "normal" | "dim" | "warn" | "good" | "head";
export interface PanelLine {
  text: string;
  tone: Tone;
}

const money = (n: number) => Math.round(n).toLocaleString("en-US");
const short = (hash: string) => hash.slice(0, 8);

/** What this TUI session has done: the skill pinned for the agent and the draft cards seen so far. */
export interface SessionPanel {
  skill: string | null;
  drafts: string[];
}
export const emptySession = (): SessionPanel => ({ skill: null, drafts: [] });
const MAX_DRAFT_LINES = 4;

/** The side panel as plain lines, so the layout can be tested without a terminal. */
export function sidebarLines(d: Dashboard, now: Date = new Date(), session: SessionPanel = emptySession()): PanelLine[] {
  const out: PanelLine[] = [];
  const head = (text: string) => out.push({ text, tone: "head" });
  const line = (text: string, tone: Tone = "normal") => out.push({ text, tone });
  if (d.workspace === null) {
    line("no workspace yet", "warn");
    line("setup questions are in the feed", "dim");
    return out;
  }
  head("WORKSPACE");
  line(d.workspace.name);
  line(`${d.workspace.id} · ${d.workspace.currency}`, "dim");
  head("");
  head("PLANS");
  const open = d.plans.filter((p) => p.state === "proposed" || p.state === "approved" || p.state === "draft");
  if (d.plans.length === 0) line("none", "dim");
  else {
    line(`${open.length} waiting · ${d.plans.length} total`, open.length > 0 ? "warn" : "normal");
    for (const p of d.plans.slice(-5)) line(`#${p.number} ${p.state}${p.state === "proposed" && Date.parse(p.expires_at) < now.getTime() ? " (expired)" : ""}`, "dim");
  }
  if (session.skill !== null) {
    head("");
    head("SKILL");
    line(session.skill);
  }
  if (session.drafts.length > 0) {
    head("");
    head("DRAFTS");
    line(`${session.drafts.length} saved this session`);
    for (const draft of session.drafts.slice(-MAX_DRAFT_LINES)) line(draft, draft.includes("FAIL") ? "warn" : draft.includes("PASS") ? "good" : "dim");
  }
  head("");
  head("GATE");
  if (d.gate === null) line("unknown", "dim");
  else if (!d.gate.required) line("simulation not required", "warn");
  else line(`scale needs P(>0) ≥ ${Math.round(d.gate.minChance * 100)}%`, "dim");
  head("");
  head("DATA");
  if (d.data.status === "unmapped") line("not mapped yet: /scout sets it up", "warn");
  else if (d.data.status === "none") line("no ad data ingested", "warn");
  else {
    line(`${d.data.period!.start} → ${d.data.period!.end}`, "dim");
    for (const s of d.data.sources) line(`${s.stale ? "✗" : "✓"} ${sourceName(s.id, "en")}${s.ageDays === null ? "" : ` ${s.ageDays}d`}${s.errors > 0 ? ` (${s.errors} err)` : ""}`, s.stale || s.errors > 0 ? "warn" : "normal");
  }
  head("");
  head("SPEND");
  if (d.data.status !== "ok") line("-", "dim");
  else {
    line(`${money(d.data.avgDaily ?? 0)} ${d.workspace.currency}/day avg`);
    if (d.cap === null) line("no cap set", "dim");
    else if (d.cap.currency !== d.workspace.currency) line(`cap ${money(d.cap.amount)} ${d.cap.currency}/${d.cap.period} (other currency)`, "warn");
    else {
      const pct = Math.round(((d.data.avgDaily ?? 0) / d.cap.perDay) * 100);
      line(`cap ${money(d.cap.perDay)}/day: ${pct}%`, pct >= 90 ? "warn" : "normal");
    }
  }
  if (d.ledger) {
    head("");
    head("LEDGER");
    line(`#${d.ledger.seq} ${short(d.ledger.head)}`, "dim");
  }
  for (const p of d.problems) line(p, "warn");
  return out;
}

export const ledgerLabel = (d: Dashboard): string => (d.ledger ? `ledger #${d.ledger.seq} ${short(d.ledger.head)}` : "ledger -");

const DRAFT_CARD = /^(\S+\/\S+) (v\d+)(?: · sha [0-9a-f]+)? · copy check: (PASS|FAIL|not checked)/;

/** A "Draft saved" card as one short side-panel line, or null when the card is not one. */
export function draftPanelLine(summary: string): string | null {
  const m = DRAFT_CARD.exec(summary);
  return m ? `${m[1]} ${m[2]} ${m[3] === "not checked" ? "unchecked" : m[3]}` : null;
}
