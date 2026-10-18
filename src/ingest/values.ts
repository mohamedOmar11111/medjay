// Parsing and cleaning of single cells. Everything here treats the cell as hostile text.
import { createHash } from "node:crypto";

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits and separators to ASCII. */
export function asciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXT_ARABIC_INDIC.indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

/**
 * "1,234.50", "SAR 1,234", "١٢٣٤" and "12%" become numbers; "", "--" and "n/a" are zero (platforms
 * print them for nothing happened). Anything else is undefined, never a guess.
 */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = asciiDigits(value).trim();
  if (text === "" || /^(--|-|n\/a|na|null)$/i.test(text)) return 0;
  // an optional currency code or symbol before or after, and a plain number in between
  const body = /^(?:[A-Za-z$€£﷼]{1,5}\s*)?(-?\d[\d,]*(?:\.\d+)?)\s*(?:[A-Za-z%﷼]{1,5})?$/.exec(text)?.[1];
  if (body === undefined) return undefined;
  const cleaned = body.replace(/,/g, "");
  return Number(cleaned);
}

const validDay = (y: number, m: number, d: number): boolean => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/** A calendar day as YYYY-MM-DD, or undefined when it is not a real date in the declared format. */
export function toDay(value: unknown, format: "iso" | "dmy" | "mdy"): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = asciiDigits(value).trim();
  let y: number;
  let m: number;
  let d: number;
  if (format === "iso") {
    const hit = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
    if (!hit) return undefined;
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else {
    const hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (!hit) return undefined;
    y = Number(hit[3]);
    [m, d] = format === "dmy" ? [Number(hit[2]), Number(hit[1])] : [Number(hit[1]), Number(hit[2])];
  }
  if (!validDay(y, m, d)) return undefined;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** An ISO timestamp (UTC), or undefined. Offsets are honoured. */
export function toInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return undefined;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Matching key for names that differ only in case, spacing and punctuation across platforms. */
export const normKey = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");

/** Single-line, bounded text: control characters out, whitespace collapsed, cut at `max`. */
export function cleanLabel(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** sha256 of the digits of a phone number, salted with the workspace id. The number itself is never stored. */
export function hashPhone(workspaceId: string, phone: string): string | undefined {
  const digits = asciiDigits(phone).replace(/\D/g, "").replace(/^00/, "");
  if (digits.length < 7) return undefined;
  return createHash("sha256").update(`${workspaceId}:${digits}`, "utf8").digest("hex");
}

const SUSPICIOUS: readonly RegExp[] = [
  /ignore (?:all |any |your |the )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?)/i,
  /\bsystem (?:notice|prompt|message|override)\b/i,
  /\b(?:disregard|override|forget) (?:your|the|all|any)\b/i,
  /\byou are (?:now )?(?:an? )?(?:assistant|ai|language model|agent)\b/i,
  /\b(?:call|invoke|run|use) (?:the )?[a-z_]+ (?:tool|function)\b/i,
  /\b(?:propose_plan_actions|read_file|list_files|lint_copy)\b/i,
  /\bcontext\/[\w-]+\.md\b/i,
  /<\/?untrusted_data/i,
  /تجاهل (?:كل |جميع )?(?:التعليمات|الأوامر)/,
];

/** True when a cell reads like an instruction to an AI. Such a cell is still data; this only flags it. */
export const looksLikeInstruction = (text: string): boolean => SUSPICIOUS.some((re) => re.test(text));
