// Run checkpoints in SQLite. A step is persisted in two phases so a crash never costs a second model
// bill: phase `model_done` is written the moment the model answers (its text, calls and usage), and
// phase `complete` once the tool results are in. `mdj resume` continues from whatever is saved.
// Everything stored here has already been redacted by the caller.
import type { UsageSurface, SlotName } from "../../constants.js";
import type { Store } from "../../store/db.js";
import type { Trust } from "../registry.js";

export const RUN_STATUSES = ["running", "completed", "needs_human", "max_steps_reached", "max_tokens_reached", "max_cost_reached", "aborted", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Statuses a run can still be resumed from (running only when its lease has expired). */
export const RESUMABLE: readonly RunStatus[] = ["needs_human", "aborted", "failed", "running"];

export interface RunLimits {
  max_steps: number;
  max_tokens: number;
  max_cost_usd: number;
}

export interface PendingCall {
  callId: string;
  tool: string;
  step: number;
}

export interface RunHeader {
  run_id: string;
  workspace_id: string;
  surface: UsageSurface;
  slot: SlotName;
  task: string;
  language: string;
  status: RunStatus;
  stop_reason: string | null;
  policy_hash: string;
  limits: RunLimits;
  steps_done: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_known: boolean;
  nudged: boolean;
  final_text: string | null;
  pending: PendingCall | null;
  error: { kind: string; message: string } | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredCall {
  call_id: string;
  name: string;
  input: unknown;
}

export interface StoredResult {
  call_id: string;
  name: string;
  status: "done" | "pending_approval" | "skipped";
  ok: boolean;
  output?: unknown;
  error?: { kind: string; message: string };
  trust: Trust;
  source?: string;
  as_of?: string;
}

export interface StepUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface StepRecord {
  run_id: string;
  step_index: number;
  phase: "model_done" | "complete";
  assistant_text: string;
  tool_calls: StoredCall[];
  tool_results: StoredResult[];
  usage: StepUsageRecord;
  model: { provider: string; model: string };
  nudge: boolean;
  created_at: string;
}

export interface NewRun {
  runId: string;
  workspaceId: string;
  surface: UsageSurface;
  slot: SlotName;
  task: string;
  language: string;
  policyHash: string;
  limits: RunLimits;
  now: Date;
}

export interface BeginStep {
  assistantText: string;
  toolCalls: StoredCall[];
  usage: StepUsageRecord;
  model: { provider: string; model: string };
  costUsd: number | null;
  costKnown: boolean;
  nudge: boolean;
  now: Date;
}

type Row = Record<string, unknown>;

const parse = <T>(text: unknown): T => JSON.parse(String(text)) as T;

function header(row: Row): RunHeader {
  return {
    run_id: String(row.run_id),
    workspace_id: String(row.workspace_id),
    surface: row.surface as UsageSurface,
    slot: row.slot as SlotName,
    task: String(row.task),
    language: String(row.language),
    status: row.status as RunStatus,
    stop_reason: (row.stop_reason as string | null) ?? null,
    policy_hash: String(row.policy_hash),
    limits: parse<RunLimits>(row.limits_json),
    steps_done: Number(row.steps_done),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cost_usd: Number(row.cost_usd),
    cost_known: Number(row.cost_known) === 1,
    nudged: Number(row.nudged) === 1,
    final_text: (row.final_text as string | null) ?? null,
    pending: row.pending_json ? parse<PendingCall>(row.pending_json) : null,
    error: row.error_json ? parse<{ kind: string; message: string }>(row.error_json) : null,
    lease_until: (row.lease_until as string | null) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function step(row: Row): StepRecord {
  return {
    run_id: String(row.run_id),
    step_index: Number(row.step_index),
    phase: row.phase as StepRecord["phase"],
    assistant_text: String(row.assistant_text),
    tool_calls: parse<StoredCall[]>(row.tool_calls_json),
    tool_results: parse<StoredResult[]>(row.tool_results_json),
    usage: parse<StepUsageRecord>(row.usage_json),
    model: parse<StepRecord["model"]>(row.model_json),
    nudge: Number(row.nudge) === 1,
    created_at: String(row.created_at),
  };
}

export class RunRepo {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.database();
  }

  create(input: NewRun): RunHeader {
    if (this.get(input.runId)) throw new Error(`run ${input.runId} already exists`);
    const ts = input.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (run_id, workspace_id, surface, slot, task, language, status, policy_hash, limits_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(input.runId, input.workspaceId, input.surface, input.slot, input.task, input.language, input.policyHash, JSON.stringify(input.limits), ts, ts);
    return this.require(input.runId);
  }

  get(runId: string): RunHeader | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? header(row) : undefined;
  }

  require(runId: string): RunHeader {
    const run = this.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    return run;
  }

  list(status?: RunStatus): RunHeader[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC, rowid DESC").all(status)
        : this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC").all()
    ) as Row[];
    return rows.map(header);
  }

  steps(runId: string): StepRecord[] {
    return (this.db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_index").all(runId) as Row[]).map(step);
  }

  /** Phase 1: the model has answered (and been billed). Cumulative counters move now, not later. */
  beginStep(runId: string, stepIndex: number, input: BeginStep): void {
    const ts = input.now.toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO run_steps (run_id, step_index, phase, assistant_text, tool_calls_json, tool_results_json, usage_json, model_json, nudge, created_at)
           VALUES (?, ?, 'model_done', ?, ?, '[]', ?, ?, ?, ?)`,
        )
        .run(runId, stepIndex, input.assistantText, JSON.stringify(input.toolCalls), JSON.stringify(input.usage), JSON.stringify(input.model), input.nudge ? 1 : 0, ts);
    } catch (error) {
      if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) throw new Error(`step ${stepIndex} of ${runId} is already recorded`);
      throw error;
    }
    this.db
      .prepare(
        `UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?,
                cost_known = CASE WHEN ? = 1 THEN cost_known ELSE 0 END, updated_at = ? WHERE run_id = ?`,
      )
      .run(input.usage.inputTokens, input.usage.outputTokens, input.costUsd ?? 0, input.costKnown ? 1 : 0, ts, runId);
  }

  /** Phase 2: every tool call in the step has a result (or is pending a human). */
  completeStep(runId: string, stepIndex: number, results: StoredResult[], now: Date): void {
    this.db.prepare("UPDATE run_steps SET phase = 'complete', tool_results_json = ? WHERE run_id = ? AND step_index = ?").run(JSON.stringify(results), runId, stepIndex);
    this.db.prepare("UPDATE runs SET steps_done = MAX(steps_done, ?), updated_at = ? WHERE run_id = ?").run(stepIndex, now.toISOString(), runId);
  }

  /** Replace one result inside a step (a call a human approved after the run paused). */
  amendResult(runId: string, stepIndex: number, result: StoredResult): void {
    const record = this.steps(runId).find((s) => s.step_index === stepIndex);
    if (!record) throw new Error(`no step ${stepIndex} in ${runId}`);
    const results = record.tool_results.map((r) => (r.call_id === result.call_id ? result : r));
    this.db.prepare("UPDATE run_steps SET tool_results_json = ? WHERE run_id = ? AND step_index = ?").run(JSON.stringify(results), runId, stepIndex);
  }

  setStatus(runId: string, status: RunStatus, extra: { now: Date; stopReason?: string; finalText?: string; pending?: PendingCall | null; error?: { kind: string; message: string } | null }): void {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown run status "${status}"`);
    this.db
      .prepare(
        `UPDATE runs SET status = ?, stop_reason = COALESCE(?, stop_reason), final_text = COALESCE(?, final_text),
                pending_json = ?, error_json = COALESCE(?, error_json), lease_until = CASE WHEN ? = 'running' THEN lease_until ELSE NULL END, updated_at = ?
          WHERE run_id = ?`,
      )
      .run(status, extra.stopReason ?? null, extra.finalText ?? null, extra.pending ? JSON.stringify(extra.pending) : null, extra.error ? JSON.stringify(extra.error) : null, status, extra.now.toISOString(), runId);
  }

  /** A resumed run goes back to running under the policy and limits in force now. */
  reopen(runId: string, input: { policyHash: string; limits: RunLimits; now: Date }): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'running', stop_reason = NULL, final_text = NULL, pending_json = NULL, error_json = NULL,
                policy_hash = ?, limits_json = ?, updated_at = ? WHERE run_id = ?`,
      )
      .run(input.policyHash, JSON.stringify(input.limits), input.now.toISOString(), runId);
  }

  setLease(runId: string, until: Date | null): void {
    this.db.prepare("UPDATE runs SET lease_until = ? WHERE run_id = ?").run(until ? until.toISOString() : null, runId);
  }

  setNudged(runId: string): void {
    this.db.prepare("UPDATE runs SET nudged = 1 WHERE run_id = ?").run(runId);
  }
}
