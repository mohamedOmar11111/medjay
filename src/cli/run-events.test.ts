import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { parseEventLine } from "../run-events.js";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "dist", "cli.js"); // built once by test/global-setup.ts
let root: string;
let ws: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd: REPO, timeout: 150_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-events-"));
  ws = join(root, "ws");
  await exec(process.execPath, [CLI, "init", ws, "--id", "ev", "--currency", "SAR", "--business-type", "ecom"], { cwd: REPO });
  // a model that cannot be reached, so the run fails the same way on every machine, with no key and no network
  const file = join(ws, "workspace.yaml");
  const doc = parse(await readFile(file, "utf8")) as { models: { slots: Record<string, { primary: Record<string, unknown> }> } };
  doc.models.slots.reasoning!.primary = { provider: "ollama", model: "none", base_url: "http://127.0.0.1:9/v1" };
  await writeFile(file, stringify(doc));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj run --events", () => {
  it("writes only valid JSON event lines to stdout, ending with run.finished", async () => {
    const r = await mdj("run", "--events", "--workspace", ws, "--", "hello");
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const events = lines.map((l) => parseEventLine(l));
    expect(events.every((e) => e !== null)).toBe(true);
    expect(events[0]).toMatchObject({ type: "run.started", slot: "reasoning" });
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "run.finished", status: "failed" });
    expect((last as { error?: { kind: string } }).error?.kind).toBe("connection");
    expect(r.code).toBe(1);
  });

  it("mdj resume can decline a waiting call: --deny-tool exists, and allowing and declining together is refused", async () => {
    const help = await mdj("resume", "--help");
    expect(help.stdout).toContain("--deny-tool <call_id>");
    const both = await mdj("resume", "run_nope", "--approve-tool", "c1_1", "--deny-tool", "c1_1", "--workspace", ws);
    expect(both.code).not.toBe(0);
    expect(`${both.stdout}${both.stderr}`).toMatch(/allowed or declined, not both|no run run_nope/);
  });

  it("without the flag the output is the human summary, not JSON", async () => {
    const r = await mdj("run", "--workspace", ws, "--", "hello");
    expect(r.stdout).toMatch(/run run_[0-9a-f]+: failed/);
    expect(r.stdout.trimStart().startsWith("{")).toBe(false);
  });
});
