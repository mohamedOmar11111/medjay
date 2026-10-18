// Text normalization for matching. Output positions map back to the ORIGINAL text, so findings
// point at what the user actually wrote (diacritics, tatweel and curly quotes included).
export interface Normalized {
  text: string;
  /** For each UTF-16 unit of `text`, the index in the original where its character started. */
  map: number[];
}

const ARABIC_INDIC_ZERO = 0x0660;
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0;

function mapChar(ch: string, code: number): string | null {
  if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) return String(code - ARABIC_INDIC_ZERO);
  if (code >= EASTERN_ARABIC_INDIC_ZERO && code <= EASTERN_ARABIC_INDIC_ZERO + 9) return String(code - EASTERN_ARABIC_INDIC_ZERO);
  if (code === 0x066a) return "%"; // Arabic percent sign
  if ((code >= 0x064b && code <= 0x065f) || code === 0x0670 || code === 0x0640) return null; // diacritics, dagger alef, tatweel
  if (code === 0x0623 || code === 0x0625 || code === 0x0622) return "ا"; // alef variants
  if (code === 0x0649) return "ي"; // alef maksura
  if (code === 0x2018 || code === 0x2019) return "'";
  if (code === 0x201c || code === 0x201d) return '"';
  if (code === 0x00a0) return " ";
  return ch;
}

export function normalize(original: string): Normalized {
  let text = "";
  const map: number[] = [];
  let index = 0;
  for (const ch of original) {
    const mapped = mapChar(ch, ch.codePointAt(0) as number);
    if (mapped !== null) {
      text += mapped;
      for (let i = 0; i < mapped.length; i += 1) map.push(index);
    }
    index += ch.length;
  }
  return { text, map };
}

/** Normalize a literal rule phrase the same way the text is normalized. */
export const normalizeText = (value: string): string => normalize(value).text;

/** Convert a [start, end) range in normalized text back to a range in the original text. */
export function toOriginalRange(original: string, normalized: Normalized, start: number, end: number): { index: number; length: number } {
  const first = normalized.map[start] ?? 0;
  const lastStart = normalized.map[Math.max(end - 1, start)] ?? first;
  const lastLength = String.fromCodePoint(original.codePointAt(lastStart) ?? 0x20).length;
  return { index: first, length: lastStart + lastLength - first };
}
