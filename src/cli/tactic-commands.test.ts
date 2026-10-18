import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// each test spawns the CLI one or more times; under load that can pass the default 20 s
vi.setConfig({ testTimeout: 90_000 });
import { verifyLedger } from "../audit/ledger.js";

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(import.meta.dirname, "..", "cli.ts");
let root: string;
let dir: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", CLI, ...args, "--workspace", dir], { cwd: REPO, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const experimentArgs = ["--experiment", "EXP-088", "--hypothesis", "Sticky CTA lifts qualified chats by 15%", "--metric", "lead_to_qualified_chat_rate", "--baseline-value", "0.21", "--baseline-range", "2026-09-19..2026-10-16", "--baseline-snapshot", "snap_88", "--design", "before_after", "--min-sample", "200", "--duration-days", "14", "--min-effect", "0.15"];
const resultArgs = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = { "--confidence": "0.94", "--method": "bayesian", "--sample-size": "312", "--date-range": "2026-10-18..2026-11-01", "--effect": "0.31", "--outcome-source": "crm", ...over };
  return Object.entries(base).flat();
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-tactic-"));
  dir = join(root, "ws");
  await exec(process.execPath, ["--import", "tsx", CLI, "init", dir, "--id", "ws", "--business-type", "agency"], { cwd: REPO });
}, 90_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj tactic", () => {
  it("adds an unverified tactic and refuses to add it twice", async () => {
    const a = await mdj("tactic", "new", "--id", "TACTIC-MENA-019", "--title", "Sticky WhatsApp CTA", "--source-kind", "practitioner", "--source-ref", "https://example.com/p", "--source-date", "2026-09-02", "--market", "KSA", "--pillar", "4");
    expect(a.code, a.stderr).toBe(0);
    expect(a.stdout).toMatch(/unverified/);
    const again = await mdj("tactic", "new", "--id", "TACTIC-MENA-019", "--title", "x", "--source-kind", "vendor", "--source-ref", "y", "--source-date", "2026-09-02");
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  });

  it("will not conclude before an experiment is registered", async () => {
    const r = await mdj("tactic", "conclude", "TACTIC-MENA-019", ...resultArgs());
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/only a hypothesized tactic/);
  });

  it("hypothesizes with a complete pre-registered experiment and rejects a bad baseline range", async () => {
    const bad = await mdj("tactic", "hypothesize", "TACTIC-MENA-019", ...experimentArgs.map((a) => (a === "2026-09-19..2026-10-16" ? "2026-10-16..2026-09-19" : a)));
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/not a valid range/);
    const ok = await mdj("tactic", "hypothesize", "TACTIC-MENA-019", ...experimentArgs);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/bound to EXP-088.*200 samples over 14 days/);
  });

  it("keeps an underpowered result as a directional reading (exit 2) and does not promote", async () => {
    const r = await mdj("tactic", "conclude", "TACTIC-MENA-019", ...resultArgs({ "--sample-size": "80" }));
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/stays hypothesized \(directional\): underpowered/);
    expect((await mdj("tactic", "show", "TACTIC-MENA-019")).stdout).toMatch(/\[hypothesized\][\s\S]*1 interim reading/);
  });

  it("validates a decisive, adequately powered result and shows the evidence", async () => {
    const r = await mdj("tactic", "conclude", "TACTIC-MENA-019", ...resultArgs(), "--caveat", "Ramadan overlap");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/is validated \(confidence 0.94, effect 31.0%, n=312\)/);
    const shown = (await mdj("tactic", "show", "TACTIC-MENA-019")).stdout;
    expect(shown).toMatch(/\[validated\]/);
    expect(shown).toMatch(/caveats: Ramadan overlap/);
  });

  it("retires a validated tactic, builds the index, and lists by state", async () => {
    expect((await mdj("tactic", "retire", "TACTIC-MENA-019", "--reason", "Ramadan only")).code).toBe(0);
    expect((await mdj("tactic", "list", "--state", "retired")).stdout).toMatch(/TACTIC-MENA-019/);
    expect((await mdj("tactic", "list", "--state", "validated")).stdout).toMatch(/no tactics yet/);
    const idx = await mdj("tactic", "index");
    expect(idx.code, idx.stderr).toBe(0);
    expect(await readFile(join(dir, "tactics", "tested-tactics-log.md"), "utf8")).toMatch(/## Retired \(1\)/);
  });

  it("reports a hand-edited file that breaks the rules (a validated tactic with no data) and exits 1", async () => {
    await writeFile(join(dir, "tactics", "TACTIC-FAKE-001.md"), "---\nid: TACTIC-FAKE-001\ntitle: Too good\nsource: { kind: vendor, ref: x, date: 2026-09-02 }\nstate: validated\n---\n", "utf8");
    const r = await mdj("tactic", "list");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/TACTIC-FAKE-001.md.*without data/s);
    const shown = await mdj("tactic", "show", "TACTIC-FAKE-001");
    expect(shown.code).toBe(1);
    expect(shown.stderr).toMatch(/cannot be read/);
  });

  it("records every transition in a verifiable ledger", async () => {
    const path = join(dir, ".medjay", "audit-log.jsonl");
    expect(await verifyLedger(path)).toMatchObject({ ok: true });
    const events = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l).event as string);
    expect(events).toEqual(expect.arrayContaining(["tactic.created", "tactic.hypothesized", "tactic.concluded", "tactic.retired"]));
  });
});
