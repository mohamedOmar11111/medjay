// What the platform looks like NOW, as a person supplies it after importing an export. Medjay has no
// live connector yet, so verification works from a file: a JSON list of observations, or the
// campaign/negative-keyword export that Google Ads Editor produces. Either way the file is data to
// compare against, never instructions.
import { parseCsv } from "../ingest/csv.js";
import { cleanLabel, toNumber } from "../ingest/values.js";

export interface Observation {
  /** `${platform}:${kind}/${id}`, as in a plan's preconditions. */
  entity?: string;
  /** The object's display name (Editor shows names, not ids). */
  name?: string;
  field: "daily_budget" | "status" | "negative_keywords";
  /** A number for budgets, text for status, a list of { text, match } for negative keywords. */
  value: number | string | { text: string; match: "BROAD" | "PHRASE" | "EXACT" }[];
  currency?: string;
}

export class ObservedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservedError";
  }
}

const FIELDS = new Set(["daily_budget", "status", "negative_keywords"]);

export function parseObservedJson(text: string): Observation[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ObservedError(`the observed file is not valid JSON: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(list)) throw new ObservedError('expected a JSON array, or { "observations": [...] }');
  return list.map((item, i) => {
    const o = item as Record<string, unknown>;
    if (typeof o !== "object" || o === null || !FIELDS.has(String(o.field))) throw new ObservedError(`observation ${i + 1}: "field" must be daily_budget, status or negative_keywords`);
    if (typeof o.entity !== "string" && typeof o.name !== "string") throw new ObservedError(`observation ${i + 1}: needs an "entity" or a "name"`);
    if (o.value === undefined || o.value === null) throw new ObservedError(`observation ${i + 1}: has no "value"`);
    return {
      ...(typeof o.entity === "string" ? { entity: o.entity } : {}),
      ...(typeof o.name === "string" ? { name: cleanLabel(o.name, 200) } : {}),
      field: o.field as Observation["field"],
      value: o.value as Observation["value"],
      ...(typeof o.currency === "string" ? { currency: o.currency } : {}),
    };
  });
}

const MATCH: Record<string, "BROAD" | "PHRASE" | "EXACT"> = { "negative broad": "BROAD", "negative phrase": "PHRASE", "negative exact": "EXACT", "campaign negative broad": "BROAD", "campaign negative phrase": "PHRASE", "campaign negative exact": "EXACT" };

/** Google Ads Editor's campaign and negative-keyword export (headers matched by name, any order). */
export function parseEditorCsv(text: string): Observation[] {
  let rows: string[][];
  try {
    rows = parseCsv(text, text.slice(0, 2000).includes("\t") && !text.slice(0, 2000).split("\n")[0]!.includes(",") ? "\t" : ",");
  } catch (error) {
    throw new ObservedError(`the observed CSV cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [campaign, status, budget, keyword, criterion] = ["campaign", "campaign status", "budget", "keyword", "criterion type"].map(col) as [number, number, number, number, number];
  if (campaign === -1) throw new ObservedError('the observed CSV has no "Campaign" column');
  const out: Observation[] = [];
  const negatives = new Map<string, { text: string; match: "BROAD" | "PHRASE" | "EXACT" }[]>();
  for (const cells of rows.slice(1)) {
    const name = cleanLabel(cells[campaign] ?? "", 200);
    if (name === "") continue;
    const kw = keyword === -1 ? "" : (cells[keyword] ?? "").trim();
    if (kw !== "") {
      const match = MATCH[(criterion === -1 ? "" : (cells[criterion] ?? "")).trim().toLowerCase()];
      if (match) negatives.set(name, [...(negatives.get(name) ?? []), { text: kw, match }]);
      continue;
    }
    if (status !== -1 && (cells[status] ?? "").trim() !== "") out.push({ name, field: "status", value: (cells[status] as string).trim() });
    if (budget !== -1 && (cells[budget] ?? "").trim() !== "") {
      const n = toNumber(cells[budget]);
      if (n !== undefined) out.push({ name, field: "daily_budget", value: n });
    }
  }
  for (const [name, value] of negatives) out.push({ name, field: "negative_keywords", value });
  return out;
}

export function parseObserved(text: string, format: "json" | "google-editor-csv"): Observation[] {
  return format === "json" ? parseObservedJson(text) : parseEditorCsv(text);
}
