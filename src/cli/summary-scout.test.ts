import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  root = await mkdtemp(join(tmpdir(), "medjay-summary-scout-"));
  ws = join(root, "ws");
  await exec(process.execPath, [CLI, "init", ws, "--id", "sum", "--currency", "SAR", "--business-type", "ecom"], { cwd: REPO });
  const drop = join(ws, "data", "imports");
  await mkdir(drop, { recursive: true });
  await writeFile(join(drop, "Campaigns(2026.09.01-2026.09.30).csv"), ["Campaign Name,Campaign Group Name,Campaign Status,Cost,Conversions,Cost / conv.", 'georgia,,Enabled,"SAR8,450.00",78.00,SAR108.33', 'Europe,,Enabled,"SAR6,682.09",132.00,SAR50.62'].join("\n"));
  await writeFile(join(drop, "Searches(Search_2026.09.01-2026.09.30).csv"), ["Search,Cost,Clicks,Impressions,Conversions", "thailand,SAR164.71,17,436,0.00", "paris,SAR20.00,3,90,2.00"].join("\n"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj scout and diagnose on a workspace that only has period summaries", () => {
  it("scout --json returns the summary beside an empty daily snapshot", async () => {
    const r = await mdj("scout", "--json", "--workspace", ws);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { snapshot: { status: string }; summary: { totals: { spend: number }; zero_conversion_total: { spend: number } } };
    expect(json.snapshot.status).toBe("no_data");
    expect(json.summary.totals.spend).toBeCloseTo(15132.09, 2);
    expect(json.summary.zero_conversion_total.spend).toBeCloseTo(164.71, 2);
  });

  it("scout prints a period summary instead of 'No ad data'", async () => {
    const r = await mdj("scout", "--workspace", ws);
    expect(r.stdout).toContain("Period summary 2026-09-01..2026-09-30");
    expect(r.stdout).not.toContain("No ad data ingested yet");
    expect(r.stdout).toContain("thailand");
  });

  it("diagnose --json carries the summary too", async () => {
    const r = await mdj("diagnose", "--json", "--workspace", ws);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { status: string; summary: { campaigns: { name: string }[] } | null };
    expect(json.status).toBe("no_data");
    expect(json.summary?.campaigns[0]?.name).toBe("georgia");
  });
});

describe("mdj simulate on a workspace that only has period summaries", () => {
  it("uses the summary's spend as the starting point instead of failing with 'no spend to simulate'", async () => {
    const r = await mdj("simulate", "--json", "--scale-pct", "20", "--workspace", ws);
    expect(r.stderr + r.stdout).not.toMatch(/no spend to simulate/);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { status: string };
    expect(["ok", "insufficient_inputs"]).toContain(json.status);
  });
});
