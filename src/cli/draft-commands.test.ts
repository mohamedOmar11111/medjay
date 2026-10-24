import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";
import { DraftStore } from "../drafts/store.js";

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
  root = await mkdtemp(join(tmpdir(), "medjay-draft-cli-"));
  ws = join(root, "ws");
  await exec(process.execPath, [CLI, "init", ws, "--id", "dr", "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
  const store = new DraftStore(ws, { checker: () => ({ status: "pass", errors: 0, warnings: 0, rules: [] }) });
  await store.save({ workflow: "email", slug: "umrah-follow-up", kind: "email", text: "Hello\nWe hope you are well\nBest", author: "agent:run_1" });
  await store.save({ workflow: "email", slug: "umrah-follow-up", kind: "email", text: "Hello\nWe hope you are very well\nBest", author: "agent:run_1" });
  await store.save({ workflow: "reports", slug: "weekly", kind: "report", text: "Spend was flat.", author: "agent:run_2" });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj draft", () => {
  it("list shows each draft with its latest version, count, kind and copy check", async () => {
    const r = await mdj("draft", "list", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/email\/umrah-follow-up\s+v2\s+2\s+email\s+pass/);
    expect(r.stdout).toMatch(/reports\/weekly\s+v1\s+1\s+report\s+not_applicable/);
    const only = await mdj("draft", "list", "--workflow", "reports", "--json", "--workspace", ws);
    expect((JSON.parse(only.stdout) as { slug: string }[]).map((d) => d.slug)).toEqual(["weekly"]);
  });

  it("show prints the latest or a given version with its SHA-256", async () => {
    const latest = await mdj("draft", "show", "email/umrah-follow-up", "--workspace", ws);
    expect(latest.stdout).toContain("We hope you are very well");
    expect(latest.stdout).toMatch(/version: 2/);
    expect(latest.stdout).toMatch(/sha256: [0-9a-f]{64}/);
    const first = await mdj("draft", "show", "email/umrah-follow-up", "1", "--workspace", ws);
    expect(first.stdout).toContain("We hope you are well");
    expect((await mdj("draft", "show", "email/nope", "--workspace", ws)).code).toBe(1);
    expect((await mdj("draft", "show", "../x", "--workspace", ws)).code).toBe(1);
  });

  it("diff shows what changed between two versions", async () => {
    const r = await mdj("draft", "diff", "email/umrah-follow-up", "1", "2", "--workspace", ws);
    expect(r.stdout).toContain("- We hope you are well");
    expect(r.stdout).toContain("+ We hope you are very well");
  });

  it("revert saves the old text as a new version and records it in the ledger", async () => {
    const r = await mdj("draft", "revert", "email/umrah-follow-up", "--to", "1", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/saved v3 \(reverted from v1\)/);
    expect((await mdj("draft", "show", "email/umrah-follow-up", "--workspace", ws)).stdout).toContain("We hope you are well");
    expect((await verifyLedger(join(ws, ".medjay", "audit-log.jsonl"))).ok).toBe(true);
  });

  it("verify is quiet when nothing changed and exits 1 naming a version edited outside Medjay", async () => {
    expect((await mdj("draft", "verify", "--workspace", ws)).code).toBe(0);
    await writeFile(join(ws, "drafts", "reports", "weekly", "v1.md"), "Spend was flat, then edited by hand.", "utf8");
    const bad = await mdj("draft", "verify", "--workspace", ws);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/reports\/weekly v1/);
  });
});
