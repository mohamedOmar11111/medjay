// A small line diff for comparing two versions of a draft. Longest common subsequence over lines; the
// drafts are short (capped at 100 KB), so the simple method is plenty.
export interface LineDiff {
  added: number;
  removed: number;
  /** Changed lines marked "+ " and "- ", with up to two unchanged lines around each change. */
  text: string;
}

export function diffLines(a: string, b: string): LineDiff {
  const x = a.split("\n");
  const y = b.split("\n");
  const table: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i]![j] = x[i] === y[j] ? (table[i + 1]![j + 1] as number) + 1 : Math.max(table[i + 1]![j] as number, table[i]![j + 1] as number);
    }
  }
  const marked: { sign: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      marked.push({ sign: " ", line: x[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] as number) >= (table[i]![j + 1] as number)) {
      marked.push({ sign: "-", line: x[i] as string });
      i += 1;
    } else {
      marked.push({ sign: "+", line: y[j] as string });
      j += 1;
    }
  }
  for (; i < x.length; i += 1) marked.push({ sign: "-", line: x[i] as string });
  for (; j < y.length; j += 1) marked.push({ sign: "+", line: y[j] as string });

  const keep = new Set<number>();
  marked.forEach((m, at) => {
    if (m.sign === " ") return;
    for (let k = Math.max(0, at - 2); k <= Math.min(marked.length - 1, at + 2); k += 1) keep.add(k);
  });
  const lines: string[] = [];
  let last = -2;
  marked.forEach((m, at) => {
    if (!keep.has(at)) return;
    if (at > last + 1 && lines.length > 0) lines.push("...");
    lines.push(`${m.sign} ${m.line}`);
    last = at;
  });
  return { added: marked.filter((m) => m.sign === "+").length, removed: marked.filter((m) => m.sign === "-").length, text: lines.join("\n") };
}
