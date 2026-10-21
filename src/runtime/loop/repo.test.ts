import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../store/db.js";
import { RunRepo, type StoredResult } from "./repo.js";

let dir: string;
let store: Store;
let repo: RunRepo;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-runs-"));
  store = Store.open(join(dir, ".medjay", "experiments.db"));
  repo = new RunRepo(store);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-10-17T12:00:00.000Z");
const create = (id = "run_1") =>
  repo.create({ runId: id, workspaceId: "ws", surface: "diagnosis", slot: "reasoning", task: "Find wasted spend", language: "en", policyHash: "a".repeat(64), limits: { max_steps: 12, max_tokens: 150_000, max_cost_usd: 1 }, now: NOW });
const usage = { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, reasoningTokens: 0 };
const model = { provider: "google", model: "gemini-3.8-flash" };
const call = (n: number) => ({ call_id: `c1_${n}`, name: "read_file", input: { path: `context/f${n}.md` } });
const done = (n: number): StoredResult => ({ call_id: `c1_${n}`, name: "read_file", status: "done", ok: true, output: { text: "x" }, trust: "trusted", source: "file:context/f.md", as_of: NOW.toISOString() });

describe("RunRepo: header", () => {
  it("creates a running run with zeroed counters, the policy hash and the limits", () => {
    const run = create();
    expect(run).toMatchObject({ run_id: "run_1", workspace_id: "ws", surface: "diagnosis", slot: "reasoning", status: "running", steps_done: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_known: true, nudged: false, task: "Find wasted spend", language: "en" });
    expect(run.policy_hash).toBe("a".repeat(64));
    expect(run.limits).toEqual({ max_steps: 12, max_tokens: 150_000, max_cost_usd: 1 });
    expect(run.created_at).toBe(NOW.toISOString());
  });

  it("refuses a duplicate run id and reports an unknown one", () => {
    create();
    expect(() => create()).toThrow(/already/);
    expect(repo.get("nope")).toBeUndefined();
    expect(() => repo.require("nope")).toThrow(/no run/);
  });

  it("lists runs newest first, optionally by status", () => {
    create("run_a");
    repo.create({ runId: "run_b", workspaceId: "ws", surface: "other", slot: "fast", task: "t", language: "en", policyHash: "b".repeat(64), limits: { max_steps: 12, max_tokens: 150_000, max_cost_usd: 1 }, now: new Date(NOW.getTime() + 1000) });
    repo.setStatus("run_a", "completed", { now: NOW, finalText: "done" });
    expect(repo.list().map((r) => r.run_id)).toEqual(["run_b", "run_a"]);
    expect(repo.list("completed").map((r) => r.run_id)).toEqual(["run_a"]);
  });
});

