// First-run convenience: when a workspace has no ingestion.mappings.yaml, look at the CSV exports in
// the dropzone, recognize the common platform headers, and write a mapping a person can review.
// It only ever matches headers it recognizes exactly (case, spacing and a trailing "(SAR)" aside);
// a file it cannot place is reported with the headers it found, never guessed at.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseCsv } from "./csv.js";
import { loadMappings, MAPPINGS_FILE, MappingError, MappingsSchema, type Mappings } from "./mapping.js";

const SAMPLE_BYTES = 256 * 1024;
const HEADER_SCAN_ROWS = 8;

type Fields = Record<string, string[]>;

// Lower-case, trimmed synonyms. The first listed synonym that exists in a file wins.
const AD_FIELDS: Fields = {
  date: ["day", "date", "reporting starts", "report date", "week", "reporting ends"],
  campaign: ["campaign name", "campaign", "campaign_name"],
  adset: ["ad set name", "ad set", "adset_name", "ad group", "ad group name", "adgroup"],
  spend: ["amount spent", "spend", "cost", "amount_spent"],
  impressions: ["impressions", "impr.", "impr", "impression"],
  clicks: ["link clicks", "clicks", "link_clicks"],
  conversions: ["results", "conversions", "purchases", "leads", "all conv."],
  conv_value: ["conv. value", "conversion value", "purchase conversion value", "all conv. value", "conv_value", "revenue"],
};
const WEB_FIELDS: Fields = {
  date: ["date", "day"],
  landing_page: ["landing page", "landing page + query string", "page path and screen class", "page path", "landing_page"],
  source: ["session source", "session source / medium", "source / medium", "first user source", "source"],
  campaign: ["session campaign", "session campaign name", "campaign", "first user campaign"],
  sessions: ["sessions", "session"],
  key_events: ["key events", "conversions", "event count"],
};
const CRM_FIELDS: Fields = {
  contact_id: ["contact id", "id", "contact_id", "lead id", "record id"],
  created_at: ["created at", "date added", "created_at", "create date", "created", "date created", "created date"],
  stage: ["stage", "lifecycle stage", "pipeline stage", "deal stage", "status", "stage name"],
  revenue: ["deal value", "amount", "revenue", "deal amount", "value"],
  utm_source: ["utm source", "utm_source", "source", "lead source"],
  utm_campaign: ["utm campaign", "utm_campaign", "campaign"],
  utm_content: ["utm content", "utm_content"],
  click_id: ["click id", "click_id", "gclid", "fbclid"],
  phone: ["phone", "phone number", "mobile", "phone_number"],
  phone_hash: ["phone_hash", "phone hash"],
};
const REQUIRED = {
  ad_platform: ["date", "campaign", "spend"],
  web_analytics: ["date", "landing_page", "source", "campaign", "sessions"],
  crm: ["contact_id", "created_at", "stage", "utm_source", "utm_campaign"],
};

const PLATFORM_WORDS: [string, RegExp][] = [
  ["meta", /(meta|facebook|\bfb\b|instagram|\big\b)/i],
  ["google", /(google|adwords|gads)/i],
  ["tiktok", /tiktok/i],
  ["snapchat", /snap/i],
  ["linkedin", /linkedin/i],
];
const ALIASES: Record<string, string[]> = {
  meta: ["facebook", "instagram", "fb", "ig", "meta"],
  google: ["google", "adwords"],
  tiktok: ["tiktok"],
  snapchat: ["snapchat", "snap"],
  linkedin: ["linkedin"],
};
const STAGE_WORDS: Record<string, "lead" | "qualified" | "booked" | "won" | "lost"> = {
  lead: "lead", "new lead": "lead", new: "lead", subscriber: "lead", unassigned: "lead",
  qualified: "qualified", "follow up": "qualified", "follow-up": "qualified", "marketing qualified lead": "qualified", "sales qualified lead": "qualified", mql: "qualified", sql: "qualified",
  appointment: "booked", booked: "booked", quoted: "booked", "appointment scheduled": "booked", "meeting booked": "booked",
  won: "won", "closed won": "won", customer: "won", paid: "won",
  lost: "lost", "closed lost": "lost", disqualified: "lost", unqualified: "lost",
};

