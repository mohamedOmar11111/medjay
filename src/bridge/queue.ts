// The bridge's SQLite state: every inbound message once (replay protection), a checkpointed job
// queue for read jobs, and the kill switch. A job that was running when the process died is picked
// up again once its lease expires, so a crash loses nothing and nothing runs twice at the same time.
import type { Store } from "../store/db.js";

export type JobKind = "status" | "pulse" | "scout" | "diagnose" | "simulate" | "help";
export interface Job {
  job_id: number;
  message_id: string;
  sender_hash: string;
  kind: JobKind;
  args: { plan?: number };
  status: "queued" | "running" | "done" | "failed";
  result_text: string | null;
  error: string | null;
  attempts: number;
}

const LEASE_MS = 120_000;
export const MAX_ATTEMPTS = 3;

type Row = Record<string, unknown>;
const toJob = (r: Row): Job => ({
  job_id: Number(r.job_id),
  message_id: String(r.message_id),
  sender_hash: String(r.sender_hash),
  kind: r.kind as JobKind,
  args: JSON.parse(String(r.args_json)) as Job["args"],
  status: r.status as Job["status"],
  result_text: (r.result_text as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  attempts: Number(r.attempts),
});

export class BridgeRepo {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.database();
  }

  /** True the first time a message id is seen, false on every replay. */
  remember(message: { id: string; provider: string; sender_hash: string; via: string }, now: Date): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO bridge_messages (message_id, provider, received_at, sender_hash, via, command, outcome) VALUES (?, ?, ?, ?, ?, 'pending', 'pending')")
      .run(message.id, message.provider, now.toISOString(), message.sender_hash, message.via);
    return Number(r.changes) === 1;
  }

  settle(id: string, command: string, outcome: string): void {
    this.db.prepare("UPDATE bridge_messages SET command = ?, outcome = ? WHERE message_id = ?").run(command, outcome, id);
  }

  recentFrom(senderHash: string, since: Date): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM bridge_messages WHERE sender_hash = ? AND received_at > ?").get(senderHash, since.toISOString()) as Row).n);
  }

  isPaused(): boolean {
    return (this.db.prepare("SELECT value FROM bridge_state WHERE key = 'paused'").get() as Row | undefined)?.value === "1";
  }

  setPaused(paused: boolean, now: Date): void {
    this.db.prepare("INSERT INTO bridge_state (key, value, updated_at) VALUES ('paused', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(paused ? "1" : "0", now.toISOString());
  }

  enqueue(job: { message_id: string; sender_hash: string; kind: JobKind; args: Job["args"] }, now: Date): number {
    const ts = now.toISOString();
    const r = this.db.prepare("INSERT INTO bridge_jobs (message_id, sender_hash, kind, args_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(job.message_id, job.sender_hash, job.kind, JSON.stringify(job.args), ts, ts);
    return Number(r.lastInsertRowid);
  }

  get(id: number): Job | undefined {
    const r = this.db.prepare("SELECT * FROM bridge_jobs WHERE job_id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : undefined;
  }

  /** Claim the oldest runnable job: queued, or running with an expired lease (its worker died). */
  claim(now: Date): Job | undefined {
    const r = this.db
      .prepare("SELECT * FROM bridge_jobs WHERE (status = 'queued' OR (status = 'running' AND lease_until < ?)) AND attempts < ? ORDER BY job_id LIMIT 1")
      .get(now.toISOString(), MAX_ATTEMPTS) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("UPDATE bridge_jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE job_id = ?").run(new Date(now.getTime() + LEASE_MS).toISOString(), now.toISOString(), Number(r.job_id));
    return toJob({ ...r, attempts: Number(r.attempts) + 1 });
  }

  finish(id: number, result: { text: string } | { error: string }, now: Date): void {
    const ts = now.toISOString();
    if ("text" in result) this.db.prepare("UPDATE bridge_jobs SET status = 'done', result_text = ?, lease_until = NULL, updated_at = ? WHERE job_id = ?").run(result.text, ts, id);
    else this.db.prepare("UPDATE bridge_jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END, error = ?, lease_until = NULL, updated_at = ? WHERE job_id = ?").run(MAX_ATTEMPTS, result.error, ts, id);
  }

  pending(): Job[] {
    return (this.db.prepare("SELECT * FROM bridge_jobs WHERE status IN ('queued','running') ORDER BY job_id").all() as Row[]).map(toJob);
  }
}
