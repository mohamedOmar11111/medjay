import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryKeystore } from "../../test/helpers/keystore.js";
import { Ledger, verifyLedger } from "../audit/ledger.js";
import { loadPolicy, PolicySchema, type Policy } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { initWorkspace } from "../workspace/init.js";
import { approvePlan, holdPlan, rejectPlan } from "./approve.js";
import type { CompileInput } from "./compile.js";
import { ConfirmationError, ExpiredError, HashMismatchError, PlanStateError, PolicyViolationError, ReplayError, SignatureError } from "./errors.js";
import { proposePlan } from "./propose.js";
import { PlanRepo } from "./repo.js";
import { ensureSigningKey } from "./signing.js";
import { strikePlan } from "./strike.js";

const T0 = new Date("2026-10-17T10:00:00.000Z");

let root: string;
let dir: string;
let store: Store;
let clockNow = T0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-plan-"));
  dir = join(root, "ws");
  clockNow = T0;
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  await mkdir(join(dir, "plans", "patches"), { recursive: true });
  await writeFile(join(dir, "plans", "patches", "hero.diff"), ["--- a/hero.html", "+++ b/hero.html", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"));
});
afterEach(async () => {
  store?.close();
  await rm(root, { recursive: true, force: true });
});

async function setup(overridePolicy?: Policy) {
  store = Store.open(join(dir, ".medjay", "experiments.db"));
  const repo = new PlanRepo(store);
  const ledger = new Ledger(join(dir, ".medjay", "audit-log.jsonl"), { now: () => clockNow });
  const loaded = await loadPolicy(dir);
  // these tests are about the lifecycle, not the simulation gate (covered in simulation-gate.test.ts)
  const policy = overridePolicy ?? PolicySchema.parse({ ...loaded, limits: { ...loaded.limits, require_simulation_for_scale: false } });
  const signing = await ensureSigningKey({ dir, workspaceId: "ws", keystore: memoryKeystore(), env: {} });
  let n = 0;
  return {
    dir,
    repo,
    ledger,
    policy,
    signing,
    now: () => clockNow,
    random: { code: () => "123456", nonce: () => `nonce-${(n += 1)}` },
  };
}

const google = (id: string, name: string) => ({ platform: "google_ads", kind: "campaign", id, name });
const meta = (id: string, name: string) => ({ platform: "meta", kind: "adset", id, name });

const proposals: CompileInput["proposals"] = [
  { type: "budget_change", target: google("123", "Brand Search"), from: 200, to: 160, currency: "USD" },
  { type: "status_change", target: google("123", "Brand Search"), from: "ENABLED", to: "PAUSED" },
  { type: "add_negative_keywords", target: google("123", "Brand Search"), terms: [{ text: "free", match: "BROAD" }, { text: "jobs", match: "PHRASE" }] },
  { type: "budget_change", target: meta("999", "KSA_Bookers_LAL"), from: 100, to: 120, currency: "USD" },
  { type: "code_patch", artifact: "patches/hero.diff" },
];

const planInput = (over: Partial<Omit<CompileInput, "now">> = {}): Omit<CompileInput, "now"> => ({
  workspace: "ws",
  origin: { job: "diagnose", finding_ids: ["f_1"] },
  proposals,
  ...over,
});

const ledgerEvents = async () =>
  (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).event as string);

describe("proposePlan", () => {
  it("writes the plan file, records it as proposed and numbers it", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    expect(row).toMatchObject({ number: 1, state: "proposed", plan_id: plan.plan_id, plan_hash: plan.plan_hash });
    const file = JSON.parse(await readFile(join(dir, "plans", `${plan.plan_id}.plan.json`), "utf8"));
    expect(file.plan_hash).toBe(plan.plan_hash);
    expect(file.approvals).toEqual([]);
    expect(await ledgerEvents()).toContain("plan.proposed");
    const second = await proposePlan(deps, planInput({ proposals: [{ type: "budget_change", target: meta("1", "A"), from: 10, to: 11, currency: "USD" }] }));
    expect(second.row.number).toBe(2);
  });

  it("refuses a plan that breaks policy and stores nothing", async () => {
    const deps = await setup();
    const over = planInput({ proposals: [{ type: "budget_change", target: meta("1", "A"), from: 100, to: 150, currency: "USD" }] });
    await expect(proposePlan(deps, over)).rejects.toBeInstanceOf(PolicyViolationError);
    expect(deps.repo.list()).toHaveLength(0);
    expect((await readdir(join(dir, "plans"))).filter((f) => f.endsWith(".plan.json"))).toHaveLength(0);
  });

  it("refuses a patch artifact that does not exist", async () => {
    const deps = await setup();
    await expect(proposePlan(deps, planInput({ proposals: [{ type: "code_patch", artifact: "patches/missing.diff" }] }))).rejects.toThrow(/missing\.diff/);
  });

  it("refuses to propose the same plan twice", async () => {
    const deps = await setup();
    await proposePlan(deps, planInput());
    await expect(proposePlan(deps, planInput())).rejects.toThrow(/already/);
  });
});

