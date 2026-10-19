// Reading a media-buyer CSV and running one rule on it. Files are plain exports a person saved, so
// they are untrusted: a bad cell becomes a warning, a missing column or date becomes an error that
// names it, and nothing in a file is ever treated as an instruction.
import { parseCsv } from "../ingest/csv.js";
import type { RuleConfig } from "./config.js";
import { MediaRuleError, ruleById, runRule, type Row, type RuleDef, type RuleResult } from "./rules.js";

export const MEDIA_DIR = "media";
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export function parseRows(text: string): Row[] {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    throw new MediaRuleError(`the CSV cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const header = (table[0] ?? []).map((h) => h.trim());
  if (header.length === 0 || header.every((h) => h === "")) throw new MediaRuleError("the CSV has no header row");
  return table.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()])));
}

/** `key=value` arguments to a params record; anything without an = is a file. */
export function splitArgs(args: string[]): { file: string | undefined; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let file: string | undefined;
  for (const arg of args) {
    const at = arg.indexOf("=");
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, at))) params[arg.slice(0, at)] = arg.slice(at + 1);
    else if (file === undefined) file = arg;
    else throw new MediaRuleError(`unexpected argument "${arg}" (one file at most; parameters are key=value)`);
  }
  return { file, params };
}

export function runMedia(id: string, csvText: string | undefined, options: { cfg: RuleConfig; params?: Record<string, string>; now?: () => Date }): { def: RuleDef; result: RuleResult } {
  const def = ruleById(id);
  if (!def) throw new MediaRuleError(`no media rule "${id}"; see \`mdj media list\``);
  const rows = def.file === "-" ? [] : parseRows(csvText ?? "");
  const unknown = Object.keys(options.params ?? {}).filter((p) => !def.params.some((d) => d.name === p));
  if (unknown.length > 0) throw new MediaRuleError(`${id} does not take ${unknown.map((u) => `${u}=`).join(", ")}; it takes ${def.params.map((p) => `${p.name}=`).join(", ") || "no parameters"}`);
  return { def, result: runRule(def, rows, options) };
}
