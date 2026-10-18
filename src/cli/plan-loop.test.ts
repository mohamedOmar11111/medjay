// The whole loop through the real CLI: propose -> approve -> strike (export) -> validate-export ->
// verify -> rollback -> approve -> strike. The signing key comes from MEDJAY_SIGNING_KEY and the
// workspace id is unique, so nothing is written to the real OS keychain.
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";

vi.setConfig({ testTimeout: 90_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(import.meta.dirname, "..", "cli.ts");
const KEY = Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
let root: string;
let dir: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", CLI, ...args, "--workspace", dir], { cwd: REPO, timeout: 80_000, env: { ...process.env, MEDJAY_SIGNING_KEY: KEY } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const write = async (name: string, body: unknown) => {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(body), "utf8");
  return path;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-loop-cli-"));
  const id = `e2e-${randomBytes(4).toString("hex")}`;
  dir = join(root, id);
  await exec(process.execPath, ["--import", "tsx", CLI, "init", dir, "--id", id, "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
}, 90_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const google = { platform: "google_ads", kind: "campaign", id: "1", name: "Brand Search" };
const meta = { platform: "meta", kind: "adset", id: "999", name: "Broad" };

describe("propose, strike, validate, verify, rollback", () => {
  it("proposes and approves a plan, and strikes it into validated export files", async () => {
    const file = await write("plan.json", {
      proposals: [
        { type: "budget_change", target: google, from: 200, to: 170, currency: "SAR" },
        { type: "add_negative_keywords", target: google, terms: [{ text: "free", match: "BROAD" }] },
        { type: "budget_change", target: meta, from: 100, to: 85, currency: "SAR" },
      ],
    });
    expect((await mdj("plan", "new", "--from", file)).code).toBe(0);
    const approved = await mdj("approve", "1");
    expect(approved.code, approved.stderr + approved.stdout).toBe(0);
    const struck = await mdj("strike", "1");
    expect(struck.code, struck.stderr + struck.stdout).toBe(0);
    expect(struck.stdout).toMatch(/plan #1: exported/);
    const v = await mdj("validate-export", "1");
    expect(v.code, v.stdout).toBe(0);
    expect(v.stdout).toMatch(/export VALID \(checked manifest.json, google-ads-editor.csv, meta-mutations.json\)/);
  });

  it("validate-export fails after a file is edited", async () => {
    const plans = (await readFile(join(dir, "plans", (await (await import("node:fs/promises")).readdir(join(dir, "plans"))).find((f) => f.endsWith(".plan.json")) as string), "utf8"));
    const planId = JSON.parse(plans).plan_id as string;
    const csv = join(dir, "exports", planId, "google-ads-editor.csv");
    const original = await readFile(csv, "utf8");
    await writeFile(csv, original.replace("170", "17000"), "utf8");
    const bad = await mdj("validate-export", "1");
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/INVALID/);
    expect(bad.stdout).toMatch(/does not match what the approved plan produces/);
    await writeFile(csv, original, "utf8");
    expect((await mdj("validate-export", "1")).code).toBe(0);
  });

  it("verify compares an Editor export and a Meta observation file with the plan", async () => {
    const csv = join(root, "editor.csv");
    await writeFile(csv, ["Campaign,Campaign Status,Budget,Keyword,Criterion Type", "Brand Search,Enabled,170,,", "Brand Search,,,free,Negative Broad"].join("\r\n"), "utf8");
    const partial = await mdj("verify", "1", "--observed", csv);
    expect(partial.code).toBe(1);
    expect(partial.stdout).toMatch(/NOT VERIFIED/);
    expect(partial.stdout).toMatch(/a3 .* NOT SEEN/);

    const json = await write("meta.json", [{ entity: "meta:adset/999", field: "daily_budget", value: 85, currency: "SAR" }]);
    const metaOnly = await mdj("verify", "1", "--observed", json);
    expect(metaOnly.stdout).toMatch(/a3 .* ok/);
    expect(metaOnly.code).toBe(1); // the Google rows were not in this file

    const all = await write("all.json", [
      { name: "Brand Search", field: "daily_budget", value: 170 },
      { name: "Brand Search", field: "negative_keywords", value: [{ text: "free", match: "BROAD" }] },
      { entity: "meta:adset/999", field: "daily_budget", value: 85, currency: "SAR" },
    ]);
    const ok = await mdj("verify", "1", "--observed", all);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/plan #1: VERIFIED \(verified\)/);
  });

  it("rolls the plan back through the same approval and strike, restoring budgets above the usual cap", async () => {
    const rb = await mdj("rollback", "1");
    expect(rb.code, rb.stderr + rb.stdout).toBe(0);
    expect(rb.stdout).toMatch(/PLAN #2/);
    expect(rb.stdout).toMatch(/remove_negative_keywords/);
    expect((await mdj("approve", "2")).code).toBe(0);
    const struck = await mdj("strike", "2");
    expect(struck.code, struck.stdout + struck.stderr).toBe(0);
    const show = await mdj("plan", "show", "1");
    expect(show.stdout).toMatch(/rolled_back/);
  });

  it("leaves a verifiable ledger covering the whole loop", async () => {
    const path = join(dir, ".medjay", "audit-log.jsonl");
    expect(await verifyLedger(path)).toMatchObject({ ok: true });
    const events = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l).event as string);
    expect(events).toEqual(expect.arrayContaining(["plan.proposed", "plan.approved", "plan.exported", "plan.verify_failed", "plan.verified", "plan.rollback_proposed", "plan.rolled_back"]));
  });
});