export interface Unmatched {
  file: string;
  headers: string[];
  reason: string;
}

export interface Detection {
  mappings: Mappings | null;
  yaml: string;
  sources: string[];
  unmatched: Unmatched[];
  notes: string[];
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\([^)]*\)\s*$/, "");
const currencyIn = (h: string) => /\(([A-Z]{3})\)\s*$/.exec(h.trim())?.[1];

function sniffDelimiter(line: string): "," | ";" | "\t" {
  const count = (d: string) => line.split(d).length - 1;
  const best = ([",", ";", "\t"] as const).reduce((a, b) => (count(b) > count(a) ? b : a));
  return best;
}

function matchColumns(headers: string[], fields: Fields): Record<string, string> {
  const normalized = headers.map(norm);
  const out: Record<string, string> = {};
  for (const [field, synonyms] of Object.entries(fields)) {
    for (const synonym of synonyms) {
      const at = normalized.indexOf(synonym);
      if (at !== -1) {
        out[field] = headers[at]!.trim();
        break;
      }
    }
  }
  return out;
}

function sniffDateFormat(rows: string[][], column: number): "iso" | "dmy" | "mdy" | "ambiguous" {
  let first = 0;
  let second = 0;
  let sawSlash = false;
  for (const row of rows.slice(0, 200)) {
    const v = (row[column] ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/.exec(v);
    if (!m) continue;
    sawSlash = true;
    if (Number(m[1]) > 12) first += 1;
    if (Number(m[2]) > 12) second += 1;
  }
  if (!sawSlash) return "iso";
  if (first > 0 && second === 0) return "dmy";
  if (second > 0 && first === 0) return "mdy";
  return "ambiguous";
}

/** "meta-ads-2026-10-10_16.csv" becomes "meta-ads-*.csv", so next week's export is read too. */
function fileGlob(file: string): string {
  const m = /^(.*?)[-_ ]?\d{4}[-_]\d{2}[-_]\d{2}.*?(\.[A-Za-z0-9]+)$/.exec(file);
  return m ? `${m[1]}-*${m[2]}` : file;
}

const platformOf = (file: string, headers: string[]): string | null => {
  for (const [id, re] of PLATFORM_WORDS) if (re.test(file)) return id;
  const n = headers.map(norm);
  if (n.includes("amount spent") || n.includes("ad set name") || n.includes("link clicks")) return "meta";
  if (n.includes("impr.") || (n.includes("cost") && n.includes("ad group"))) return "google";
  return null;
};

interface Candidate {
  source: Record<string, unknown>;
  platform?: string;
}

// Platform UI reports that summarize a whole period by one thing and have no date column. The first
// column says what the rows are; the period is in the file name, which is how Google Ads names them.
const SUMMARY_KEYS: [string, string][] = [
  ["campaign", "campaign name"],
  ["search_term", "search"],
  ["keyword", "search keyword"],
  ["device", "device"],
  ["word", "word"],
  ["day", "date"],
];
const GOOGLE_PERIOD_IN_NAME = /\d{4}\.\d{2}\.\d{2}-\d{4}\.\d{2}\.\d{2}/;
const SUMMARY_METRICS = ["spend", "impressions", "clicks", "conversions", "conv_value"] as const;

function classifySummary(file: string, table: string[][], shown: string[], delimiter: string, baseCurrency: string): Candidate | Unmatched | null {
  const header = table[0];
  if (!header) return null;
  const names = header.map(norm);
  const metrics = matchColumns(header, AD_FIELDS);
  const keyed = SUMMARY_KEYS.find(([, column]) => names.includes(column));
  if (!keyed || metrics.spend === undefined) return null;
  const [dimension, keyName] = keyed;
  if (header.some((h) => /\(comparison\)/i.test(h))) {
    return { file, headers: shown, reason: "a comparison report (this period against another); not used, so the same spend is not counted twice" };
  }
  const named = GOOGLE_PERIOD_IN_NAME.test(file);
  if (!named && dimension !== "day") {
    return { file, headers: shown, reason: "a summary report, but the dates it covers are not in its file name; keep the platform's name, for example Campaigns(2026.09.01-2026.09.30).csv" };
  }
  const platform = platformOf(file, header) ?? (named ? "google" : null);
  if (platform === null) return { file, headers: shown, reason: "looks like a summary report, but not which platform; put meta, google, tiktok, snapchat or linkedin in the file name" };
  const spendAt = header.findIndex((h) => h.trim() === metrics.spend);
  const sample = table.slice(1, 6).map((r) => (r[spendAt] ?? "").trim());
  const currency = sample.map((v) => /^([A-Z]{3})\s*[\d.,]/.exec(v)?.[1]).find(Boolean) ?? baseCurrency;
  const columns: Record<string, string> = { key: header[names.indexOf(keyName)]!.trim() };
  for (const field of SUMMARY_METRICS) if (metrics[field] !== undefined) columns[field] = metrics[field]!;
  const glob = file.replace(GOOGLE_PERIOD_IN_NAME, "*");
  // no top-level platform: a summary has no UTM attribution, so it adds no source alias
  return { source: { id: `${platform}_${dimension}`, kind: "ad_summary", platform, currency, file: glob, delimiter, skip_rows: 0, dimension, columns } };
}

function classify(file: string, text: string, baseCurrency: string, notes: string[]): Candidate | Unmatched {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).slice(0, HEADER_SCAN_ROWS + 1);
  const delimiter = sniffDelimiter(lines.find((l) => l.trim() !== "") ?? "");
  let table: string[][];
  try {
    table = parseCsv(text, delimiter);
  } catch (error) {
    return { file, headers: [], reason: `cannot be read as CSV: ${error instanceof Error ? error.message : String(error)}` };
  }
  // the header row is the one in the first few rows that matches the most known columns
  const kinds = [["ad_platform", AD_FIELDS], ["web_analytics", WEB_FIELDS], ["crm", CRM_FIELDS]] as const;
  let best: { at: number; kind: (typeof kinds)[number][0]; cols: Record<string, string>; score: number } | null = null;
  for (let at = 0; at < Math.min(table.length, HEADER_SCAN_ROWS); at += 1) {
    for (const [kind, fields] of kinds) {
      const cols = matchColumns(table[at]!, fields);
      const complete = REQUIRED[kind].every((f) => cols[f] !== undefined);
      const score = (complete ? 100 : 0) + Object.keys(cols).length;
      if (complete && (best === null || score > best.score)) best = { at, kind, cols, score };
    }
  }
  const shown = (table[0] ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 25);
  if (best === null) {
    const summary = classifySummary(file, table, shown, delimiter, baseCurrency);
    if (summary) return summary;
    return { file, headers: shown, reason: "no known set of columns: an ad export needs date, campaign and spend; web analytics needs date, landing page, source, campaign and sessions; a CRM export needs contact id, created at, stage, utm source and utm campaign; a platform summary report needs a name column and cost, with the dates in the file name" };
  }
  const header = table[best.at]!;
  const body = table.slice(best.at + 1);
  const dateColumnName = best.kind === "crm" ? best.cols.created_at! : best.cols.date!;
  const format = sniffDateFormat(body, header.findIndex((h) => h.trim() === dateColumnName));
  if (format === "ambiguous") {
    return { file, headers: shown, reason: `dates in "${dateColumnName}" could be day-first or month-first; set date_format (dmy or mdy) by hand` };
  }
  const common = { file: fileGlob(file), delimiter, skip_rows: best.at, date_format: format };
  const currency = currencyIn(best.cols.spend ?? "") ?? currencyIn(best.cols.revenue ?? "") ?? baseCurrency;
  if (best.kind === "ad_platform") {
    const platform = platformOf(file, header);
    if (platform === null) return { file, headers: shown, reason: "looks like an ad export, but not which platform; put meta, google, tiktok, snapchat or linkedin in the file name" };
    return { platform, source: { id: `${platform}_ads`, kind: "ad_platform", platform, currency, ...common, columns: best.cols } };
  }
  if (best.kind === "web_analytics") return { source: { id: "web_analytics", kind: "web_analytics", ...common, columns: best.cols } };
  // crm: translate the stage words that appear in the file; list the ones that do not translate
  const stageAt = header.findIndex((h) => h.trim() === best!.cols.stage);
  const seen = [...new Set(body.map((r) => (r[stageAt] ?? "").trim()).filter(Boolean))].slice(0, 50);
  const stage_map: Record<string, string> = {};
  const unknown: string[] = [];
  for (const value of seen) {
    const canonical = STAGE_WORDS[value.toLowerCase()];
    if (canonical) stage_map[value] = canonical;
    else unknown.push(value);
  }
  if (unknown.length > 0) notes.push(`${file}: stage values not recognized and left unmapped: ${unknown.join(", ")}; add them under stage_map`);
  return { source: { id: "crm", kind: "crm", format: "csv", currency, ...common, stage_map, columns: best.cols } };
}

