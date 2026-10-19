import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "dist", "cli.js"); // built once by test/global-setup.ts
let root: string;
let dir: string;

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
  root = await mkdtemp(join(tmpdir(), "medjay-media-cli-"));
  dir = join(root, "ws");
  await exec(process.execPath, [CLI, "init", dir, "--id", "ws", "--business-type", "ecom"], { cwd: REPO });
}, 90_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj media", () => {
  it("lists 20 rules and explains one", async () => {
    const list = await mdj("media", "list", "--json");
    expect(JSON.parse(list.stdout)).toHaveLength(20);
    const text = await mdj("media", "explain", "72h-guard");
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/72h-guard/);
    const bad = await mdj("media", "explain", "nope");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/no media rule "nope"/);
  });

  it("runs a rule on an explicit file with key=value parameters, and logs counts only", async () => {
    const file = join(root, "ads.csv");
    await writeFile(file, "ad_id,first_delivery\nN1,2026-10-01T14:00\nN3,2026-10-02T18:00\n", "utf8");
    const r = await mdj("media", "run", "72h-guard", file, "now=2026-10-05T09:00", "--workspace", dir, "--json");
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).summary).toEqual({ hands_off: 1 });
    const ledger = await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8");
    expect(ledger).toMatch(/media_rules\.run/);
    expect(ledger).not.toMatch(/N1|2026-10-01/);
    expect((await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"))).ok).toBe(true);
  });

  it("finds the default file in the dropzone and names a missing one", async () => {
    const missing = await mdj("media", "run", "near-copy-count", "--workspace", dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/not found/);
    const ws = await readFile(join(dir, "workspace.yaml"), "utf8");
    const drop = /dropzone_dir:\s*(\S+)/.exec(ws)?.[1]?.replace(/["']/g, "") ?? "data/imports";
    const media = join(dir, drop, "media");
    await mkdir(media, { recursive: true });
    const probe = await mdj("media", "explain", "near-copy-count");
    const name = /Input: (\S+)/.exec(probe.stdout)![1]!;
    await writeFile(join(media, name), "ad_id,launched,angle,format,person\nA,2026-10-01,x,static,none\n", "utf8");
    const ok = await mdj("media", "run", "near-copy-count", "--workspace", dir);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/SUMMARY/);
  });

  it("refuses a missing required parameter and an unknown rule", async () => {
    const file = join(root, "a2.csv");
    await writeFile(file, "ad_id,spend_30d,purchases\nA,100,5\n", "utf8");
    const noParam = await mdj("media", "run", "leave-it-alone", file, "--workspace", dir);
    expect(noParam.code).toBe(1);
    expect(noParam.stderr).toMatch(/target_cpa/);
    const unknown = await mdj("media", "run", "zzz", "--workspace", dir);
    expect(unknown.code).toBe(1);
  });
});
