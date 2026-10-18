// Redaction before a prompt is assembled: phone numbers, emails and provider-key-shaped secrets
// become stable placeholders ([PHONE_1], [EMAIL_1], [REDACTED_SECRET]). One Redactor lives for a
// whole run, so the same number is the same placeholder in every step and the model can still say
// "the lead from [PHONE_2]" without ever seeing the number. The mapping is in memory only and is
// never exposed. Placeholders cannot be reversed.
//
// Deliberately narrow, to avoid eating ids and amounts: a phone number needs a leading +, 00, or a
// local 0 followed by 9 or 10 digits. A long digit run next to a space-separated number can be
// swallowed with it (a known limit of matching numbers written with spaces).
import { redactSecretValues } from "../../shield/secrets.js";
import { normalize, toOriginalRange } from "../../style/normalize.js";

export interface RedactionCounts {
  phone: number;
  email: number;
  secret: number;
}

const BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}_+./-])";
const BOUNDARY_AFTER = "(?![\\p{L}\\p{N}_])";

const EMAIL = /(?<![\p{L}\p{N}_.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\p{L}\p{N}_])/gu;
const PHONE_PATTERNS: { pattern: RegExp; min: number; max: number; strip: RegExp }[] = [
  { pattern: new RegExp(`${BOUNDARY_BEFORE}\\+\\d[\\d\\s().-]{5,18}\\d${BOUNDARY_AFTER}`, "gu"), min: 8, max: 15, strip: /^\+/ },
  { pattern: new RegExp(`${BOUNDARY_BEFORE}00\\d[\\d\\s.-]{5,16}\\d${BOUNDARY_AFTER}`, "gu"), min: 8, max: 15, strip: /^00/ },
  { pattern: new RegExp(`${BOUNDARY_BEFORE}0\\d{9,10}${BOUNDARY_AFTER}`, "gu"), min: 10, max: 11, strip: /^$/ },
];

interface Hit {
  start: number;
  end: number;
  kind: "phone" | "email";
  key: string;
}

export class Redactor {
  private readonly phones = new Map<string, number>();
  private readonly emails = new Map<string, number>();
  private readonly total: RedactionCounts = { phone: 0, email: 0, secret: 0 };
  private lastPhone = 0;
  private lastEmail = 0;

  redact(original: string): { text: string } {
    const secrets = redactSecretValues(original);
    this.total.secret += secrets.count;
    const source = secrets.text;
    const norm = normalize(source);

    const hits: Hit[] = [];
    const overlaps = (start: number, end: number) => hits.some((h) => start < h.end && end > h.start);
    for (const m of norm.text.matchAll(EMAIL)) {
      const start = m.index as number;
      hits.push({ start, end: start + m[0].length, kind: "email", key: m[0].toLowerCase() });
    }
    for (const { pattern, min, max, strip } of PHONE_PATTERNS) {
      for (const m of norm.text.matchAll(pattern)) {
        const start = m.index as number;
        const end = start + m[0].length;
        const digits = m[0].replace(/\D/g, "");
        const significant = m[0].replace(strip, "").replace(/\D/g, "");
        if (digits.length < min || digits.length > max || overlaps(start, end)) continue;
        hits.push({ start, end, kind: "phone", key: significant });
      }
    }
    if (hits.length === 0) return { text: source };

    hits.sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0;
    for (const hit of hits) {
      const range = toOriginalRange(source, norm, hit.start, hit.end);
      out += source.slice(cursor, range.index) + this.placeholder(hit);
      cursor = range.index + range.length;
    }
    return { text: out + source.slice(cursor) };
  }

  /**
   * After a restart (resume), saved text already holds placeholders like [PHONE_2]. Continue the
   * numbering after the highest one seen so a new value never reuses an old placeholder.
   */
  continueFrom(savedTexts: readonly string[]): void {
    for (const text of savedTexts) {
      for (const m of text.matchAll(/\[(PHONE|EMAIL)_(\d+)\]/g)) {
        const n = Number(m[2]);
        if (m[1] === "PHONE") this.lastPhone = Math.max(this.lastPhone, n);
        else this.lastEmail = Math.max(this.lastEmail, n);
      }
    }
  }

  /** Counts of everything replaced so far (a repeated value counts each time). Never the values. */
  counts(): RedactionCounts {
    return { ...this.total };
  }

  private placeholder(hit: Hit): string {
    const map = hit.kind === "phone" ? this.phones : this.emails;
    let index = map.get(hit.key);
    if (index === undefined) {
      index = hit.kind === "phone" ? ++this.lastPhone : ++this.lastEmail;
      map.set(hit.key, index);
    }
    this.total[hit.kind] += 1;
    return `[${hit.kind === "phone" ? "PHONE" : "EMAIL"}_${index}]`;
  }
}
