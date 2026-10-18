// Plan state in SQLite: the lifecycle state machine, approvals (with unique nonces), two-step
// confirmation codes, and per-action results. The plan FILE is the content; this is the state.
import { createHash } from "node:crypto";
import type { Store } from "../store/db.js";
import type { Plan } from "./types.js";
import { ConfirmationError, PlanNotFoundError, PlanStateError, ReplayError } from "./errors.js";

export type PlanState =
  | "proposed"
  | "held"
  | "approved"
  | "executing"
  | "executed"
  | "exported"
  | "partial"
  | "failed"
  | "verified"
  | "rejected"
  | "expired"
  | "rolled_back";

const TRANSITIONS: Record<PlanState, readonly PlanState[]> = {
  proposed: ["approved", "held", "rejected", "expired"],
  held: ["approved", "proposed", "rejected", "expired"],
  approved: ["executing", "expired"],
  executing: ["executed", "exported", "partial", "failed"],
  partial: ["executing", "expired"],
  failed: ["executing", "expired"],
  executed: ["verified", "rolled_back"],
  exported: ["verified", "rolled_back"],
  verified: ["rolled_back"],
  rejected: [],
  expired: [],
  rolled_back: [],
};

export interface PlanRow {
  number: number;
  plan_id: string;
  plan_hash: string;
  state: PlanState;
  workspace: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
  file: string;
}

export interface ApprovalRow {
  plan_number: number;
  plan_hash: string;
  approver: string;
  channel: string;
  ts: string;
  nonce: string;
  signature: string;
}

export type ActionStatus = "exported" | "recorded" | "failed";

export interface ActionResultRow {
  plan_number: number;
  action_id: string;
  status: ActionStatus;
  detail: string | null;
  artifact: string | null;
  ts: string;
}

export const MAX_CONFIRMATION_ATTEMPTS = 5;
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

const codeHash = (planHash: string, code: string) => createHash("sha256").update(`${planHash}:${code}`, "utf8").digest("hex");

export class PlanRepo {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.database();
  }

  insert(plan: Plan, file: string, now: Date): PlanRow {
    const ts = now.toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO plans (plan_id, plan_hash, state, workspace, created_at, expires_at, updated_at, file)
         VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)`,
      )
      .run(plan.plan_id, plan.plan_hash, plan.workspace, plan.created_at, plan.expires_at, ts, file);
    return this.get(Number(result.lastInsertRowid)) as PlanRow;
  }

  get(number: number): PlanRow | undefined {
    return this.db.prepare("SELECT * FROM plans WHERE number = ?").get(number) as PlanRow | undefined;
  }

  require(number: number): PlanRow {
    const row = this.get(number);
    if (!row) throw new PlanNotFoundError(number);
    return row;
  }

  byId(planId: string): PlanRow | undefined {
    return this.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(planId) as PlanRow | undefined;
  }

  list(state?: PlanState): PlanRow[] {
    return (
      state
        ? this.db.prepare("SELECT * FROM plans WHERE state = ? ORDER BY number").all(state)
        : this.db.prepare("SELECT * FROM plans ORDER BY number").all()
    ) as unknown as PlanRow[];
  }

  transition(number: number, to: PlanState, now: Date): PlanRow {
    const row = this.require(number);
    if (!TRANSITIONS[row.state].includes(to)) {
      throw new PlanStateError(`plan #${number} is ${row.state}; it cannot move to ${to}`);
    }
    const changed = this.db
      .prepare("UPDATE plans SET state = ?, updated_at = ? WHERE number = ? AND state = ?")
      .run(to, now.toISOString(), number, row.state).changes;
    if (Number(changed) !== 1) throw new PlanStateError(`plan #${number} changed state while moving to ${to}; retry`);
    return this.require(number);
  }

  addApproval(approval: ApprovalRow): void {
    try {
      this.db
        .prepare(
          `INSERT INTO approvals (plan_number, plan_hash, approver, channel, ts, nonce, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(approval.plan_number, approval.plan_hash, approval.approver, approval.channel, approval.ts, approval.nonce, approval.signature);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: approvals\.nonce/.test(error.message)) throw new ReplayError();
      throw error;
    }
  }

  approvals(number: number): ApprovalRow[] {
    return this.db
      .prepare("SELECT plan_number, plan_hash, approver, channel, ts, nonce, signature FROM approvals WHERE plan_number = ? ORDER BY id")
      .all(number) as unknown as ApprovalRow[];
  }

  /** Create or replace the confirmation code for a plan, unless a locked one is still in force. */
  setConfirmation(number: number, planHash: string, code: string, now: Date): { expiresAt: string } {
    const existing = this.db.prepare("SELECT attempts, expires_at FROM confirmations WHERE plan_number = ?").get(number) as
      | { attempts: number; expires_at: string }
      | undefined;
    if (existing && existing.attempts >= MAX_CONFIRMATION_ATTEMPTS && existing.expires_at > now.toISOString()) {
      throw new ConfirmationError(`confirmation is locked after too many wrong codes; try again after ${existing.expires_at}`);
    }
    const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO confirmations (plan_number, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
         ON CONFLICT(plan_number) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(number, codeHash(planHash, code), expiresAt);
    return { expiresAt };
  }

  /** Check and consume a confirmation code. Throws ConfirmationError for every failure. */
  takeConfirmation(number: number, planHash: string, code: string, now: Date): void {
    const row = this.db.prepare("SELECT code_hash, expires_at, attempts FROM confirmations WHERE plan_number = ?").get(number) as
      | { code_hash: string; expires_at: string; attempts: number }
      | undefined;
    if (!row) throw new ConfirmationError("no confirmation was requested for this plan; run approve first to get a code");
    if (row.expires_at <= now.toISOString()) {
      this.db.prepare("DELETE FROM confirmations WHERE plan_number = ?").run(number);
      throw new ConfirmationError("the confirmation code expired; run approve again to get a new one");
    }
    if (row.attempts >= MAX_CONFIRMATION_ATTEMPTS) {
      throw new ConfirmationError(`confirmation is locked after too many wrong codes; try again after ${row.expires_at}`);
    }
    if (row.code_hash !== codeHash(planHash, code)) {
      this.db.prepare("UPDATE confirmations SET attempts = attempts + 1 WHERE plan_number = ?").run(number);
      throw new ConfirmationError(`wrong confirmation code (${MAX_CONFIRMATION_ATTEMPTS - row.attempts - 1} attempts left)`);
    }
    this.db.prepare("DELETE FROM confirmations WHERE plan_number = ?").run(number);
  }

  setActionResult(number: number, actionId: string, status: ActionStatus, detail: string | undefined, artifact: string | undefined, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO action_results (plan_number, action_id, status, detail, artifact, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_number, action_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, artifact = excluded.artifact, ts = excluded.ts`,
      )
      .run(number, actionId, status, detail ?? null, artifact ?? null, now.toISOString());
  }

  actionResults(number: number): ActionResultRow[] {
    return this.db.prepare("SELECT * FROM action_results WHERE plan_number = ? ORDER BY action_id").all(number) as unknown as ActionResultRow[];
  }
}