/** Look at the CSV exports directly inside the dropzone and propose a mapping. Writes nothing. */
export async function detectMappings(dropzoneDir: string, baseCurrency: string): Promise<Detection> {
  const notes: string[] = [];
  const unmatched: Unmatched[] = [];
  const sources: Record<string, unknown>[] = [];
  const platforms = new Set<string>();
  let names: string[] = [];
  try {
    names = (await readdir(dropzoneDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    /* no dropzone yet */
  }
  const seenGlobs = new Set<string>();
  for (const file of names) {
    if (/\.json$/i.test(file)) {
      unmatched.push({ file, headers: [], reason: "JSON exports (a CRM or relay) need a hand-written mapping: see SPEC section 30.13" });
      continue;
    }
    if (!/\.(csv|tsv|txt)$/i.test(file)) continue;
    const text = (await readFile(join(dropzoneDir, file), "utf8")).slice(0, SAMPLE_BYTES);
    const result = classify(file, text, baseCurrency, notes);
    if ("reason" in result) {
      unmatched.push(result);
      continue;
    }
    const glob = result.source.file as string;
    if (seenGlobs.has(glob)) continue; // another week of the same export
    seenGlobs.add(glob);
    let id = result.source.id as string;
    for (let n = 2; sources.some((s) => s.id === id); n += 1) id = `${result.source.id}_${n}`;
    sources.push({ ...result.source, id });
    if (result.platform) platforms.add(result.platform);
  }
  if (sources.length === 0) return { mappings: null, yaml: "", sources: [], unmatched, notes };
  const attribution = { source_aliases: Object.fromEntries([...platforms].map((p) => [p, ALIASES[p] ?? [p]])) };
  const raw = { version: 1, funnel: { qualified: ["qualified"] }, attribution, sources };
  const parsed = MappingsSchema.safeParse(raw);
  if (!parsed.success) {
    return { mappings: null, yaml: "", sources: [], unmatched: [...unmatched, { file: "(generated mapping)", headers: [], reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }], notes };
  }
  const header = `# Generated by Medjay from the CSV headers in your dropzone. Check it before relying on the numbers:\n# currency, date_format, platform names and the attribution aliases are the parts most worth a look.\n`;
  return { mappings: parsed.data, yaml: header + stringifyYaml(raw), sources: sources.map((s) => s.id as string), unmatched, notes };
}

export interface MappingsResult {
  mappings: Mappings;
  generated: Detection | null;
}

/** The mapping file if there is one; otherwise detect it from the dropzone and save it. */
export async function loadOrDetectMappings(workspaceDir: string, dropzoneDir: string, baseCurrency: string): Promise<MappingsResult> {
  try {
    return { mappings: await loadMappings(workspaceDir), generated: null };
  } catch (error) {
    if (!(error instanceof MappingError) || !error.message.startsWith(`no ${MAPPINGS_FILE}`)) throw error;
  }
  const detection = await detectMappings(dropzoneDir, baseCurrency);
  if (detection.mappings === null) {
    const found = detection.unmatched.map((u) => `  - ${u.file}${u.headers.length ? ` (headers: ${u.headers.join(", ")})` : ""}: ${u.reason}`);
    throw new MappingError(
      `no ${MAPPINGS_FILE} in this workspace, and the exports in ${dropzoneDir} could not be matched automatically.${found.length ? `\n${found.join("\n")}` : "\n  (no CSV files found there; export your ad platform reports into that folder)"}\nWrite the mapping by hand: see docs/SPEC.md section 30.9`,
    );
  }
  await writeFile(join(workspaceDir, MAPPINGS_FILE), detection.yaml, { encoding: "utf8", flag: "wx" });
  return { mappings: detection.mappings, generated: detection };
}
