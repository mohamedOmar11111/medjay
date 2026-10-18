// Claim register: every public number needs a verified claim (the owner's M17 rule, productized).
// Numbers are compared by meaning, not spelling: "1M SAR", "SAR 1,000,000" and "+1m sar" are the
// same claim, and Arabic-Indic digits are read as digits.
import { z } from "zod";

export const ClaimSchema = z
  .object({
    id: z.string().regex(/^CLM-\d{3,}$/, "use ids like CLM-001"),
    values: z.array(z.string().min(1)).min(1),
    text: z.string().min(1),
    source: z.string().min(1),
    date: z.iso.date(),
    status: z.enum(["verified", "pending"]),
  })
  .strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimRegisterSchema = z.object({ claims: z.array(ClaimSchema) }).strict();
export type ClaimRegister = z.infer<typeof ClaimRegisterSchema>;

export interface NumericToken {
  /** Range in the (normalized) text. */
  start: number;
  end: number;
  raw: string;
  canonical: string;
}

const CURRENCIES = "SAR|AED|EGP|USD|EUR|GBP|QAR|KWD|BHD|OMR|JOD";
const UNITS = "k|m|b|thousand|million|billion";
const UNIT_FACTOR: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
const SYMBOL_CODE: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

const PERCENT = /(?<![\p{L}\p{N}_.])[+-]?\d[\d,]*(?:\.\d+)?\s?%/gu;
const MULTIPLIER = /(?<![\p{L}\p{N}_.])\d+(?:\.\d+)?\s?[x×](?![\p{L}\p{N}_])/giu;
const AMOUNT_FIRST = new RegExp(`(?<![\\p{L}\\p{N}_.])[+-]?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:${UNITS})?\\s?(?:${CURRENCIES})(?![\\p{L}])`, "giu");
const CURRENCY_FIRST = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${CURRENCIES}|[$€£])\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?(?:${UNITS})?(?![\\p{L}\\p{N}])`, "giu");

const toNumber = (digits: string) => Number(digits.replace(/[,+\s]/g, ""));

function canonical(kind: "percent" | "multiplier" | "amount", raw: string): string {
  const cleaned = raw.trim();
  if (kind === "percent") return `${Math.abs(toNumber(cleaned.replace("%", "")))}%`;
  if (kind === "multiplier") return `${toNumber(cleaned.replace(/[x×]/i, ""))}x`;
  const code = (/(SAR|AED|EGP|USD|EUR|GBP|QAR|KWD|BHD|OMR|JOD)/i.exec(cleaned)?.[1] ?? SYMBOL_CODE[/[$€£]/.exec(cleaned)?.[0] ?? ""] ?? "").toUpperCase();
  const number = /\d[\d,]*(?:\.\d+)?/.exec(cleaned)?.[0] ?? "0";
  const unit = new RegExp(`(?<=\\d)\\s?(${UNITS})(?![\\p{L}])`, "iu").exec(cleaned)?.[1]?.toLowerCase();
  return `${toNumber(number) * (unit ? (UNIT_FACTOR[unit] as number) : 1)}|${code}`;
}

/** Percentages, multipliers and currency amounts. Years, dates, times, ids and phone numbers are not claims. */
export function extractNumericTokens(normalizedText: string): NumericToken[] {
  const found: NumericToken[] = [];
  const scan = (pattern: RegExp, kind: "percent" | "multiplier" | "amount") => {
    for (const match of normalizedText.matchAll(pattern)) {
      const index = match.index as number;
      const lead = /^[+-]/.exec(match[0]);
      const raw = lead ? match[0].slice(1) : match[0];
      const start = index + (lead ? 1 : 0);
      if (found.some((t) => start < t.end && start + raw.length > t.start)) continue;
      found.push({ start, end: start + raw.length, raw: raw.trim(), canonical: canonical(kind, raw) });
    }
  };
  scan(AMOUNT_FIRST, "amount");
  scan(CURRENCY_FIRST, "amount");
  scan(PERCENT, "percent");
  scan(MULTIPLIER, "multiplier");
  return found.sort((a, b) => a.start - b.start);
}

export interface ClaimIndex {
  verified: Map<string, Claim>;
  pending: Map<string, Claim>;
}

export function indexClaims(register: ClaimRegister): ClaimIndex {
  const index: ClaimIndex = { verified: new Map(), pending: new Map() };
  for (const claim of register.claims) {
    for (const value of claim.values) {
      const tokens = extractNumericTokens(value);
      const key = tokens[0]?.canonical ?? value.trim().toLowerCase();
      (claim.status === "verified" ? index.verified : index.pending).set(key, claim);
    }
  }
  return index;
}
