// Rule data for the anti-slop linter. Packs:
//   protocol  : the owner's Anti-AI Writing Protocol (01_Context_Vault/Methodology), plus the
//               content-engine rule list (unlock). Errors, because the protocol says 100% enforcement.
//   extended  : other very common AI-isms. Warnings, because they are judgment calls.
//   ar        : a SMALL starter list of Arabic marketing cliches and translation-ese transitions.
//               Warnings only, and every finding says it needs native review: it has not been
//               validated by a native copywriter yet.
// The same data feeds the linter and the model-facing prompt guidance, so they cannot drift.
import { normalizeText } from "./normalize.js";

export type Pack = "protocol" | "extended" | "ar";
export type Severity = "error" | "warn";
export type Kind = "general" | "post" | "ad" | "message";

export interface PatternRule {
  id: string;
  pack: Pack;
  severity: Severity;
  category: string;
  pattern: RegExp;
  message: string;
  suggestion?: string;
}

/** Whole-word match with Unicode-aware boundaries (works for Latin and Arabic). */
export const word = (source: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, "giu");

/** Sentence-initial match: start of text, after . ! ? or a line break. */
const sentenceStart = (source: string): RegExp =>
  new RegExp(`(?<=^|[.!?…]["')\\]]*\\s+|\\n\\s*)(?:${source})(?![\\p{L}\\p{N}_])`, "giu");

export interface VocabEntry {
  id: string;
  /** Words as shown to the model. */
  shown: string;
  source: string;
  use?: string;
}

/** The protocol's blacklist with its replacements (the protocol lists 8 replacements for 10 words). */
export const PROTOCOL_VOCAB: readonly VocabEntry[] = [
  { id: "vocab.leverage", shown: "leverage", source: "leverag(?:e|es|ed|ing)", use: "use" },
  { id: "vocab.utilize", shown: "utilize", source: "utili[sz](?:e|es|ed|ing|ation)", use: "use" },
  { id: "vocab.seamless", shown: "seamless", source: "seamless(?:ly)?", use: "smooth, or say what actually works" },
  { id: "vocab.robust", shown: "robust", source: "robust(?:ly|ness)?", use: "strong" },
  { id: "vocab.transformative", shown: "transformative", source: "transformative", use: "change, or give the result" },
  { id: "vocab.pivotal", shown: "pivotal", source: "pivotal", use: "main" },
  { id: "vocab.comprehensive", shown: "comprehensive", source: "comprehensive(?:ly)?", use: "drop it, or say what is covered" },
  { id: "vocab.embark", shown: "embark", source: "embark(?:s|ed|ing)?", use: "start" },
  { id: "vocab.delve", shown: "delve", source: "delv(?:e|es|ed|ing)", use: "look at" },
  { id: "vocab.navigate", shown: "navigate", source: "navigat(?:e|es|ed|ing)", use: "go through" },
  { id: "vocab.unlock", shown: "unlock", source: "unlock(?:s|ed|ing)?", use: "open, get, or name the thing" },
];

export const PROTOCOL_TRANSITIONS = ["Moreover", "Furthermore", "In conclusion"] as const;
export const PROTOCOL_POLITE = ["Certainly!", "I hope this helps", "Let's explore", "Great question", "I'd be happy to"] as const;
export const PROTOCOL_COPULA = ["serves as", "boasts"] as const;

