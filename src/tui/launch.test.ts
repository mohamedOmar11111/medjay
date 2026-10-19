import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseInput, resolveInput } from "./commands.js";
import { spawnRunner } from "./runner.js";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "dist", "cli.js"); // built once by test/global-setup.ts
let root: string;
let ws: string;

async function viaRunner(input: string): Promise<{ code: number; text: string }> {
  const resolved = resolveInput(parseInput(input), ws);
  if (resolved.kind !== "cli") throw new Error(`"${input}" did not resolve to a command: ${JSON.stringify(resolved)}`);
  let text = "";
  const { code } = await spawnRunner(CLI)(resolved.argv, (t) => (text += t)).done;
  return { code, text };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-tui-"));
  ws = join(root, "ws");
  await exec(process.execPath, [CLI, "init", ws, "--id", "ws", "--currency", "SAR", "--business-type", "ecom"], { cwd: REPO });
  const drop = join(ws, "data", "imports");
  await mkdir(drop, { recursive: true });
  await copyFile(join(REPO, "fixtures", "etlaala-ksa", "data", "imports", "meta-ads-2026-10-10_16.csv"), join(drop, "meta-ads-2026-10-10_16.csv"));
}, 120_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the CLI refuses the app without a terminal", () => {
  it("`mdj tui` in a pipe says so and exits 1; plain `mdj` in a pipe prints the usage", async () => {
    const tui = await exec(process.execPath, [CLI, "tui"], { cwd: REPO }).then(
      () => ({ code: 0, stderr: "" }),
      (e: { code?: number; stderr?: string }) => ({ code: e.code ?? 1, stderr: e.stderr ?? "" }),
    );
    expect(tui.code).toBe(1);
    expect(tui.stderr).toMatch(/needs a terminal/);
    const bare = await exec(process.execPath, [CLI], { cwd: REPO }).then(
      (r) => r.stdout + r.stderr,
      (e: { stdout?: string; stderr?: string }) => (e.stdout ?? "") + (e.stderr ?? ""),
    );
    expect(bare).toMatch(/Usage: medjay/);
  });
});

describe("every slash command's argument list is accepted by the real CLI", () => {
  it("/scout reads the dropzone (writing the mapping on first run)", async () => {
    const r = await viaRunner("/scout");
    expect(r.code, r.text).toBe(0);
    expect(r.text).toMatch(/Auto-generated ingestion\.mappings\.yaml/);
    expect(r.text).toMatch(/Blended|ad data|Spend/i);
  });
  it("/diagnose, /ledger, /plan, /media list and /media explain", async () => {
    expect((await viaRunner("/diagnose 7")).code).toBe(0);
    const ledger = await viaRunner("/ledger");
    expect(ledger.code, ledger.text).toBe(0);
    expect(ledger.text).toMatch(/OK/);
    expect((await viaRunner("/plan")).text).toMatch(/no plans/);
    expect((await viaRunner("/media list")).text).toMatch(/72h-guard/);
    expect((await viaRunner("/media explain fair-test")).text).toMatch(/fair-test/);
  });
  it("/simulate passes its options through (and says plainly when unit economics are missing)", async () => {
    const r = await viaRunner("/simulate scale=50 seed=7");
    expect(r.text).not.toMatch(/unknown option|too many arguments/);
  });
  it("a plain task reaches `mdj run` as one task after `--`, even when it looks like a flag", async () => {
    const r = await viaRunner("--help me understand spend");
    expect(r.text).not.toMatch(/unknown option|too many arguments|Usage:/);
    expect(r.code).not.toBe(0); // no model credentials in the test workspace: it must fail cleanly, not hang
  });
});