describe("RunRepo: steps are persisted in two phases", () => {
  it("records the model's answer first (so it is never re-billed) and the tool results after", () => {
    create();
    repo.beginStep("run_1", 1, { assistantText: "reading", toolCalls: [call(1), call(2)], usage, model, costUsd: 0.002, costKnown: true, nudge: false, now: NOW });
    let step = repo.steps("run_1")[0]!;
    expect(step).toMatchObject({ step_index: 1, phase: "model_done", assistant_text: "reading", model, nudge: false });
    expect(step.tool_calls).toHaveLength(2);
    expect(step.tool_results).toEqual([]);
    expect(repo.require("run_1")).toMatchObject({ steps_done: 0, input_tokens: 1000, output_tokens: 200 });
    expect(repo.require("run_1").cost_usd).toBeCloseTo(0.002);

    repo.completeStep("run_1", 1, [done(1), done(2)], NOW);
    step = repo.steps("run_1")[0]!;
    expect(step.phase).toBe("complete");
    expect(step.tool_results.map((r) => r.call_id)).toEqual(["c1_1", "c1_2"]);
    expect(repo.require("run_1").steps_done).toBe(1);
  });

  it("accumulates tokens and cost across steps, and flags unknown cost", () => {
    create();
    repo.beginStep("run_1", 1, { assistantText: "", toolCalls: [], usage, model, costUsd: 0.5, costKnown: true, nudge: false, now: NOW });
    repo.completeStep("run_1", 1, [], NOW);
    repo.beginStep("run_1", 2, { assistantText: "", toolCalls: [], usage, model, costUsd: null, costKnown: false, nudge: false, now: NOW });
    const run = repo.require("run_1");
    expect(run).toMatchObject({ input_tokens: 2000, output_tokens: 400, cost_known: false });
    expect(run.cost_usd).toBeCloseTo(0.5);
  });

  it("returns steps in order and refuses a repeated step index", () => {
    create();
    for (const n of [1, 2, 3]) repo.beginStep("run_1", n, { assistantText: String(n), toolCalls: [], usage, model, costUsd: 0, costKnown: true, nudge: false, now: NOW });
    expect(repo.steps("run_1").map((s) => s.step_index)).toEqual([1, 2, 3]);
    expect(() => repo.beginStep("run_1", 2, { assistantText: "again", toolCalls: [], usage, model, costUsd: 0, costKnown: true, nudge: false, now: NOW })).toThrow(/already/);
  });

  it("can amend one result inside a completed step (a human-approved call)", () => {
    create();
    repo.beginStep("run_1", 1, { assistantText: "", toolCalls: [call(1)], usage, model, costUsd: 0, costKnown: true, nudge: false, now: NOW });
    repo.completeStep("run_1", 1, [{ call_id: "c1_1", name: "read_file", status: "pending_approval", ok: false, error: { kind: "approval_required", message: "needs a human" }, trust: "trusted" }], NOW);
    repo.amendResult("run_1", 1, done(1));
    expect(repo.steps("run_1")[0]!.tool_results[0]).toMatchObject({ status: "done", ok: true });
  });
});

describe("RunRepo: status, lease, nudge", () => {
  it("records the final status, text, stop reason, pending call and error, and clears the lease", () => {
    create();
    repo.setLease("run_1", new Date(NOW.getTime() + 600_000));
    repo.setStatus("run_1", "needs_human", { now: NOW, stopReason: "approval_required", pending: { callId: "c2_1", tool: "read_file", step: 2 } });
    const run = repo.require("run_1");
    expect(run).toMatchObject({ status: "needs_human", stop_reason: "approval_required", pending: { callId: "c2_1", tool: "read_file", step: 2 }, lease_until: null });
    repo.setStatus("run_1", "failed", { now: NOW, error: { kind: "auth", message: "no key" } });
    expect(repo.require("run_1").error).toEqual({ kind: "auth", message: "no key" });
  });

  it("stores and reads the lease and the one-time nudge flag", () => {
    create();
    const until = new Date(NOW.getTime() + 600_000);
    repo.setLease("run_1", until);
    expect(repo.require("run_1").lease_until).toBe(until.toISOString());
    repo.setNudged("run_1");
    expect(repo.require("run_1").nudged).toBe(true);
  });

  it("rejects an unknown status", () => {
    create();
    expect(() => repo.setStatus("run_1", "weird" as never, { now: NOW })).toThrow(/status/);
  });
});

describe("store schema 4", () => {
  it("creates the run tables and upgrades a version 3 database in place", async () => {
    expect(store.schemaVersion()).toBe(8);
    const { DatabaseSync } = await import("node:sqlite");
    store.close();
    const raw = new DatabaseSync(join(dir, ".medjay", "experiments.db"));
    raw.exec("DROP TABLE fact_period; DROP TABLE run_steps; DROP TABLE runs; DROP TABLE bridge_state; DROP TABLE bridge_jobs; DROP TABLE bridge_messages; DROP TABLE simulations; DROP TABLE deals; DROP TABLE lead_stage_events; DROP TABLE leads; DROP TABLE web_sessions; DROP TABLE fact_daily; DROP TABLE sources; PRAGMA user_version = 3");
    raw.close();
    store = Store.open(join(dir, ".medjay", "experiments.db"));
    expect(store.schemaVersion()).toBe(8);
    repo = new RunRepo(store);
    expect(create().status).toBe("running");
  });
});
