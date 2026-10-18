// Model-facing anti-slop guidance, generated from the same rule data the linter uses.
import {
  ARABIC_CLICHES,
  ARABIC_DIALECT,
  ARABIC_INFLATION,
  ARABIC_TRANSITIONS,
  PROTOCOL_COPULA,
  PROTOCOL_POLITE,
  PROTOCOL_TRANSITIONS,
  PROTOCOL_VOCAB,
} from "./slop-rules.js";
import type { BannedPhrase } from "./slop.js";

export function slopPromptRules(options: { extraBanned?: readonly BannedPhrase[] } = {}): string[] {
  const lines: string[] = [
    "Write like a person who knows the numbers. No filler, no sales gloss.",
    `Never use these words (use the replacement): ${PROTOCOL_VOCAB.map((v) => (v.use ? `${v.shown} -> ${v.use}` : v.shown)).join("; ")}.`,
    `Do not open sentences with ${PROTOCOL_TRANSITIONS.join(", ")}. Use "and", "also", or nothing.`,
    `Use "is" or "has", not ${PROTOCOL_COPULA.map((c) => `"${c}"`).join(" or ")}.`,
    `No politeness filler (${PROTOCOL_POLITE.map((p) => `"${p}"`).join(", ")}). State the fact.`,
    "Never call something game-changing, revolutionary or world-class. Show the exact result, number or ROI.",
    'Replace "experts believe" and "studies show" with a named source, a date or a data point.',
    'Avoid false ranges ("from villas to flights"). List the specific top three instead.',
    "Vary sentence length. Fragments are fine. Lead with the punchline.",
    "Use only numbers that appear in the claim register. If a number is not there, leave it out and flag it as awaiting evidence.",
    "Arabic: write in the client's dialect as native copy, not translation.",
    `Arabic: never open or link sentences with: ${ARABIC_TRANSITIONS.join("، ")}.`,
    `Arabic: never use these translated cliches: ${ARABIC_CLICHES.map((c) => c.shown).join("، ")}.`,
    `Arabic: no inflation (${ARABIC_INFLATION.join("، ")}); say the concrete offer: price, dates, what is included.`,
    `Arabic: use one dialect per text block. Egyptian markers (${ARABIC_DIALECT.egyptian.join("، ")}) and Khaleeji markers (${ARABIC_DIALECT.khaleeji.join("، ")}) must not appear together.`,
  ];
  const extra = options.extraBanned ?? [];
  if (extra.length > 0) {
    lines.push(`This brand also forbids: ${extra.map((b) => (b.suggestion ? `"${b.phrase}" (${b.suggestion})` : `"${b.phrase}"`)).join("; ")}.`);
  }
  return lines;
}
