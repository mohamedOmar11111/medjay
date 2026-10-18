// Machine-state store: SQLite at .medjay/experiments.db (fixed path, never configurable).
// Uses node:sqlite (built into Node 22.13+), so there is no native dependency to install.
// Schema changes are versioned with PRAGMA user_version.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SLOT_NAMES, USAGE_SURFACES, type SlotName, type UsageSurface } from "../constants.js";

const SCHEMA_VERSION = 3;

const MIGRATIONS: readonly string[] = [
  // 1: model usage telemetry
  `CREATE TABLE usage_events (
     id INTEGER PRIMARY KEY,
     ts TEXT NOT NULL,
     job TEXT,
     slot TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cached_tokens INTEGER NOT NULL DEFAULT 0,
     reasoning_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL,
     latency_ms INTEGER NOT NULL,
     ok INTEGER NOT NULL,
     error_kind TEXT
   );
   CREATE INDEX usage_events_ts ON usage_events (ts);`,
  // 2: plans, approvals, two-step confirmations, per-action results
  `CREATE TABLE plans (
     number INTEGER PRIMARY KEY AUTOINCREMENT,
     plan_id TEXT NOT NULL UNIQUE,
     plan_hash TEXT NOT NULL,
     state TEXT NOT NULL,
     workspace TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     file TEXT NOT NULL
   );
   CREATE TABLE approvals (
     id INTEGER PRIMARY KEY,
     plan_number INTEGER NOT NULL REFERENCES plans (number),
     plan_hash TEXT NOT NULL,
     approver TEXT NOT NULL,
     channel TEXT NOT NULL,
     ts TEXT NOT NULL,
     nonce TEXT NOT NULL UNIQUE,
     signature TEXT NOT NULL
   );
   CREATE TABLE confirmations (
     plan_number INTEGER PRIMARY KEY REFERENCES plans (number),
     code_hash TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE action_results (
     plan_number INTEGER NOT NULL REFERENCES plans (number),
     action_id TEXT NOT NULL,
     status TEXT NOT NULL,
     detail TEXT,
     artifact TEXT,
     ts TEXT NOT NULL,
     PRIMARY KEY (plan_number, action_id)
   );`,
  // 3: which surface a model call served (internal narration, WhatsApp reply, client copy, diagnosis)
  `ALTER TABLE usage_events ADD COLUMN surface TEXT NOT NULL DEFAULT 'other';`,
];

export interface UsageRecord {
  ts?: string;
  job?: string;
  slot: SlotName;
  surface?: UsageSurface;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  latencyMs: number;
  ok: boolean;
  errorKind?: string;
}

export interface UsageSummaryRow {
  slot: string;
  surface?: string;
  provider: string;
  model: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  avgLatencyMs: number;
}

const nonNegativeInt = (value: number | undefined, label: string): number => {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer`);
  return n;
};

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Store {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      Store.migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new Store(db);
  }

  private static migrate(db: DatabaseSync): void {
    const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema ${current} is newer than this Medjay (${SCHEMA_VERSION}); upgrade Medjay`);
    }
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // another process may have migrated while we waited for the lock
        const now = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
        if (now <= version) {
          db.exec(MIGRATIONS[version] as string);
          db.exec(`PRAGMA user_version = ${version + 1}`);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /** The raw connection, for repositories in other layers (plans). Prefer a repository over ad-hoc SQL. */
  database(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  }

  journalMode(): string {
    return String((this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  }

  recordUsage(record: UsageRecord): void {
    if (!(SLOT_NAMES as readonly string[]).includes(record.slot)) throw new Error(`unknown slot "${record.slot}"`);
    const input = nonNegativeInt(record.inputTokens, "input tokens");
    const output = nonNegativeInt(record.outputTokens, "output tokens");
    const cached = nonNegativeInt(record.cachedTokens, "cached tokens");
    const reasoning = nonNegativeInt(record.reasoningTokens, "reasoning tokens");
    if (!Number.isInteger(record.latencyMs) || record.latencyMs < 0) {
      throw new Error("latency must be a non-negative integer (milliseconds)");
    }
    const surface = record.surface ?? "other";
    if (!(USAGE_SURFACES as readonly string[]).includes(surface)) throw new Error(`unknown surface "${surface}"`);
    this.db
      .prepare(
        `INSERT INTO usage_events
           (ts, job, slot, surface, provider, model, input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd, latency_ms, ok, error_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.ts ?? new Date().toISOString(),
        record.job ?? null,
        record.slot,
        surface,
        record.provider,
        record.model,
        input,
        output,
        cached,
        reasoning,
        record.costUsd ?? null,
        record.latencyMs,
        record.ok ? 1 : 0,
        record.errorKind ?? null,
      );
  }

  /** Usage grouped by slot, provider and model, and by surface too when `bySurface` is set. */
  usageSummary(sinceIso?: string, options: { bySurface?: boolean } = {}): UsageSummaryRow[] {
    const surface = options.bySurface === true;
    const rows = this.db
      .prepare(
        `SELECT slot, ${surface ? "surface," : ""} provider, model,
                COUNT(*) AS calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                SUM(cached_tokens) AS cachedTokens,
                SUM(reasoning_tokens) AS reasoningTokens,
                SUM(cost_usd) AS costUsd,
                AVG(latency_ms) AS avgLatencyMs
           FROM usage_events
          WHERE ts >= ?
          GROUP BY slot, ${surface ? "surface," : ""} provider, model
          ORDER BY slot, ${surface ? "surface," : ""} provider, model`,
      )
      .all(sinceIso ?? "") as Record<string, unknown>[];
    return rows.map((row) => ({
      slot: String(row.slot),
      ...(surface ? { surface: String(row.surface) } : {}),
      provider: String(row.provider),
      model: String(row.model),
      calls: Number(row.calls),
      failures: Number(row.failures),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cachedTokens: Number(row.cachedTokens),
      reasoningTokens: Number(row.reasoningTokens),
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      avgLatencyMs: Number(row.avgLatencyMs),
    }));
  }
}
