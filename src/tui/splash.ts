// The block-letter wordmark shown at the top of a session, and the one-line banner for the header.
const LETTERS: Record<string, string[]> = {
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  J: ["  ███", "    █", "    █", "█   █", " ███ "],
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  Y: ["█   █", " █ █ ", "  █  ", "  █  ", "  █  "],
};

export const WORDMARK: string[] = Array.from({ length: 5 }, (_, row) => [..."MEDJAY"].map((ch) => LETTERS[ch]![row]!).join(" "));

export const TAGLINE = "SHIELD + SWORD  ·  open growth-agent harness";
export const COMPACT_BANNER = "▌MEDJAY";
