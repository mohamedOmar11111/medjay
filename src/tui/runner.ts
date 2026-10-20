// Runs an `mdj` command as a child process and streams its output. The TUI is a front end: every
// action goes through the same CLI, the same Shield and the same ledger as typing the command, and a
// child has no stdin (so nothing can sit waiting for a keystroke the TUI would not forward) unless one
// value is passed on purpose for a single command: a pasted key for `auth set`.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RunHandle {
  done: Promise<{ code: number }>;
  cancel: () => void;
}

export interface RunOptions {
  /** One value handed to the child on stdin, then closed. Used only to give `auth set` a pasted key without putting it on a command line. */
  stdin?: string;
}

export type Runner = (argv: string[], onChunk: (text: string, stream: "out" | "err") => void, options?: RunOptions) => RunHandle;

export function spawnRunner(cliPath: string, nodePath: string = process.execPath, nodeArgs: string[] = []): Runner {
  return (argv, onChunk, options) => {
    const child = spawn(nodePath, [...nodeArgs, cliPath, ...argv], { stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, windowsHide: true });
    if (options?.stdin !== undefined) child.stdin?.end(options.stdin);
    const pipe = (stream: NodeJS.ReadableStream, tag: "out" | "err") => {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (buf: Buffer) => onChunk(decoder.write(buf), tag));
      stream.on("end", () => {
        const rest = decoder.end();
        if (rest) onChunk(rest, tag);
      });
    };
    pipe(child.stdout!, "out");
    pipe(child.stderr!, "err");
    const done = new Promise<{ code: number }>((resolve) => {
      child.on("error", (error) => {
        onChunk(`could not start: ${error.message}\n`, "err");
        resolve({ code: 1 });
      });
      child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 130 : 1) }));
    });
    return { done, cancel: () => void child.kill() };
  };
}