describe("approvePlan", () => {
  it("signs the approval, moves to approved, appends it to the plan file and leaves the hash alone", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    const result = await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    expect(result.status).toBe("approved");
    expect(deps.repo.get(row.number)?.state).toBe("approved");
    const file = JSON.parse(await readFile(join(dir, "plans", `${plan.plan_id}.plan.json`), "utf8"));
    expect(file.plan_hash).toBe(plan.plan_hash);
    expect(file.approvals).toHaveLength(1);
    expect(file.approvals[0]).toMatchObject({ approver: "cli:omar", channel: "cli", plan_hash: plan.plan_hash });
    expect(await ledgerEvents()).toContain("plan.approved");
  });

  it("refuses a plan file edited after it was proposed", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    const path = join(dir, "plans", `${plan.plan_id}.plan.json`);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.actions[0].to = 5;
    await writeFile(path, JSON.stringify(file));
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" })).rejects.toBeInstanceOf(HashMismatchError);
    expect(deps.repo.get(row.number)?.state).toBe("proposed");
  });

  it("refuses an expired plan and marks it expired", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    clockNow = new Date(T0.getTime() + 3 * 24 * 3600 * 1000);
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" })).rejects.toBeInstanceOf(ExpiredError);
    expect(deps.repo.get(row.number)?.state).toBe("expired");
  });

  it("re-checks the current policy and refuses if it now fails", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    const stricter = PolicySchema.parse({ ...deps.policy, limits: { ...deps.policy.limits, max_daily_budget_decrease_pct: 10 } });
    await expect(approvePlan({ ...deps, policy: stricter }, row.number, { approver: "cli:omar", channel: "cli" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect(deps.repo.get(row.number)?.state).toBe("proposed");
  });

  it("will not approve twice, and a replayed nonce is rejected by the store", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", nonce: "same" });
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", nonce: "same" })).rejects.toBeInstanceOf(PlanStateError);
    const approval = deps.repo.approvals(row.number)[0]!;
    expect(() => deps.repo.addApproval({ ...approval, plan_number: row.number })).toThrow(ReplayError);
    expect(deps.repo.approvals(row.number)).toHaveLength(1);
  });

  it("can hold, then approve, and cannot approve a rejected plan", async () => {
    const deps = await setup();
    const a = await proposePlan(deps, planInput());
    await holdPlan(deps, a.row.number, { actor: "cli:omar" });
    expect(deps.repo.get(a.row.number)?.state).toBe("held");
    await approvePlan(deps, a.row.number, { approver: "cli:omar", channel: "cli" });
    expect(deps.repo.get(a.row.number)?.state).toBe("approved");

    const b = await proposePlan(deps, planInput({ proposals: [{ type: "budget_change", target: meta("1", "A"), from: 10, to: 11, currency: "USD" }] }));
    await rejectPlan(deps, b.row.number, { actor: "cli:omar", reason: "not now" });
    await expect(approvePlan(deps, b.row.number, { approver: "cli:omar", channel: "cli" })).rejects.toBeInstanceOf(PlanStateError);
  });
});

