import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-store-"));
  file = join(dir, ".medjay", "experiments.db");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const usage = (over: Record<string, unknown> = {}) => ({
  slot: "reasoning" as const,
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  inputTokens: 1000,
  outputTokens: 200,
  latencyMs: 1500,
  ok: true,
  ...over,
});

describe("Store", () => {
  it("creates the database (and its folder) at the fixed path and reports its schema version", async () => {
    const store = Store.open(file);
    expect((await stat(file)).isFile()).toBe(true);
    expect(store.schemaVersion()).toBe(4);
    store.close();
  });

  it("uses WAL mode so concurrent runs do not block readers", () => {
    const store = Store.open(file);
    expect(store.journalMode()).toBe("wal");
    store.close();
  });

  it("keeps data across reopen without re-running migrations", () => {
    const first = Store.open(file);
    first.recordUsage(usage());
    first.close();
    const second = Store.open(file);
    expect(second.schemaVersion()).toBe(4);
    expect(second.usageSummary()).toHaveLength(1);
    second.close();
  });

  it("summarizes usage by slot, provider and model", () => {
    const store = Store.open(file);
    store.recordUsage(usage());
    store.recordUsage(usage({ inputTokens: 500, outputTokens: 100, latencyMs: 500, cachedTokens: 300, costUsd: 0.01 }));
    store.recordUsage(usage({ ok: false, errorKind: "timeout", inputTokens: 0, outputTokens: 0, latencyMs: 60000 }));
    store.recordUsage(usage({ slot: "fast", provider: "ollama", model: "qwen2.5", inputTokens: 50, outputTokens: 10, latencyMs: 90000 }));
    const rows = store.usageSummary();
    const reasoning = rows.find((r) => r.slot === "reasoning")!;
    expect(reasoning).toMatchObject({ calls: 3, failures: 1, inputTokens: 1500, outputTokens: 300, cachedTokens: 300 });
    expect(reasoning.costUsd).toBeCloseTo(0.01);
    expect(rows.find((r) => r.slot === "fast")).toMatchObject({ calls: 1, failures: 0, costUsd: null });
    store.close();
  });

  it("filters the summary by start time", () => {
    const store = Store.open(file);
    store.recordUsage(usage({ ts: "2026-01-01T00:00:00.000Z" }));
    store.recordUsage(usage({ ts: "2026-10-17T00:00:00.000Z" }));
    expect(store.usageSummary("2026-06-01T00:00:00.000Z")[0]).toMatchObject({ calls: 1 });
    store.close();
  });

  it("records the surface and summarizes by it, defaulting to other", () => {
    const store = Store.open(file);
    store.recordUsage(usage({ surface: "internal_narration", outputTokens: 40 }));
    store.recordUsage(usage({ surface: "internal_narration", outputTokens: 60 }));
    store.recordUsage(usage({ surface: "client_copy", outputTokens: 300 }));
    store.recordUsage(usage());
    const rows = store.usageSummary(undefined, { bySurface: true });
    expect(rows.map((r) => [r.surface, r.calls, r.outputTokens])).toEqual([
      ["client_copy", 1, 300],
      ["internal_narration", 2, 100],
      ["other", 1, 200],
    ]);
    expect(store.usageSummary()).toHaveLength(1);
    expect(store.usageSummary()[0]).not.toHaveProperty("surface");
    store.close();
  });

  it("upgrades a version 2 database in place, keeping old rows as surface other", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".medjay"), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE usage_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, job TEXT, slot TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, latency_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error_kind TEXT)");
    old.exec("CREATE TABLE plans (number INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL UNIQUE, plan_hash TEXT NOT NULL, state TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL, file TEXT NOT NULL); CREATE TABLE approvals (id INTEGER PRIMARY KEY, plan_number INTEGER NOT NULL, plan_hash TEXT NOT NULL, approver TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, signature TEXT NOT NULL); CREATE TABLE confirmations (plan_number INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0); CREATE TABLE action_results (plan_number INTEGER NOT NULL, action_id TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, artifact TEXT, ts TEXT NOT NULL, PRIMARY KEY (plan_number, action_id))");
    old.exec("INSERT INTO usage_events (ts, slot, provider, model, latency_ms, ok) VALUES ('2026-10-01T00:00:00.000Z', 'fast', 'ollama', 'qwen2.5', 10, 1)");
    old.exec("PRAGMA user_version = 2");
    old.close();
    const store = Store.open(file);
    expect(store.schemaVersion()).toBe(4);
    expect(store.usageSummary(undefined, { bySurface: true })[0]).toMatchObject({ surface: "other", calls: 1 });
    store.close();
  });

  it("validates usage records", () => {
    const store = Store.open(file);
    expect(() => store.recordUsage(usage({ slot: "bogus" }))).toThrow(/slot/);
    expect(() => store.recordUsage(usage({ surface: "billboard" }))).toThrow(/surface/);
    expect(() => store.recordUsage(usage({ inputTokens: -1 }))).toThrow(/token/i);
    expect(() => store.recordUsage(usage({ latencyMs: 1.5 }))).toThrow(/latency/i);
    expect(store.usageSummary()).toHaveLength(0);
    store.close();
  });

  it("allows two connections to write the same file", () => {
    const a = Store.open(file);
    const b = Store.open(file);
    for (let i = 0; i < 20; i += 1) (i % 2 === 0 ? a : b).recordUsage(usage());
    expect(a.usageSummary()[0]).toMatchObject({ calls: 20 });
    a.close();
    b.close();
  });

  it("works under an Arabic folder name", async () => {
    const arabic = join(dir, "عميل");
    await mkdir(arabic);
    const store = Store.open(join(arabic, "experiments.db"));
    store.recordUsage(usage());
    expect(store.usageSummary()).toHaveLength(1);
    store.close();
  });
});
