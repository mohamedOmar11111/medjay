// Turns one parsed export into normalized facts plus a list of issues. Nothing is thrown away
// silently: a row that cannot be read is skipped AND reported, a missing required column rejects the
// whole file. Cells that read like instructions to an AI are flagged (they stay data).
import { parseCsv } from "./csv.js";
import type { AdPlatformMapping, CrmMapping, WebAnalyticsMapping } from "./mapping.js";
import { cleanLabel, hashPhone, looksLikeInstruction, toDay, toInstant, toNumber } from "./values.js";

export interface Issue {
  severity: "error" | "warn";
  kind: "missing_column" | "bad_date" | "bad_number" | "negative_value" | "duplicate_row" | "suspicious_text" | "currency_mismatch" | "empty" | "bad_record" | "unreadable" | "too_large";
  file: string;
  row?: number;
  column?: string;
  message: string;
  excerpt?: string;
}

export interface AdFact {
  date: string;
  campaign: string;
  adset: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conv_value: number;
}
export interface WebFact {
  date: string;
  landing_page: string;
  source: string;
  campaign: string;
  sessions: number;
  key_events: number;
}
export interface LeadFact {
  lead_id: string;
  created_at: string;
  utm_source: string;
  campaign: string;
  adset: string;
  click_id: string | null;
  phone_hash: string | null;
  channel: string | null;
  first_response_seconds: number | null;
  ghosted_after_price: boolean | null;
}
export interface StageFact {
  lead_id: string;
  stage: string;
  entered_at: string;
}
export interface DealFact {
  deal_id: string;
  lead_id: string;
  value: number;
  currency: string;
  won_at: string;
}

export interface Normalized<T> {
  facts: T;
  issues: Issue[];
  rows: number;
  period: { start: string; end: string } | null;
}

const MAX_ISSUES_PER_KIND = 20;