/** Owner-reviewed Arabic bans (errors). Shown to the model exactly as written. */
export const ARABIC_TRANSITIONS: readonly string[] = [
  "في عالمنا اليوم",
  "في عصرنا الحالي",
  "في ظل التطور المتسارع",
  "علاوة على ذلك",
  "بالإضافة إلى ذلك",
  "ومن الجدير بالذكر",
  "في الختام",
];
/** Translated clichés; each is a regex source over NORMALIZED text, with its display form. */
export const ARABIC_CLICHES: readonly { shown: string; source: string }[] = [
  { shown: "أطلق العنان", source: "[اينت]طلق(?:ي|وا|ون)?\\s+العنان|اطلاق\\s+العنان" },
  // "ب" attaches to the next word (بتجربتك), so the rule consumes that word to satisfy the word boundary.
  { shown: "ارتقِ بـ", source: "ارتق(?:ي|وا)?\\s+ب\\p{L}*" },
  { shown: "سواء كنت تبحث عن", source: "سواء\\s+كنت(?:م|ي)?\\s+(?:تبحث|تبحثون|تبحثين)\\s+عن" },
];
/** Travel and marketing inflation: an error unless the workspace allows it for a concrete offer. */
export const ARABIC_INFLATION: readonly string[] = ["رحلة لا تُنسى", "تجربة استثنائية لا مثيل لها"];
/** Earlier starter list: still warnings, still awaiting native review. */
export const ARABIC_STARTER: readonly string[] = ["في عالم اليوم", "تجربة فريدة من نوعها", "لا شك أن"];
/** Vocabulary that marks a dialect. Mixing the two in one text block is flagged. */
export const ARABIC_DIALECT = {
  egyptian: ["دلوقتي", "دلوقت", "عشان", "كدا", "كده"],
  khaleeji: ["الحين", "وايد", "عشانك"],
} as const;