describe("approvePlan: two-step confirmation", () => {
  const big: CompileInput["proposals"] = [
    { type: "budget_change", target: meta("1", "Big"), from: 3000, to: 3500, currency: "USD" },
    { type: "budget_change", target: meta("2", "Small"), from: 900, to: 600, currency: "USD" },
  ];

  it("asks for a confirmation code first, then approves with the right one", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput({ proposals: big }));
    const first = await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    expect(first).toMatchObject({ status: "confirmation_required", code: "123456" });
    expect(deps.repo.get(row.number)?.state).toBe("proposed");
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: "000000" })).rejects.toBeInstanceOf(ConfirmationError);
    const done = await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: "123456" });
    expect(done.status).toBe("approved");
  });

  it("locks after five wrong codes, even for the right code, and refuses a fresh code while locked", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput({ proposals: big }));
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    for (let i = 0; i < 5; i += 1) {
      await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: "999999" })).rejects.toBeInstanceOf(ConfirmationError);
    }
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: "123456" })).rejects.toThrow(/locked/);
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" })).rejects.toThrow(/locked/);
  });

  it("expires the code after ten minutes", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput({ proposals: big }));
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    clockNow = new Date(T0.getTime() + 11 * 60 * 1000);
    await expect(approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: "123456" })).rejects.toThrow(/expired/);
  });

  it("binds the code to its plan", async () => {
    const deps = await setup();
    const a = await proposePlan(deps, planInput({ proposals: big }));
    const b = await proposePlan(deps, planInput({ proposals: [{ type: "budget_change", target: meta("3", "Big2"), from: 3000, to: 3500, currency: "USD" }, { type: "budget_change", target: meta("4", "S"), from: 900, to: 600, currency: "USD" }] }));
    await approvePlan(deps, a.row.number, { approver: "cli:omar", channel: "cli" });
    await expect(approvePlan(deps, b.row.number, { approver: "cli:omar", channel: "cli", confirmationCode: "123456" })).rejects.toBeInstanceOf(ConfirmationError);
  });
});

