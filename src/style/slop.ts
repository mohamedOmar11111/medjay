// Deterministic anti-slop linter. No model calls: cheap, repeatable, testable. Runs on anything
// customer-facing (ad copy, posts, emails, WhatsApp drafts) before it can enter a plan.
import { extractNumericTokens, indexClaims, type ClaimRegister } from "./claims.js";
import { normalize, normalizeText, toOriginalRange, type Normalized } from "./normalize.js";
import { patternRules, phrasePattern, type Kind, type Pack, type Severity } from "./slop-rules.js";

export type { Kind, Pack, Severity };

export interface BannedPhrase {
  phrase: string;
  suggestion?: string;
}

export interface SlopOptions {
  /** Default: all packs. Workspaces derive theirs from config and languages. */
  packs?: readonly Pack[];
  extraBanned?: readonly BannedPhrase[];
  /** Matched text starting with one of these (case-insensitive) is not reported. */
  allow?: readonly string[];
  kind?: Kind;
  claims?: ClaimRegister | undefined;
  failOn?: Severity;
}

export interface SlopFinding {
  rule: string;
  severity: Severity;
  category: string;
  message: string;
  suggestion?: string;
  /** The matched text, exactly as written. */
  match: string;
  /** 0-based offset into the original text. */
  index: number;
  /** 1-based. */
  line: number;
  column: number;
}

export interface SlopReport {
  findings: SlopFinding[];
  counts: { error: number; warn: number };
  stats: { words: number; sentences: number };
  pass: boolean;
}

const ALL_PACKS: readonly Pack[] = ["protocol", "extended", "ar"];
const WORD = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;

const RULES = patternRules();

function position(original: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  for (let i = original.indexOf("\n"); i !== -1 && i < index; i = original.indexOf("\n", i + 1)) {
    line += 1;
    lastBreak = i;
  }
  return { line, column: index - lastBreak };
}

function sentenceLengths(text: string): number[] {
  return text
    .split(/[.!?؟…]+(?:\s+|$)|\n+/u)
    .map((s) => (s.match(WORD) ?? []).length)
    .filter((n) => n > 0);
}

export function lintText(original: string, options: SlopOptions = {}): SlopReport {
  const packs = new Set(options.packs ?? ALL_PACKS);
  const kind = options.kind ?? "general";
  const allow = (options.allow ?? []).map((a) => normalizeText(a).toLowerCase());
  const norm: Normalized = normalize(original);
  const findings: SlopFinding[] = [];

  const add = (
    rule: string,
    severity: Severity,
    category: string,
    message: string,
    suggestion: string | undefined,
    start: number,
    end: number,
  ) => {
    const range = toOriginalRange(original, norm, start, end);
    const { line, column } = position(original, range.index);
    findings.push({
      rule,
      severity,
      category,
      message,
      ...(suggestion ? { suggestion } : {}),
      match: original.slice(range.index, range.index + range.length),
      index: range.index,
      line,
      column,
    });
  };

  const allowed = (matched: string) => {
    const lower = matched.toLowerCase();
    return allow.some((a) => lower === a || lower.startsWith(a));
  };

  for (const rule of RULES) {
    if (!packs.has(rule.pack)) continue;
    rule.pattern.lastIndex = 0;
    for (const m of norm.text.matchAll(rule.pattern)) {
      if (allowed(m[0])) continue;
      add(rule.id, rule.severity, rule.category, rule.message, rule.suggestion, m.index as number, (m.index as number) + m[0].length);
    }
  }

  for (const banned of options.extraBanned ?? []) {
    const pattern = phrasePattern(banned.phrase);
    for (const m of norm.text.matchAll(pattern)) {
      add("brand.forbidden", "error", "brand", `"${banned.phrase}" is forbidden by this workspace's brand voice`, banned.suggestion, m.index as number, (m.index as number) + m[0].length);
    }
  }

  // ---- structural rules -------------------------------------------------------------------
  const words = (norm.text.match(WORD) ?? []).length;
  const sentences = sentenceLengths(norm.text);

  if (packs.has("extended")) {
    const triplets = [...norm.text.matchAll(/(?<![\p{L}\p{N}_])[\p{L}'-]+, [\p{L}'-]+,? and [\p{L}'-]+/gu)];
    if (triplets.length >= 3) {
      const first = triplets[0] as RegExpMatchArray;
      add("pattern.triplet", "warn", "structure", "repeated rule-of-three lists", "vary the shape of your lists", first.index as number, (first.index as number) + first[0].length);
    }
    const dashes = [...norm.text.matchAll(/—/gu)];
    if (words >= 50 && (dashes.length / words) * 100 > 1.5) {
      const first = dashes[0] as RegExpMatchArray;
      add("punct.em_dash", "warn", "structure", "heavy em-dash use", "use full stops or commas", first.index as number, (first.index as number) + 1);
    }
    if (sentences.length >= 5) {
      const mean = sentences.reduce((a, b) => a + b, 0) / sentences.length;
      const sd = Math.sqrt(sentences.reduce((a, b) => a + (b - mean) ** 2, 0) / sentences.length);
      if (mean > 0 && sd / mean < 0.3) {
        add("rhythm.uniform", "warn", "structure", "sentences are all about the same length", "break the rhythm: fragments, a long one, then a short one", 0, Math.min(1, norm.text.length));
      }
    }
  }

  if (packs.has("protocol")) {
    if (kind === "post") {
      const soft = /^\s*(?:(?:hello|hi|hey|good morning)\b|(?:excited|thrilled|delighted|proud|happy|pleased)\s+to\s+(?:announce|share|introduce))/iu.exec(norm.text);
      if (soft) add("opener.soft", "warn", "structure", "a post must not open with a greeting or a soft announcement", "open with an uncomfortable truth or a specific number", soft.index, soft.index + soft[0].length);
    }
    if (kind !== "ad") {
      const opener = /(?<=^|\n\s*\n)\s*(?:ever wondered|are you ready|looking for|want to|imagine (?:a world|if)|what if|did you know)\b/giu;
      for (const m of norm.text.matchAll(opener)) {
        add("opener.question", "warn", "structure", "stock rhetorical opener", "open with the fact", m.index as number, (m.index as number) + m[0].length);
      }
    }
  }

  // ---- claims -------------------------------------------------------------------------------
  if (options.claims) {
    const index = indexClaims(options.claims);
    for (const token of extractNumericTokens(norm.text)) {
      if (index.verified.has(token.canonical)) continue;
      const pending = index.pending.get(token.canonical);
      if (pending) {
        add("claims.pending", "error", "evidence", `${pending.id} is still pending verification; do not publish it`, "verify the claim or remove the number", token.start, token.end);
      } else {
        add("claims.unverified", "error", "evidence", "number is not in the claim register", "add it to context/claims.md as awaiting evidence and verify it, or remove it", token.start, token.end);
      }
    }
  }

  findings.sort((a, b) => a.index - b.index || a.rule.localeCompare(b.rule));
  const counts = { error: findings.filter((f) => f.severity === "error").length, warn: findings.filter((f) => f.severity === "warn").length };
  const failOn = options.failOn ?? "error";
  const pass = failOn === "warn" ? counts.error + counts.warn === 0 : counts.error === 0;
  return { findings, counts, stats: { words, sentences: sentences.length }, pass };
}