/** Arabic match with an optional attached conjunction prefix (و or ف), which is part of the match. */
export const arWord = (source: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])[وف]?(?:${source})(?![\\p{L}\\p{N}_])`, "giu");

export const EXTENDED_WORDS: readonly string[] = [
  "elevat(?:e|es|ed|ing)",
  "unleash(?:es|ed|ing)?",
  "tapestry",
  "holistic(?:ally)?",
  "synerg(?:y|ies)",
  "streamlin(?:e|es|ed|ing)",
  "empower(?:s|ed|ing|ment)?",
  "supercharg(?:e|es|ed|ing)",
  "revolutioni[sz](?:e|es|ed|ing)",
  "next[- ]level",
  "cutting[- ]edge",
  "state[- ]of[- ]the[- ]art",
  "groundbreaking",
  "ever[- ]evolving",
];
export const EXTENDED_PHRASES: readonly string[] = [
  "in today'?s (?:fast[- ]paced|digital|ever[- ]changing|modern) world",
  "it'?s worth noting",
  "dive into",
  "deep dive",
  "a testament to",
];
export const EXTENDED_TRANSITIONS: readonly string[] = ["Additionally", "In addition", "In summary", "To summarize", "That being said", "With that said"];

export const phraseSource = (phrase: string) =>
  normalizeText(phrase)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

export const phrasePattern = (phrase: string): RegExp => word(phraseSource(phrase));

export function patternRules(): PatternRule[] {
  const rules: PatternRule[] = [];

  for (const entry of PROTOCOL_VOCAB) {
    rules.push({
      id: entry.id,
      pack: "protocol",
      severity: "error",
      category: "vocabulary",
      pattern: word(entry.source),
      message: `"${entry.shown}" is on the Anti-AI vocabulary blacklist`,
      ...(entry.use ? { suggestion: `use: ${entry.use}` } : {}),
    });
  }

  rules.push(
    {
      id: "transition.kill",
      pack: "protocol",
      severity: "error",
      category: "structure",
      pattern: sentenceStart(PROTOCOL_TRANSITIONS.map((t) => t.toLowerCase().replace(/ /g, "\\s+")).join("|")),
      message: "stiff sentence-opening transition",
      suggestion: 'drop it, or use "and" / "also"',
    },
    {
      id: "copula.fancy",
      pack: "protocol",
      severity: "error",
      category: "structure",
      pattern: word("serv(?:es|e|ing)\\s+as|boast(?:s|ed|ing)?|stands?\\s+as"),
      message: "fancy copula",
      suggestion: 'use "is" or "has"',
    },
    {
      id: "tone.polite",
      pack: "protocol",
      severity: "error",
      category: "tone",
      pattern: new RegExp(
        "(?<![\\p{L}\\p{N}_])(?:certainly!|absolutely!|of course!|i hope this helps|let'?s explore|great question|i'?d be happy to)",
        "giu",
      ),
      message: "politeness filler",
      suggestion: "state the fact; no preamble",
    },
    {
      id: "inflation.word",
      pack: "protocol",
      severity: "error",
      category: "evidence",
      pattern: word("game[- ]chang(?:er|ers|ing)|revolutionary|world[- ]class|best[- ]in[- ]class|unparalleled|unrivall?ed"),
      message: "inflation word: it tells the reader instead of showing them",
      suggestion: "show the exact result, number or ROI instead",
    },
    {
      id: "authority.vague",
      pack: "protocol",
      severity: "error",
      category: "evidence",
      pattern: word(
        "experts\\s+(?:believe|say|agree)|industry\\s+experts|studies\\s+(?:show|suggest|have\\s+shown)|research\\s+(?:shows|suggests)|many\\s+(?:believe|people\\s+say)|it\\s+is\\s+(?:widely|well)\\s+(?:known|accepted)",
      ),
      message: "unattributed authority",
      suggestion: "name the source, the date or the data point",
    },
    {
      id: "range.false",
      pack: "protocol",
      severity: "warn",
      category: "evidence",
      pattern: /(?<![\p{L}\p{N}_])from\s+(?!\d)[\p{L}'-]+(?:\s+[\p{L}'-]+)?\s+to\s+(?!\d)[\p{L}'-]+/giu,
      message: "possible false range",
      suggestion: "list the specific top 3 items instead",
    },
  );

  rules.push(
    {
      id: "ai.vocab",
      pack: "extended",
      severity: "warn",
      category: "vocabulary",
      pattern: word(EXTENDED_WORDS.join("|")),
      message: "common AI-ism",
      suggestion: "say the plain thing",
    },
    {
      id: "ai.phrase",
      pack: "extended",
      severity: "warn",
      category: "vocabulary",
      pattern: word(EXTENDED_PHRASES.join("|")),
      message: "common AI filler phrase",
      suggestion: "cut it",
    },
    {
      id: "ai.transition",
      pack: "extended",
      severity: "warn",
      category: "structure",
      pattern: sentenceStart(EXTENDED_TRANSITIONS.map((t) => t.toLowerCase().replace(/ /g, "\\s+")).join("|")),
      message: "stiff sentence-opening transition",
      suggestion: 'drop it, or use "and" / "also"',
    },
    {
      id: "pattern.not_just",
      pack: "extended",
      severity: "warn",
      category: "structure",
      pattern: /(?<![\p{L}\p{N}_])(?:not\s+(?:just|only|merely)\b[^.!?\n]{0,80}\bbut(?:\s+also)?\b|(?:it'?s|this\s+is)\s+not\s+about\b[^.!?\n]{1,60}[,;]\s*(?:it'?s|this\s+is)\s+about\b)/giu,
      message: '"not just X, but Y" is a stock AI contrast',
      suggestion: "state the claim directly",
    },
  );

  // A leading "و" on a listed phrase is the conjunction; arWord already allows it on any phrase.
  const base = (phrase: string) => phrase.replace(/^و(?=من )/u, "");
  rules.push(
    {
      id: "ar.transition",
      pack: "ar",
      severity: "error",
      category: "structure",
      pattern: arWord(ARABIC_TRANSITIONS.map((p) => phraseSource(base(p))).join("|")),
      message: "banned Arabic AI opening or transition (owner-reviewed list)",
      suggestion: "cut it and start with the fact",
    },
    {
      id: "ar.cliche",
      pack: "ar",
      severity: "error",
      category: "vocabulary",
      pattern: arWord(ARABIC_CLICHES.map((c) => c.source).join("|")),
      message: "banned translated cliche (owner-reviewed list)",
      suggestion: "say the plain thing in the client's dialect",
    },
    {
      id: "ar.inflation",
      pack: "ar",
      severity: "error",
      category: "evidence",
      pattern: arWord(ARABIC_INFLATION.map(phraseSource).join("|")),
      message: "travel and marketing inflation: it tells the reader instead of showing them",
      suggestion: "state the concrete offer: price, dates, what is included (or allow it for an offer you can back)",
    },
    {
      id: "ar.starter",
      pack: "ar",
      severity: "warn",
      category: "vocabulary",
      pattern: arWord(ARABIC_STARTER.map(phraseSource).join("|")),
      message: "Arabic cliche from the starter list; needs native review before you rely on this finding",
      suggestion: "say the concrete thing in the client's dialect",
    },
  );

  return rules;
}
