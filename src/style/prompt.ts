// Model-facing anti-slop guidance, generated from the same rule data the linter uses.
import { PROTOCOL_COPULA, PROTOCOL_POLITE, PROTOCOL_TRANSITIONS, PROTOCOL_VOCAB } from "./slop-rules.js";
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
    "Arabic: write in the client's dialect as native copy, not translation; avoid stock phrases and stiff formal transitions.",
  ];
  const extra = options.extraBanned ?? [];
  if (extra.length > 0) {
    lines.push(`This brand also forbids: ${extra.map((b) => (b.suggestion ? `"${b.phrase}" (${b.suggestion})` : `"${b.phrase}"`)).join("; ")}.`);
  }
  return lines;
}
