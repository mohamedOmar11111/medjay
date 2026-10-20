/** Terminals add bracketed-paste markers and Ctrl+V bytes around a paste; none of that belongs in a key. */
export function cleanPastedSecret(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\u001b\[20[01]~/g, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

// Reads a secret without echoing it: piped stdin when not a terminal, hidden prompt otherwise.
export async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  process.stderr.write(promptText);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (settle: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      settle();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(cleanPastedSecret(value)));
        if (char === "\u0003") return finish(() => reject(new Error("cancelled")));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}
