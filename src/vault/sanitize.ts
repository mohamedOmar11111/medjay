// Ring 0 sanitizer for anything that leaves a client workspace for the global vault. Two layers:
//   1. sanitizeText replaces what is mechanically recognizable as specific: urls, emails, phone numbers,
//      currency amounts and platform ids.
//   2. findLeaks refuses text that still contains a word taken from the workspace name, the brand or the
//      campaign list. Replacement cannot catch a client name, so a hit is a FAILURE, not an edit.
export interface Sanitized {
  text: string;
  removed: Record<string, number>;
}

const DIGIT = "[\\d\\u0660-\\u0669\\u06F0-\\u06F9]";
const NUMBER = `${DIGIT}[${"\\d"}\\u0660-\\u0669\\u06F0-\\u06F9,\\u066C.\\u066B]*`;
const CODES = "(?:SAR|AED|EGP|QAR|USD|EUR|GBP|KWD|BHD|OMR|JOD|JPY|KRW)";
const WORDS = "(?:ريال|درهم|دينار|جنيه|دولار)";

const RULES: { kind: string; re: RegExp; replace: string | ((m: string, ...g: string[]) => string) }[] = [
  { kind: "url", re: /\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, replace: "[url]" },
  { kind: "email", re: /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g, replace: "[email]" },
  { kind: "phone", re: new RegExp(`\\+\\s?${DIGIT}[${"\\d"}\\u0660-\\u0669\\u06F0-\\u06F9\\s().-]{6,}${DIGIT}`, "g"), replace: "[phone]" },
  { kind: "amount", re: new RegExp(`\\b${CODES}\\s?${NUMBER}|${NUMBER}\\s?(?:${CODES}\\b|${WORDS})|[$€£﷼]\\s?${NUMBER}`, "g"), replace: "[amount]" },
  { kind: "id", re: /\b(?:gclid|fbclid|wbraid|gbraid)=[^\s&)]+/gi, replace: (m) => `${m.split("=")[0]}=[id]` },
  { kind: "id", re: /\bact_\d+\b/gi, replace: "[id]" },
  { kind: "id", re: new RegExp(`\\b${DIGIT}{8,}\\b`, "g"), replace: "[id]" },
];

export function sanitizeText(input: string): Sanitized {
  let text = input;
  const removed: Record<string, number> = {};
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      removed[rule.kind] = (removed[rule.kind] ?? 0) + 1;
      return typeof rule.replace === "string" ? rule.replace : rule.replace(args[0] as string);
    });
  }
  return { text, removed };
}

const words = (text: string): string[] => text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export interface LeakContext {
  /** The workspace id. */
  workspace: string;
  /** Client or business names from workspace.yaml. */
  names: string[];
  /** Brand names and the title from context/brand-voice.md. */
  brand: string[];
  /** Campaign and ad set names seen in the ingested data. */
  campaigns: string[];
  /** The tactic's own market, vertical, season and language tags: public categories, not leaks. */
  publicTags: string[];
}

/**
 * Words that identify this workspace: from its id, names, brand and campaigns. Short words and pure
 * numbers are skipped (too common to mean anything), and so are the tactic's own public tags.
 */
export function forbiddenTokens(ctx: LeakContext): string[] {
  const exempt = new Set(ctx.publicTags.flatMap(words));
  const out = new Set<string>();
  const add = (source: string[], min: number) => {
    for (const w of source.flatMap(words)) if (w.length >= min && !/^\p{N}+$/u.test(w) && !exempt.has(w)) out.add(w);
  };
  add([ctx.workspace, ...ctx.names, ...ctx.brand], 3);
  add(ctx.campaigns, 4);
  return [...out].sort();
}

/** The forbidden tokens that appear in `text` as whole words, in order of first appearance. */
export function findLeaks(text: string, tokens: readonly string[]): string[] {
  const wanted = new Set(tokens);
  const found: string[] = [];
  for (const w of words(text)) if (wanted.has(w) && !found.includes(w)) found.push(w);
  return found;
}
