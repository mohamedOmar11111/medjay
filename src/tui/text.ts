// Pure text helpers for the feed: wrapping and scroll windows.

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const indent = Math.min(/^ */.exec(line)![0].length, Math.floor(width / 2));
  const pad = " ".repeat(indent);
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.slice(0, width + 1).lastIndexOf(" ");
    const at = cut > indent ? cut : width;
    out.push(rest.slice(0, at).trimEnd());
    rest = pad + rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

/** Wrap text to a width, breaking at spaces, keeping indentation and blank lines. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  return text.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => wrapLine(line, w));
}

export interface Window {
  lines: string[];
  /** How many lines back from the newest the window sits (0 = following the newest output). */
  offset: number;
  /** Lines hidden above the window. */
  more: number;
}

/** The last `height` lines, scrolled back by `offset` (clamped). */
export function lastWindow(lines: string[], height: number, offset: number): Window {
  const h = Math.max(1, Math.floor(height));
  const maxOffset = Math.max(0, lines.length - h);
  const off = Math.min(Math.max(0, offset), maxOffset);
  const end = lines.length - off;
  const start = Math.max(0, end - h);
  return { lines: lines.slice(start, end), offset: off, more: start };
}