class IssueLog {
  readonly list: Issue[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly file: string) {}
  add(issue: Omit<Issue, "file">): void {
    const key = `${issue.severity}:${issue.kind}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n <= MAX_ISSUES_PER_KIND) this.list.push({ ...issue, file: this.file });
  }
  /** Adds one summary line for each kind that was truncated. */
  finish(): Issue[] {
    for (const [key, n] of this.counts) {
      if (n > MAX_ISSUES_PER_KIND) {
        const [severity, kind] = key.split(":") as [Issue["severity"], Issue["kind"]];
        this.list.push({ severity, kind, file: this.file, message: `${n - MAX_ISSUES_PER_KIND} more ${kind} issue(s) not listed` });
      }
    }
    return this.list;
  }
}

const periodOf = (days: string[]): Normalized<unknown>["period"] => {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return { start: sorted[0] as string, end: sorted[sorted.length - 1] as string };
};

interface Table {
  header: string[];
  rows: { cells: string[]; line: number }[];
}

function readTable(text: string, delimiter: string, skipRows: number, log: IssueLog): Table | undefined {
  let all: string[][];
  try {
    all = parseCsv(text, delimiter);
  } catch (error) {
    log.add({ severity: "error", kind: "unreadable", message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
  const body = all.slice(skipRows);
  if (body.length < 2) {
    log.add({ severity: "error", kind: "empty", message: "the file has no data rows after the header" });
    return undefined;
  }
  const header = (body[0] as string[]).map((h) => h.trim());
  const rows = body.slice(1).map((cells, i) => ({ cells, line: skipRows + i + 2 }));
  // platform exports end with a "Total" row; it is not a day of data
  return { header, rows: rows.filter((r) => !/^\s*(total|grand total|الإجمالي)/i.test(r.cells[0] ?? "")) };
}

/** Column positions for the mapped names, or missing-column errors for every one that is absent. */
function locate(header: string[], wanted: Record<string, string | undefined>, required: readonly string[], log: IssueLog): Record<string, number> | undefined {
  const index: Record<string, number> = {};
  let ok = true;
  for (const [field, column] of Object.entries(wanted)) {
    if (column === undefined) continue;
    const at = header.findIndex((h) => h.toLowerCase() === column.toLowerCase());
    if (at === -1) {
      if (required.includes(field)) {
        log.add({ severity: "error", kind: "missing_column", column, message: `required column "${column}" (${field}) is not in the file; found: ${header.map((h) => cleanLabel(h, 40)).join(", ")}` });
        ok = false;
      } else log.add({ severity: "warn", kind: "missing_column", column, message: `optional column "${column}" (${field}) is not in the file; ${field} counts as 0` });
    } else index[field] = at;
  }
  return ok ? index : undefined;
}

function textCell(value: string | undefined, log: IssueLog, row: number, column: string): string {
  const raw = value ?? "";
  if (looksLikeInstruction(raw)) {
    log.add({ severity: "warn", kind: "suspicious_text", row, column, message: "this cell reads like an instruction to an AI; it is treated as plain data", excerpt: cleanLabel(raw, 80) });
  }
  return cleanLabel(raw);
}

function metric(cells: string[], at: number | undefined, log: IssueLog, row: number, column: string | undefined): number | null {
  if (at === undefined) return 0;
  const n = toNumber(cells[at] ?? "");
  if (n === undefined) {
    log.add({ severity: "warn", kind: "bad_number", row, ...(column ? { column } : {}), message: `"${cleanLabel(cells[at] ?? "", 30)}" is not a number; row skipped`, excerpt: cleanLabel(cells[at] ?? "", 30) });
    return null;
  }
  if (n < 0) {
    log.add({ severity: "warn", kind: "negative_value", row, ...(column ? { column } : {}), message: `negative value ${n}; row skipped` });
    return null;
  }
  return n;
}

export function normalizeAdPlatform(file: string, text: string, m: AdPlatformMapping): Normalized<AdFact[]> {
  const log = new IssueLog(file);
  const table = readTable(text, m.delimiter, m.skip_rows, log);
  const empty = { facts: [], issues: log.finish(), rows: 0, period: null };
  if (!table) return empty;
  const c = m.columns;
  const at = locate(table.header, c, ["date", "campaign", "spend"], log);
  if (!at) return { ...empty, issues: log.finish() };

  const seen = new Set<string>();
  const merged = new Map<string, AdFact>();
  let rows = 0;
  for (const { cells, line } of table.rows) {
    const fingerprint = cells.join("\u0001");
    if (seen.has(fingerprint)) {
      log.add({ severity: "warn", kind: "duplicate_row", row: line, message: "identical to an earlier row; dropped" });
      continue;
    }
    seen.add(fingerprint);
    const date = toDay(cells[at.date as number], m.date_format);
    if (!date) {
      log.add({ severity: "warn", kind: "bad_date", row: line, column: c.date, message: `"${cleanLabel(cells[at.date as number] ?? "", 30)}" is not a ${m.date_format} date; row skipped` });
      continue;
    }
    const campaign = textCell(cells[at.campaign as number], log, line, c.campaign);
    const adset = c.adset ? textCell(cells[at.adset as number], log, line, c.adset) : "";
    const values = (["spend", "impressions", "clicks", "conversions", "conv_value"] as const).map((f) => metric(cells, at[f], log, line, c[f]));
    if (values.some((v) => v === null)) continue;
    const [spend, impressions, clicks, conversions, conv_value] = values as number[];
    const key = `${date}\u0001${campaign}\u0001${adset}`;
    const prev = merged.get(key);
    if (prev) {
      prev.spend += spend as number;
      prev.impressions += impressions as number;
      prev.clicks += clicks as number;
      prev.conversions += conversions as number;
      prev.conv_value += conv_value as number;
    } else merged.set(key, { date, campaign, adset, spend: spend as number, impressions: impressions as number, clicks: clicks as number, conversions: conversions as number, conv_value: conv_value as number });
    rows += 1;
  }
  const facts = [...merged.values()];
  return { facts, issues: log.finish(), rows, period: periodOf(facts.map((f) => f.date)) };
}

export function normalizeWebAnalytics(file: string, text: string, m: WebAnalyticsMapping): Normalized<WebFact[]> {
  const log = new IssueLog(file);
  const table = readTable(text, m.delimiter, m.skip_rows, log);
  if (!table) return { facts: [], issues: log.finish(), rows: 0, period: null };
  const c = m.columns;
  const at = locate(table.header, c, ["date", "landing_page", "source", "campaign", "sessions"], log);
  if (!at) return { facts: [], issues: log.finish(), rows: 0, period: null };

  const facts: WebFact[] = [];
  for (const { cells, line } of table.rows) {
    const date = toDay(cells[at.date as number], m.date_format);
    if (!date) {
      log.add({ severity: "warn", kind: "bad_date", row: line, column: c.date, message: `"${cleanLabel(cells[at.date as number] ?? "", 30)}" is not a ${m.date_format} date; row skipped` });
      continue;
    }
    const sessions = metric(cells, at.sessions, log, line, c.sessions);
    const keyEvents = metric(cells, at.key_events, log, line, c.key_events);
    if (sessions === null || keyEvents === null) continue;
    facts.push({
      date,
      landing_page: textCell(cells[at.landing_page as number], log, line, c.landing_page),
      source: textCell(cells[at.source as number], log, line, c.source),
      campaign: textCell(cells[at.campaign as number], log, line, c.campaign),
      sessions,
      key_events: keyEvents,
    });
  }
  return { facts, issues: log.finish(), rows: facts.length, period: periodOf(facts.map((f) => f.date)) };
}

const own = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

/** Dotted path lookup that only follows own properties (no __proto__ or constructor tricks). */
export function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else current = own(current, part);
    if (current === undefined) return undefined;
  }
  return current;
}

const asText = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v === 1 || v === "1" || /^(true|yes)$/i.test(String(v)) ? true : v === 0 || v === "0" || /^(false|no)$/i.test(String(v)) ? false : null);

export interface CrmFacts {
  leads: LeadFact[];
  stages: StageFact[];
  deals: DealFact[];
}

const STAGE_ORDER = ["lead", "qualified", "booked", "won"] as const;

function stageMapper(m: CrmMapping): (raw: string) => { stage: string; mapped: boolean } {
  const table = new Map(Object.entries(m.stage_map).map(([k, v]) => [k.trim().toLowerCase(), v]));
  return (raw) => {
    const hit = table.get(raw.trim().toLowerCase());
    return hit ? { stage: hit, mapped: true } : { stage: cleanLabel(raw, 60), mapped: false };
  };
}

export function normalizeCrm(file: string, text: string, m: CrmMapping, workspaceId: string): Normalized<CrmFacts> {
  return m.format === "csv" ? normalizeCrmCsv(file, text, m, workspaceId) : normalizeCrmJson(file, text, m, workspaceId);
}

/** A timestamp from an ISO string, or from a day in the source's date format (midnight UTC). */
function instantOf(value: string | undefined, m: CrmMapping): string | undefined {
  if (!value) return undefined;
  const direct = toInstant(value);
  if (direct) return direct;
  const day = toDay(value, m.date_format);
  return day ? `${day}T00:00:00.000Z` : undefined;
}

function normalizeCrmCsv(file: string, text: string, m: CrmMapping, workspaceId: string): Normalized<CrmFacts> {
  const log = new IssueLog(file);
  const none: Normalized<CrmFacts> = { facts: { leads: [], stages: [], deals: [] }, issues: [], rows: 0, period: null };
  const table = readTable(text, m.delimiter, m.skip_rows, log);
  if (!table) return { ...none, issues: log.finish() };
  const c = m.columns as NonNullable<CrmMapping["columns"]>;
  const at = locate(table.header, c, ["contact_id", "created_at", "stage", "utm_source", "utm_campaign"], log);
  if (!at) return { ...none, issues: log.finish() };
  const map = stageMapper(m);

  const leads: LeadFact[] = [];
  const stages: StageFact[] = [];
  const deals: DealFact[] = [];
  const ids = new Set<string>();
  for (const { cells, line } of table.rows) {
    const cell = (field: keyof typeof c): string | undefined => (at[field] === undefined ? undefined : (cells[at[field] as number] ?? "").trim());
    const id = cell("contact_id");
    const createdAt = instantOf(cell("created_at"), m);
    if (!id || !createdAt) {
      log.add({ severity: "warn", kind: !createdAt && id ? "bad_date" : "bad_record", row: line, column: !id ? c.contact_id : c.created_at, message: `row ${line} has no usable ${!id ? c.contact_id : c.created_at}; skipped` });
      continue;
    }
    if (ids.has(id)) {
      log.add({ severity: "warn", kind: "duplicate_row", row: line, message: `contact ${cleanLabel(id, 30)} appears twice; the later row is dropped` });
      continue;
    }
    ids.add(id);
    const leadId = cleanLabel(id, 80);
    const phone = cell("phone");
    const givenHash = cell("phone_hash");
    const responseText = cell("first_response_seconds");
    const response = responseText ? toNumber(responseText) : undefined;
    leads.push({
      lead_id: leadId,
      created_at: createdAt,
      utm_source: textCell(cell("utm_source"), log, line, c.utm_source),
      campaign: textCell(cell("utm_campaign"), log, line, c.utm_campaign),
      adset: c.utm_content ? textCell(cell("utm_content"), log, line, c.utm_content) : "",
      click_id: cell("click_id") ? cleanLabel(cell("click_id") as string, 120) : null,
      phone_hash: givenHash && /^[0-9a-f]{64}$/.test(givenHash) ? givenHash : phone ? (hashPhone(workspaceId, phone) ?? null) : null,
      channel: cell("channel") || null,
      first_response_seconds: response !== undefined && response >= 0 ? response : null,
      ghosted_after_price: cell("ghosted_after_price") ? asBool(cell("ghosted_after_price")) : null,
    });

    // A flat export carries only the CURRENT stage, so the earlier stages are implied: a contact who
    // is won was a lead, qualified and booked first. They are stamped with the stage-change time.
    const rawStage = cell("stage") ?? "";
    const { stage, mapped } = map(rawStage);
    const known = mapped || (STAGE_ORDER as readonly string[]).includes(stage) || stage === "lost";
    if (!known) {
      log.add({ severity: "warn", kind: "bad_record", row: line, column: c.stage, message: `stage "${cleanLabel(rawStage, 40)}" is not in stage_map; the contact is kept as a lead` });
    }
    const current = known ? stage : "lead";
    const changedAt = instantOf(cell("stage_at"), m) ?? createdAt;
    const trail: string[] = current === "lost" ? ["lead", "lost"] : STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(current as (typeof STAGE_ORDER)[number]) + 1);
    trail.forEach((s, i) => stages.push({ lead_id: leadId, stage: s, entered_at: i === 0 ? createdAt : changedAt }));

    if (current === "won") {
      const revenueText = cell("revenue");
      const revenue = revenueText === undefined || revenueText === "" ? undefined : toNumber(revenueText);
      const currency = cell("currency") || m.currency;
      const wonAt = instantOf(cell("won_at"), m) ?? changedAt;
      if (revenue === undefined || revenue <= 0) {
        log.add({ severity: "warn", kind: "bad_record", row: line, column: c.revenue ?? "revenue", message: `contact ${cleanLabel(id, 30)} is won but has no positive revenue; no deal recorded` });
      } else {
        if (currency !== m.currency) log.add({ severity: "warn", kind: "currency_mismatch", row: line, message: `deal for ${cleanLabel(id, 30)} is in ${cleanLabel(currency, 8)}, the source is ${m.currency}; it is kept with its own currency and never converted` });
        deals.push({ deal_id: `d_${leadId}`, lead_id: leadId, value: revenue, currency: cleanLabel(currency, 8), won_at: wonAt });
      }
    }
  }
  return { facts: { leads, stages, deals }, issues: log.finish(), rows: leads.length, period: periodOf(leads.map((l) => l.created_at.slice(0, 10))) };
}

function normalizeCrmJson(file: string, text: string, m: CrmMapping, workspaceId: string): Normalized<CrmFacts> {
  const log = new IssueLog(file);
  const none: Normalized<CrmFacts> = { facts: { leads: [], stages: [], deals: [] }, issues: [], rows: 0, period: null };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    log.add({ severity: "error", kind: "unreadable", message: `not valid JSON: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` });
    return { ...none, issues: log.finish() };
  }
  const recordsPath = m.records_path as string;
  const records = getPath(data, recordsPath);
  if (!Array.isArray(records)) {
    log.add({ severity: "error", kind: "missing_column", column: recordsPath, message: `"${recordsPath}" is not an array in the file` });
    return { ...none, issues: log.finish() };
  }
  if (records.length === 0) {
    log.add({ severity: "error", kind: "empty", message: "the file has no records" });
    return { ...none, issues: log.finish() };
  }

  const map = stageMapper(m);
  const leads: LeadFact[] = [];
  const stages: StageFact[] = [];
  const deals: DealFact[] = [];
  const ids = new Set<string>();
  records.forEach((record, i) => {
    const row = i + 1;
    const f = m.fields as NonNullable<CrmMapping["fields"]>;
    const id = asText(getPath(record, f.lead_id));
    const createdAt = toInstant(getPath(record, f.created_at));
    if (!id || !createdAt) {
      log.add({ severity: "warn", kind: "bad_record", row, message: `record ${row} has no usable ${!id ? f.lead_id : f.created_at}; skipped` });
      return;
    }
    if (ids.has(id)) {
      log.add({ severity: "warn", kind: "duplicate_row", row, message: `lead ${cleanLabel(id, 30)} appears twice; the later one is dropped` });
      return;
    }
    ids.add(id);
    const text = (path: string | undefined, column: string): string => (path ? textCell(asText(getPath(record, path)), log, row, column) : "");
    const phone = f.phone ? asText(getPath(record, f.phone)) : undefined;
    const givenHash = f.phone_hash ? asText(getPath(record, f.phone_hash)) : undefined;
    const response = f.first_response_seconds ? toNumber(getPath(record, f.first_response_seconds) as never) : undefined;
    leads.push({
      lead_id: cleanLabel(id, 80),
      created_at: createdAt,
      utm_source: text(f.utm_source, f.utm_source),
      campaign: text(f.campaign, f.campaign),
      adset: text(f.adset, f.adset ?? "adset"),
      click_id: f.click_id ? asText(getPath(record, f.click_id)) ? cleanLabel(asText(getPath(record, f.click_id)) as string, 120) : null : null,
      phone_hash: givenHash && /^[0-9a-f]{64}$/.test(givenHash) ? givenHash : phone ? (hashPhone(workspaceId, phone) ?? null) : null,
      channel: f.channel ? (asText(getPath(record, f.channel)) ?? null) : null,
      first_response_seconds: response !== undefined && response >= 0 ? response : null,
      ghosted_after_price: f.ghosted_after_price ? asBool(getPath(record, f.ghosted_after_price)) : null,
    });

    const stagesMap = m.stages as NonNullable<CrmMapping["stages"]>;
    const dealMap = m.deal as NonNullable<CrmMapping["deal"]>;
    const events = getPath(record, stagesMap.path);
    if (Array.isArray(events)) {
      for (const e of events) {
        const stage = asText(getPath(e, stagesMap.name));
        const at = toInstant(getPath(e, stagesMap.at));
        if (stage && at) stages.push({ lead_id: cleanLabel(id, 80), stage: map(stage).stage, entered_at: at });
        else log.add({ severity: "warn", kind: "bad_record", row, message: `lead ${cleanLabel(id, 30)} has a stage event without a name or a valid time; skipped` });
      }
    }

    const deal = getPath(record, dealMap.path);
    if (deal !== undefined && deal !== null) {
      const dealId = asText(getPath(deal, dealMap.id));
      const value = toNumber(getPath(deal, dealMap.value) as never);
      const wonAt = toInstant(getPath(deal, dealMap.won_at));
      const currency = (dealMap.currency ? asText(getPath(deal, dealMap.currency)) : undefined) ?? m.currency;
      if (!dealId || value === undefined || value < 0 || !wonAt) {
        log.add({ severity: "warn", kind: "bad_record", row, message: `lead ${cleanLabel(id, 30)} has a deal without a usable id, value or won date; skipped` });
      } else {
        if (currency !== m.currency) {
          log.add({ severity: "warn", kind: "currency_mismatch", row, message: `deal ${cleanLabel(dealId, 30)} is in ${cleanLabel(currency, 8)}, the source is ${m.currency}; it is kept with its own currency and never converted` });
        }
        deals.push({ deal_id: cleanLabel(dealId, 80), lead_id: cleanLabel(id, 80), value, currency: cleanLabel(currency, 8), won_at: wonAt });
      }
    }
  });
  return { facts: { leads, stages, deals }, issues: log.finish(), rows: leads.length, period: periodOf(leads.map((l) => l.created_at.slice(0, 10))) };
}
