// Turns arbitrary chunks of text into whole lines (a chunk can end in the middle of a line).
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; end: () => void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        onLine(buffer.slice(0, at).replace(/\r$/, ""));
        buffer = buffer.slice(at + 1);
      }
    },
    end() {
      if (buffer !== "") onLine(buffer.replace(/\r$/, ""));
      buffer = "";
    },
  };
}
