// A conservative token estimate, not a tokenizer. It over-counts on purpose: a budget that is
// slightly too tight costs a little compaction, while one that is too loose costs a failed call.
// Latin text is charged at 3.5 characters per token (real English is nearer 4); everything else,
// Arabic included, at 1.6, because non-Latin scripts tokenize far less efficiently. Provider-reported
// usage replaces these numbers in telemetry; this only guards the prompt budget.
const LATIN_CHARS_PER_TOKEN = 3.5;
const OTHER_CHARS_PER_TOKEN = 1.6;

const costOf = (codePoint: number) => (codePoint < 0x80 ? 1 / LATIN_CHARS_PER_TOKEN : 1 / OTHER_CHARS_PER_TOKEN);

export function estimateTokens(text: string): number {
  let total = 0;
  for (const ch of text) total += costOf(ch.codePointAt(0) as number);
  return Math.ceil(total);
}

/** Cut to the longest prefix that fits, on a whole-character boundary. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: "", truncated: text.length > 0 || true };
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let total = 0;
  let end = 0;
  for (const ch of text) {
    total += costOf(ch.codePointAt(0) as number);
    if (total > maxTokens) break;
    end += ch.length;
  }
  return { text: text.slice(0, end), truncated: true };
}
