import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnRunner } from "./runner.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-runner-"));
  await writeFile(join(dir, "echo.mjs"), 'process.stdout.write("out:" + process.argv.slice(2).join("|") + "\\n"); process.stderr.write("warn\\n"); process.exit(Number(process.env.EXIT ?? 0));');
  await writeFile(join(dir, "hang.mjs"), "setInterval(() => {}, 1000);");
  await writeFile(join(dir, "stdin.mjs"), 'process.stdin.on("data", () => {}); process.stdin.on("end", () => { process.stdout.write("stdin-closed\\n"); });');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("spawnRunner", () => {
  it("passes arguments verbatim (no shell), streams both outputs and reports the exit code", async () => {
    const chunks: [string, string][] = [];
    const handle = spawnRunner(join(dir, "echo.mjs"))(["a b", "$(x)", "--flag"], (t, s) => chunks.push([s, t]));
    expect(await handle.done).toEqual({ code: 0 });
    expect(chunks).toContainEqual(["out", "out:a b|$(x)|--flag\n"]);
    expect(chunks).toContainEqual(["err", "warn\n"]);
  });

  it("gives the child no stdin, so an interactive prompt ends instead of hanging", async () => {
    let text = "";
    const handle = spawnRunner(join(dir, "stdin.mjs"))([], (t) => (text += t));
    await handle.done;
    expect(text).toContain("stdin-closed");
  });

  it("cancels a running child", async () => {
    const handle = spawnRunner(join(dir, "hang.mjs"))([], () => undefined);
    setTimeout(() => handle.cancel(), 150);
    const { code } = await handle.done;
    expect(code).not.toBe(0);
  });

  it("reports a program that cannot start", async () => {
    let text = "";
    const handle = spawnRunner(join(dir, "echo.mjs"), join(dir, "no-such-node"))([], (t) => (text += t));
    expect(await handle.done).toEqual({ code: 1 });
    expect(text).toMatch(/could not start/);
  });
});
