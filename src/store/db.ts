// Machine-state store: SQLite at .medjay/experiments.db (fixed path, never configurable).
// Uses node:sqlite (built into Node 22.13+), so there is no native dependency to install.
// Schema changes are versioned with PRAGMA user_version.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SLOT_NAMES, USAGE_SURFACES, type SlotName, type UsageSurface } from "../constants.js";

const SCHEMA_VERSION = 8;

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
  // 4: agent runs and their checkpointed steps (resume without re-running or re-billing finished steps)
  `CREATE TABLE runs (
     run_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     surface TEXT NOT NULL,
     slot TEXT NOT NULL,
     task TEXT NOT NULL,
     language TEXT NOT NULL,
     status TEXT NOT NULL,
     stop_reason TEXT,
     policy_hash TEXT NOT NULL,
     limits_json TEXT NOT NULL,
     steps_done INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     cost_known INTEGER NOT NULL DEFAULT 1,
     nudged INTEGER NOT NULL DEFAULT 0,
     final_text TEXT,
     pending_json TEXT,
     error_json TEXT,
     lease_until TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX runs_created ON runs (created_at);
   CREATE TABLE run_steps (
     run_id TEXT NOT NULL REFERENCES runs (run_id),
     step_index INTEGER NOT NULL,
     phase TEXT NOT NULL,
     assistant_text TEXT NOT NULL,
     tool_calls_json TEXT NOT NULL,
     tool_results_json TEXT NOT NULL,
     usage_json TEXT NOT NULL,
     model_json TEXT NOT NULL,
     nudge INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     PRIMARY KEY (run_id, step_index)
   );`,
  // 5: ingested data (ad platform exports, web analytics, CRM). Phone numbers are stored only as hashes.
  `CREATE TABLE sources (
     source_id TEXT PRIMARY KEY,
     mapping_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     platform TEXT,
     file TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     rows INTEGER NOT NULL,
     issues_json TEXT NOT NULL,
     period_start TEXT,
     period_end TEXT,
     ingested_at TEXT NOT NULL
   );
   CREATE TABLE fact_daily (
     source_id TEXT NOT NULL REFERENCES sources (source_id),
     date TEXT NOT NULL,
     platform TEXT NOT NULL,
     campaign TEXT NOT NULL,
     adset TEXT NOT NULL,
     spend REAL NOT NULL,
     impressions REAL NOT NULL,
     clicks REAL NOT NULL,
     conversions REAL NOT NULL,
     conv_value REAL NOT NULL,
     currency TEXT NOT NULL
   );
   CREATE INDEX fact_daily_date ON fact_daily (date);
   CREATE TABLE web_sessions (
     source_id TEXT NOT NULL REFERENCES sources (source_id),
     date TEXT NOT NULL,
     landing_page TEXT NOT NULL,
     source TEXT NOT NULL,
     campaign TEXT NOT NULL,
     sessions REAL NOT NULL,
     key_events REAL NOT NULL
   );
   CREATE TABLE leads (
     lead_id TEXT NOT NULL,
     source_id TEXT NOT NULL REFERENCES sources (source_id),
     created_at TEXT NOT NULL,
     utm_source TEXT NOT NULL,
     campaign TEXT NOT NULL,
     adset TEXT NOT NULL,
     click_id TEXT,
     phone_hash TEXT,
     channel TEXT,
     first_response_seconds REAL,
     ghosted_after_price INTEGER,
     PRIMARY KEY (source_id, lead_id)
   );
   CREATE TABLE lead_stage_events (
     lead_id TEXT NOT NULL,
     source_id TEXT NOT NULL REFERENCES sources (source_id),
     stage TEXT NOT NULL,
     entered_at TEXT NOT NULL
   );
   CREATE TABLE deals (
     deal_id TEXT NOT NULL,
     lead_id TEXT NOT NULL,
     source_id TEXT NOT NULL REFERENCES sources (source_id),
     value REAL NOT NULL,
     currency TEXT NOT NULL,
     won_at TEXT NOT NULL,
     PRIMARY KEY (source_id, deal_id)
   );`,
  // 6: simulations a plan can be bound to (content-addressed ids; inputs hashed, never copied into plans)
  `CREATE TABLE simulations (
     sim_id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     seed INTEGER NOT NULL,
     draws INTEGER NOT NULL,
     spend REAL NOT NULL,
     scale_pct REAL,
     elasticity REAL NOT NULL,
     currency TEXT NOT NULL,
     horizon_days INTEGER NOT NULL,
     inputs_hash TEXT NOT NULL,
     source_plan_hash TEXT,
     target TEXT NOT NULL,
     p10 REAL NOT NULL,
     p50 REAL NOT NULL,
     p90 REAL NOT NULL,
     p_positive REAL NOT NULL
   );`,
  // 7: the command bridge: every inbound message once (replay protection), a checkpointed job queue, kill-switch state
  `CREATE TABLE bridge_messages (
     message_id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     received_at TEXT NOT NULL,
     sender_hash TEXT NOT NULL,
     via TEXT NOT NULL,
     command TEXT NOT NULL,
     outcome TEXT NOT NULL
   );
   CREATE INDEX bridge_messages_sender ON bridge_messages (sender_hash, received_at);
   CREATE TABLE bridge_jobs (
     job_id INTEGER PRIMARY KEY AUTOINCREMENT,
     message_id TEXT NOT NULL,
     sender_hash TEXT NOT NULL,
     kind TEXT NOT NULL,
     args_json TEXT NOT NULL,
     status TEXT NOT NULL,
     result_text TEXT,
     error TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     lease_until TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE bridge_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 8: period summaries from platform UI exports that have no date column (one row per campaign, search term, device...)
  `CREATE TABLE fact_period (
     source_id TEXT NOT NULL REFERENCES sources (source_id),
     platform TEXT NOT NULL,
     period_start TEXT NOT NULL,
     period_end TEXT NOT NULL,
     dimension TEXT NOT NULL,
     key TEXT NOT NULL,
     spend REAL NOT NULL,
     impressions REAL NOT NULL,
     clicks REAL NOT NULL,
     conversions REAL NOT NULL,
     conv_value REAL NOT NULL,
     currency TEXT NOT NULL
   );
   CREATE INDEX fact_period_dim ON fact_period (dimension, period_start);`,
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
