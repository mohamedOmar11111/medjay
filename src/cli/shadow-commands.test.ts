import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";
import { FIXTURE } from "../../test/helpers/ingest.js";

vi.setConfig({ testTimeout: 120_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(import.meta.dirname, "..", "cli.ts");
let root: string;
let dir: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", CLI, ...args, "--workspace", dir], { cwd: REPO, timeout: 100_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-shadow-cli-"));
  dir = join(root, "etlaala-ksa");
  await exec(process.execPath, ["--import", "tsx", CLI, "init", dir, "--id", "etlaala-ksa", "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
  await cp(FIXTURE, dir, { recursive: true, force: true });
}, 120_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj shadow-scout on the etlaala-ksa competitors", () => {
  it("extracts each competitor's offer and compares it with ours", async () => {
    const r = await mdj("shadow-scout");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/3 competitor snapshot\(s\)/);
    expect(r.stdout).toContain('promise: "Umrah packages from SAR 3,499 per person"');
    expect(r.stdout).toMatch(/price anchor: 3499 SAR \(from\); was 4100, now 3499 \(14.7% off\)/);
    expect(r.stdout).toMatch(/price anchor: 4200 ريال \(from\)/);
    expect(r.stdout).toMatch(/BNPL: yes \(tabby, tamara\)/);
    expect(r.stdout).toMatch(/\[HIGH\] gap: 2 of 3 competitors offer buy-now-pay-later\. You do not\./);
    expect(r.stdout).toMatch(/\[MED\] gap: Your anchor is 14.3% above alpha-umrah's/);
    expect(r.stdout).toMatch(/not_comparable: beta-travel: currency differs/);
    expect(r.stdout).toMatch(/gap: 2 of 3 competitors lead with whatsapp; you lead with web_checkout/);
    expect(r.stdout).toMatch(/Competitors show trust signals you do not: .*rating/);
  });

  it("flags the instruction hidden in a competitor page and never repeats it as a finding", async () => {
    const r = await mdj("shadow-scout");
    expect(r.stdout).toMatch(/WARNING: text that reads like an instruction to an AI/);
    expect(r.stdout).toContain("alpha-umrah");
    expect(r.stdout).toMatch(/BNPL: yes \(tabby, tamara\)/); // the planted comment said the opposite
  });

  it("--json carries the findings inside nonce-bound untrusted_data blocks, and the ledger records the run", async () => {
    const r = await mdj("shadow-scout", "--json");
    const report = JSON.parse(r.stdout);
    expect(report.competitors.map((c: { name: string }) => c.name)).toEqual(["alpha-umrah", "beta-travel", "gamma-ads"]);
    expect(report.spotlighted).toHaveLength(3);
    for (const b of report.spotlighted as { text: string }[]) {
      expect(b.text).toMatch(/^<untrusted_data id="[0-9a-f]{12}" source="data\/imports\/competitors\/[a-z-]+\.(?:html|json)" as_of="/);
      expect(b.text).toMatch(/<\/untrusted_data id="[0-9a-f]{12}">$/);
    }
    const ledger = join(dir, ".medjay", "audit-log.jsonl");
    expect(await verifyLedger(ledger)).toMatchObject({ ok: true });
    const events = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const last = events.filter((e) => e.event === "shadow_scout.completed").at(-1);
    expect(last.payload).toMatchObject({ competitors: expect.any(Array), instruction_like_files: 1 });
    expect(JSON.stringify(last.payload)).not.toContain("SYSTEM NOTICE");
  });

  it("explains how to get a comparison when the offer block is missing, and how to get started when there are no snapshots", async () => {
    await writeFile(join(dir, "context", "offer-matrix.md"), "---\nworkspace: etlaala-ksa\n---\n# Offers\n", "utf8");
    expect((await mdj("shadow-scout")).stdout).toMatch(/No gap comparison: add an `offer:` block/);
    await rm(join(dir, "data", "imports", "competitors"), { recursive: true, force: true });
    const none = await mdj("shadow-scout");
    expect(none.code).toBe(1);
    expect(none.stdout).toMatch(/No competitor snapshots found/);
  });
});