describe("strikePlan", () => {
  it("refuses a plan that was never approved", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    await expect(strikePlan(deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(PlanStateError);
    await expect(stat(join(dir, "exports"))).rejects.toThrow();
  });

  it("exports an approved plan: Google Ads Editor CSV, manifest, manual steps and patch", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    const result = await strikePlan(deps, row.number, { actor: "cli:omar" });
    expect(result.state).toBe("exported");
    expect(result.results.map((r) => r.status)).toEqual(["exported", "exported", "exported", "exported", "exported"]);

    const out = join(dir, "exports", plan.plan_id);
    const csvBytes = await readFile(join(out, "google-ads-editor.csv"));
    expect([...csvBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const lines = csvBytes.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(lines).toEqual([
      "Campaign,Ad Group,Keyword,Criterion Type,Campaign Status,Budget",
      "Brand Search,,,,Paused,160",
      "Brand Search,,free,Campaign Negative Broad,,",
      "Brand Search,,jobs,Campaign Negative Phrase,,",
    ]);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ plan_id: plan.plan_id, plan_hash: plan.plan_hash });
    expect(manifest.actions).toHaveLength(5);
    // Meta has no bulk file: its budget change is exported as the exact request, in minor units, never sent
    const meta = JSON.parse(await readFile(join(out, "meta-mutations.json"), "utf8"));
    expect(meta.requests).toEqual([{ action_id: "a4", method: "POST", path: "/999", params: { daily_budget: "12000" }, expect_before: { daily_budget: "10000" } }]);
    expect(await readFile(join(out, "CHANGES.md"), "utf8")).toMatch(/none: every action went into/);
    expect(await readFile(join(out, "patches", "hero.diff"), "utf8")).toContain("+new");
    expect(await readFile(join(out, "README.txt"), "utf8")).toMatch(/not been validated|unverified/i);

    expect(deps.repo.get(row.number)?.state).toBe("exported");
    expect(await ledgerEvents()).toEqual(expect.arrayContaining(["plan.proposed", "plan.approved", "plan.strike_started", "plan.exported"]));
    expect(await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"))).toMatchObject({ ok: true });
  });

  it("merges campaign-level edits into one row and quotes awkward text, including Arabic", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(
      deps,
      planInput({
        proposals: [
          { type: "budget_change", target: google("5", 'حملة "الصيف", الرياض'), from: 50, to: 55, currency: "USD" },
          { type: "status_change", target: google("5", 'حملة "الصيف", الرياض'), from: "PAUSED", to: "ENABLED" },
        ],
      }),
    );
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    await strikePlan(deps, row.number, { actor: "cli:omar" });
    const text = (await readFile(join(dir, "exports", plan.plan_id, "google-ads-editor.csv"), "utf8")).slice(1);
    expect(text.split("\r\n").filter(Boolean)).toEqual([
      "Campaign,Ad Group,Keyword,Criterion Type,Campaign Status,Budget",
      '"حملة ""الصيف"", الرياض",,,,Enabled,55',
    ]);
  });

  it("refuses a plan file edited after approval and writes nothing", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    const path = join(dir, "plans", `${plan.plan_id}.plan.json`);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.actions[3].to = 500;
    await writeFile(path, JSON.stringify(file));
    await expect(strikePlan(deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(HashMismatchError);
    expect(deps.repo.get(row.number)?.state).toBe("approved");
    await expect(stat(join(dir, "exports", plan.plan_id))).rejects.toThrow();
  });

  it("refuses an approval whose signature was forged in the database", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    store.database().prepare("UPDATE approvals SET signature = ? WHERE plan_number = ?").run(Buffer.from("forged").toString("base64"), row.number);
    await expect(strikePlan(deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(SignatureError);
    await expect(stat(join(dir, "exports", plan.plan_id))).rejects.toThrow();
  });

  it("refuses an approval for a different plan hash", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    store.database().prepare("UPDATE approvals SET plan_hash = ? WHERE plan_number = ?").run("f".repeat(64), row.number);
    await expect(strikePlan(deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(SignatureError);
  });

  it("re-checks policy at strike time and refuses if it now fails", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    const stricter = PolicySchema.parse({ ...deps.policy, limits: { ...deps.policy.limits, max_daily_budget_increase_pct: 5 } });
    await expect(strikePlan({ ...deps, policy: stricter }, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(stat(join(dir, "exports", plan.plan_id))).rejects.toThrow();
  });

  it("refuses an approved plan once it has expired", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    clockNow = new Date(T0.getTime() + 3 * 24 * 3600 * 1000);
    await expect(strikePlan(deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(ExpiredError);
    expect(deps.repo.get(row.number)?.state).toBe("expired");
  });

  it("cannot strike the same plan twice", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput());
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    await strikePlan(deps, row.number, { actor: "cli:omar" });
    await expect(strikePlan(deps, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(PlanStateError);
  });

  it("marks live-connector actions failed (no connector yet), reports partial, and retries only the failed ones", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(
      deps,
      planInput({
        proposals: [
          { type: "budget_change", target: google("123", "Brand Search"), from: 200, to: 160, currency: "USD" },
          { type: "budget_change", target: meta("999", "Live"), from: 100, to: 110, currency: "USD", executor: "mcp" },
        ],
      }),
    );
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    const first = await strikePlan(deps, row.number, { actor: "cli:omar" });
    expect(first.state).toBe("partial");
    expect(first.results.map((r) => r.status)).toEqual(["exported", "failed"]);
    expect(first.results[1]!.detail).toMatch(/connector/i);
    const csvPath = join(dir, "exports", plan.plan_id, "google-ads-editor.csv");
    const before = (await stat(csvPath)).mtimeMs;
    const retry = await strikePlan(deps, row.number, { actor: "cli:omar" });
    expect(retry.state).toBe("partial");
    expect((await stat(csvPath)).mtimeMs).toBe(before);
  });

  it("fails an action instead of writing a spreadsheet-injection campaign name", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput({ proposals: [{ type: "budget_change", target: google("1", "=HYPERLINK(\"x\")"), from: 10, to: 11, currency: "USD" }] }));
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    const result = await strikePlan(deps, row.number, { actor: "cli:omar" });
    expect(result.state).toBe("failed");
    expect(result.results[0]).toMatchObject({ status: "failed" });
    expect(result.results[0]!.detail).toMatch(/campaign name/i);
  });

  it("fails a Google action that has no campaign name", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, planInput({ proposals: [{ type: "budget_change", target: { platform: "google_ads", kind: "campaign", id: "1" }, from: 10, to: 11, currency: "USD" }] }));
    await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    const result = await strikePlan(deps, row.number, { actor: "cli:omar" });
    expect(result.results[0]!.detail).toMatch(/campaign name/i);
  });
});
