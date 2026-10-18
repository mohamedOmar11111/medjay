import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_NOW, setupPlans, type PlanHarness } from "../../test/helpers/plans.js";
import { approvePlan } from "./approve.js";
import { compilePlan } from "./compile.js";
import { PlanStateError } from "./errors.js";
import { ObservedError, parseEditorCsv, parseObserved, parseObservedJson, type Observation } from "./observed.js";
import { proposePlan } from "./propose.js";
import { strikePlan } from "./strike.js";
import { compareObserved, verifyPlan } from "./verify.js";

let h: PlanHarness;
beforeEach(async () => {
  h = await setupPlans({ require_simulation_for_scale: false });
});
afterEach(async () => {
  await h.cleanup();
});

const google = (id: string, name: string) => ({ platform: "google_ads", kind: "campaign", id, name });
const meta = (id: string) => ({ platform: "meta", kind: "adset", id, name: "Broad" });
const proposals = [
  { type: "budget_change", target: google("1", "Brand Search"), from: 200, to: 160, currency: "SAR" },
  { type: "status_change", target: google("1", "Brand Search"), from: "ENABLED", to: "PAUSED" },
  { type: "add_negative_keywords", target: google("1", "Brand Search"), terms: [{ text: "free", match: "BROAD" }, { text: "jobs", match: "PHRASE" }] },
  { type: "budget_change", target: meta("999"), from: 100, to: 115, currency: "SAR" },
  { type: "code_patch", artifact: "patches/hero.diff" },
];
const plan = () => compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: proposals as never, now: PLAN_NOW }, { policy: h.deps.policy }).plan;

const good: Observation[] = [
  { name: "Brand Search", field: "daily_budget", value: 160 },
  { name: "Brand Search", field: "status", value: "Paused" },
  { name: "Brand Search", field: "negative_keywords", value: [{ text: "Free", match: "BROAD" }, { text: "jobs", match: "PHRASE" }, { text: "other", match: "EXACT" }] },
  { entity: "meta:adset/999", field: "daily_budget", value: 115, currency: "SAR" },
];
const statuses = (obs: Observation[]) => compareObserved(plan(), obs).results.map((r) => `${r.action_id}:${r.status}`);

describe("compareObserved", () => {
  it("verifies every machine-checkable action, matching Google by name and Meta by id, and marks patches manual", () => {
    const report = compareObserved(plan(), good);
    expect(report.results.map((r) => `${r.action_id}:${r.status}`)).toEqual(["a1:verified", "a2:verified", "a3:verified", "a4:verified", "a5:manual"]);
    expect(report.all_verified).toBe(true);
  });

  it("reports a wrong budget, a wrong status and a missing negative keyword, with expected and observed", () => {
    const bad: Observation[] = [
      { name: "Brand Search", field: "daily_budget", value: 200 },
      { name: "Brand Search", field: "status", value: "Enabled" },
      { name: "Brand Search", field: "negative_keywords", value: [{ text: "free", match: "BROAD" }] },
      { entity: "meta:adset/999", field: "daily_budget", value: 115, currency: "USD" },
    ];
    const report = compareObserved(plan(), bad);
    expect(report.all_verified).toBe(false);
    expect(report.results.slice(0, 4).map((r) => r.status)).toEqual(["mismatch", "mismatch", "mismatch", "mismatch"]);
    expect(report.results[0]).toMatchObject({ expected: 160, observed: 200 });
    expect(report.results[2]!.detail).toBe("missing: jobs [phrase]");
    expect(report.results[3]!.detail).toMatch(/currency USD, expected SAR/);
  });

  it("never treats a missing observation as a pass", () => {
    expect(statuses([])).toEqual(["a1:not_observed", "a2:not_observed", "a3:not_observed", "a4:not_observed", "a5:manual"]);
    expect(compareObserved(plan(), []).all_verified).toBe(false);
  });

  it("matches negatives by match type, not just text, and treats Meta ACTIVE as ENABLED", () => {
    const wrongType: Observation[] = [{ name: "Brand Search", field: "negative_keywords", value: [{ text: "free", match: "EXACT" }, { text: "jobs", match: "PHRASE" }] }];
    expect(statuses(wrongType)[2]).toBe("a3:mismatch");
    const p = compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: [{ type: "status_change", target: meta("5"), from: "PAUSED", to: "ENABLED" }] as never, now: PLAN_NOW }, { policy: h.deps.policy }).plan;
    expect(compareObserved(p, [{ entity: "meta:adset/5", field: "status", value: "ACTIVE" }]).all_verified).toBe(true);
  });

  it("verifies removal of negative keywords by their absence", () => {
    const p = compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: [{ type: "remove_negative_keywords", target: google("1", "Brand Search"), terms: [{ text: "free", match: "BROAD" }] }] as never, now: PLAN_NOW }, { policy: h.deps.policy }).plan;
    expect(compareObserved(p, [{ name: "Brand Search", field: "negative_keywords", value: [{ text: "other", match: "EXACT" }] }]).all_verified).toBe(true);
    expect(compareObserved(p, [{ name: "Brand Search", field: "negative_keywords", value: [{ text: "free", match: "BROAD" }] }]).results[0]!.detail).toMatch(/still present: free/);
  });
});

