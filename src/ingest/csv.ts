// A small RFC 4180 reader: quoted cells, doubled quotes, embedded newlines, BOM, CRLF.
// Platform exports are untrusted input, so an unterminated quote is an error, not a silent merge.
export function parseCsv(text: string, delimiter = ","): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let touched = false; // the current row has any content, so a blank line is skipped

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    if (touched || row.length > 0) {
      endCell();
      rows.push(row);
    }
    row = [];
    touched = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      touched = true;
    } else if (ch === delimiter) {
      touched = true;
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      endRow();
    } else {
      cell += ch;
      touched = true;
    }
  }
  if (quoted) throw new Error("unterminated quote in CSV");
  endRow();
  return rows;
}
