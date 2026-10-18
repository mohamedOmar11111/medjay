// The global vault through the real CLI: promote a validated tactic out of one workspace, find it from
// another, pull it as an unverified prior. Two workspaces, one vault folder, nothing outside the temp dir.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";
import { FIXTURE } from "../../test/helpers/ingest.js";

vi.setConfig({ testTimeout: 120_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(import.meta.dirname, "..", "cli.ts");
let root: string;
let a: string;
let b: string;
let vault: string;

async function mdj(workspace: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", CLI, ...args, "--workspace", workspace], { cwd: REPO, timeout: 100_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const setPromotion = async (dir: string, mode: string) => {
  const file = join(dir, "workspace.yaml");
  const config = parse(await readFile(file, "utf8")) as Record<string, any>;
  config.vault = { ...(config.vault ?? {}), promotion: mode };
  await writeFile(file, stringify(config), "utf8");
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-vault-cli-"));
  vault = join(root, "vault");
  a = join(root, "etlaala-ksa");
  b = join(root, "another-agency");
  await exec(process.execPath, ["--import", "tsx", CLI, "init", a, "--id", "etlaala-ksa", "--name", "Etlaala KSA", "--timezone", "Asia/Riyadh", "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
  await cp(FIXTURE, a, { recursive: true, force: true });
  await exec(process.execPath, ["--import", "tsx", CLI, "init", b, "--id", "another-agency", "--currency", "USD", "--business-type", "agency"], { cwd: REPO });
  await mdj(a, "scout", "--json"); // ingest, so the campaign names are known to the leak check
  // test the fixture tactic to a verdict
  await mdj(a, "tactic", "hypothesize", "TACTIC-ETL-001", "--experiment", "EXP-ETL-9", "--hypothesis", "Pausing ad sets with no CRM deal lowers cost per deal by at least 10%", "--metric", "cost_per_deal_sar", "--baseline-value", "960", "--baseline-range", "2026-10-10..2026-10-16", "--baseline-snapshot", "snap_9", "--design", "before_after", "--min-sample", "25", "--duration-days", "14", "--min-effect", "0.1");
  await mdj(a, "tactic", "conclude", "TACTIC-ETL-001", "--confidence", "0.96", "--method", "bayesian", "--sample-size", "312", "--date-range", "2026-10-18..2026-11-05", "--effect", "-0.22", "--outcome-source", "crm");
}, 240_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj tactics promote", () => {
  it("shows the redaction diff in a dry run and writes nothing", async () => {
    const r = await mdj(a, "tactics", "promote", "TACTIC-ETL-001", "--vault", vault, "--dry-run");
    expect(r.stdout).toMatch(/Redaction diff for TACTIC-ETL-001 -> GT-[0-9a-f]{12}/);
    expect(r.stdout).toMatch(/evidence.effect_band\n\s+before: -0.22\n\s+after:\s+-15% to -30%/);
    expect(r.stdout).toMatch(/Left out entirely: .*experiment id and design/);
    expect(r.stdout).toMatch(/Dry run: nothing was written\. workspace.yaml has vault.promotion: off/);
    await expect(readdir(vault)).rejects.toThrow();
  });

  it("is blocked while vault.promotion is off, and needs --yes when it is ask", async () => {
    const off = await mdj(a, "tactics", "promote", "TACTIC-ETL-001", "--vault", vault);
    expect(off.code).toBe(1);
    expect(off.stderr).toMatch(/vault.promotion is off/);
    await setPromotion(a, "ask");
    const ask = await mdj(a, "tactics", "promote", "TACTIC-ETL-001", "--vault", vault);
    expect(ask.code).toBe(2);
    expect(ask.stdout).toMatch(/run again with --yes/);
    await expect(readdir(vault)).rejects.toThrow();
  });

  it("refuses a tactic that is not validated, and one whose text carries a campaign or client word", async () => {
    const unverified = await mdj(a, "tactics", "promote", "TACTIC-ETL-002", "--vault", vault, "--yes");
    expect(unverified.code).toBe(1);
    expect(unverified.stderr).toMatch(/only a validated tactic/);

    const file = join(a, "tactics", "TACTIC-ETL-001.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("# Pause ad sets that bleed", "# Pause ad sets like UMRAH-ALL-Broad-Reels for Etlaala"), "utf8");
    const leak = await mdj(a, "tactics", "promote", "TACTIC-ETL-001", "--vault", vault, "--yes");
    expect(leak.code).toBe(1);
    expect(leak.stderr).toMatch(/still contains words that identify this workspace: .*etlaala.*umrah|umrah.*etlaala/);
    await expect(readdir(vault)).rejects.toThrow();
    await writeFile(file, original, "utf8");
  });

  it("promotes with --yes: one anonymized record in the vault, a ledger entry, and no client words in it", async () => {
    const r = await mdj(a, "tactics", "promote", "TACTIC-ETL-001", "--vault", vault, "--yes");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Promoted: GT-[0-9a-f]{12}/);
    const files = await readdir(join(vault, "tactics"));
    expect(files).toHaveLength(1);
    const text = await readFile(join(vault, "tactics", files[0]!), "utf8");
    for (const leak of ["etlaala", "Etlaala", "Umrah", "UMRAH", "Reels", "SAR", "EXP-ETL-9", "TACTIC-ETL-001", "312", "960"]) expect(text, leak).not.toContain(leak);
    expect(JSON.parse(text)).toMatchObject({ tags: { markets: ["KSA"], verticals: ["travel"] }, funnel_stage: "conversion", pillars: [6], evidence: { effect_band: "-15% to -30%", period: "2026-Q4" } });
    const ledger = join(a, ".medjay", "audit-log.jsonl");
    expect(await verifyLedger(ledger)).toMatchObject({ ok: true });
    expect(await readFile(ledger, "utf8")).toMatch(/"event":"tactic.promoted"/);
    const again = await mdj(a, "tactics", "promote", "TACTIC-ETL-001", "--vault", vault, "--yes");
    expect(again.stdout).toMatch(/Already in the vault/);
    expect(await readdir(join(vault, "tactics"))).toHaveLength(1);
  });
});

describe("mdj tactics search and pull from another workspace", () => {
  it("finds the pattern by industry, market, funnel stage and pillar, and nothing for a mismatch", async () => {
    const hit = await mdj(b, "tactics", "search", "--vault", vault, "--industry", "travel", "--market", "KSA", "--funnel-stage", "conversion", "--pillar", "6");
    expect(hit.stdout).toMatch(/GT-[0-9a-f]{12}  Pause ad sets with spend but no CRM deal/);
    expect(hit.stdout).toMatch(/effect -15% to -30% on cost per deal, sample 100-500, confidence 0.95-0.99, 2026-Q4/);
    const miss = await mdj(b, "tactics", "search", "--vault", vault, "--industry", "retail");
    expect(miss.stdout).toMatch(/no matching patterns/);
  });

  it("pulls it as an UNVERIFIED prior, can be tested locally, and cannot be pulled twice", async () => {
    const id = /GT-[0-9a-f]{12}/.exec((await mdj(b, "tactics", "search", "--vault", vault)).stdout)![0];
    const pulled = await mdj(b, "tactics", "pull", id, "--vault", vault);
    expect(pulled.code, pulled.stderr).toBe(0);
    const localId = /pulled .* as (TACTIC-VAULT-[0-9a-f]{8})/.exec(pulled.stdout)![1]!;
    const shown = await mdj(b, "tactic", "show", localId);
    expect(shown.stdout).toMatch(/\[unverified\]/);
    expect(await mdj(b, "tactic", "list", "--state", "validated")).toMatchObject({ stdout: expect.stringMatching(/no tactics yet/) });
    expect((await mdj(b, "tactics", "pull", id, "--vault", vault)).stderr).toMatch(/already in this workspace/);
    const body = await readFile(join(b, "tactics", `${localId}.md`), "utf8");
    expect(body).toMatch(/evidence_scope: vault_prior/);
    expect(body).toMatch(/A prior from another workspace, not proof here/);
    expect(body).not.toMatch(/etlaala/i);
  });

  it("refuses a record that was edited after it was promoted", async () => {
    const files = await readdir(join(vault, "tactics"));
    const file = join(vault, "tactics", files[0]!);
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, title: "Tampered" }), "utf8");
    const r = await mdj(b, "tactics", "pull", record.global_id, "--vault", vault);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/does not match its id/);
    const search = await mdj(b, "tactics", "search", "--vault", vault);
    expect(search.code).toBe(1);
    expect(search.stderr).toMatch(/warning: .*does not match its id/);
  });
});