describe("observed files", () => {
  it("reads a JSON list or an { observations } object and rejects malformed entries with the position", () => {
    expect(parseObservedJson(JSON.stringify([{ entity: "meta:adset/1", field: "daily_budget", value: 5 }]))).toHaveLength(1);
    expect(parseObservedJson(JSON.stringify({ observations: [{ name: "A", field: "status", value: "Paused" }] }))).toHaveLength(1);
    expect(() => parseObservedJson("{nope")).toThrow(ObservedError);
    expect(() => parseObservedJson(JSON.stringify([{ name: "A", field: "colour", value: 1 }]))).toThrow(/observation 1: "field" must be/);
    expect(() => parseObservedJson(JSON.stringify([{ field: "status", value: "x" }]))).toThrow(/needs an "entity" or a "name"/);
    expect(() => parseObservedJson(JSON.stringify({ other: 1 }))).toThrow(/expected a JSON array/);
  });

  it("reads a Google Ads Editor export: campaigns, status, budget and negative keywords, headers in any order", () => {
    const csv = ["Keyword,Campaign,Budget,Criterion Type,Campaign Status", ",Brand Search,160.00,,Paused", "free,Brand Search,,Negative Broad,", "jobs,Brand Search,,Negative Phrase,", ",,,,"].join("\r\n");
    const obs = parseEditorCsv(csv);
    expect(obs).toContainEqual({ name: "Brand Search", field: "daily_budget", value: 160 });
    expect(obs).toContainEqual({ name: "Brand Search", field: "status", value: "Paused" });
    expect(obs).toContainEqual({ name: "Brand Search", field: "negative_keywords", value: [{ text: "free", match: "BROAD" }, { text: "jobs", match: "PHRASE" }] });
    expect(compareObserved(plan(), obs).results.slice(0, 3).map((r) => r.status)).toEqual(["verified", "verified", "verified"]);
    expect(() => parseObserved("a,b\n1,2", "google-editor-csv")).toThrow(/no "Campaign" column/);
  });
});

describe("verifyPlan", () => {
  async function struck() {
    const { row } = await proposePlan(h.deps, { workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: proposals as never });
    await approvePlan(h.deps, row.number, { approver: "cli:omar", channel: "cli" });
    await strikePlan(h.deps, row.number, { actor: "cli:omar" });
    return row.number;
  }

  it("moves an exported plan to verified, writes verification.json and a ledger entry", async () => {
    const n = await struck();
    const { row, report } = await verifyPlan(h.deps, n, good, { actor: "cli:omar", observedSha256: "abc" });
    expect(row.state).toBe("verified");
    expect(report.all_verified).toBe(true);
    const file = JSON.parse(await readFile(join(h.dir, "exports", report.plan_id, "verification.json"), "utf8"));
    expect(file).toMatchObject({ all_verified: true, observed_sha256: "abc", plan_hash: report.plan_hash });
    expect((await h.events()).find((e) => e.event === "plan.verified")!.payload).toMatchObject({ number: n, observed_sha256: "abc" });
  });

  it("leaves the plan exported and logs a failure when something does not match", async () => {
    const n = await struck();
    const { row, report } = await verifyPlan(h.deps, n, good.slice(1), { actor: "cli:omar" });
    expect(row.state).toBe("exported");
    expect(report.all_verified).toBe(false);
    expect((await h.events()).some((e) => e.event === "plan.verify_failed")).toBe(true);
  });

  it("can be re-run: a failed verify followed by a good one verifies, and a verified plan stays verified", async () => {
    const n = await struck();
    await verifyPlan(h.deps, n, [], { actor: "cli:omar" });
    expect((await verifyPlan(h.deps, n, good, { actor: "cli:omar" })).row.state).toBe("verified");
    expect((await verifyPlan(h.deps, n, good, { actor: "cli:omar" })).row.state).toBe("verified");
  });

  it("refuses a plan that was never struck", async () => {
    const { row } = await proposePlan(h.deps, { workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: proposals as never });
    await expect(verifyPlan(h.deps, row.number, good, { actor: "cli:omar" })).rejects.toBeInstanceOf(PlanStateError);
  });
});
