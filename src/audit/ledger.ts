// Tamper-evident append-only ledger (JSON Lines).
//   hash = SHA-256( prev_hash + canonicalJson({seq, ts, actor, event, payload}) )
// starting from a fixed all-zero genesis hash. A hash chain makes tampering evident, not
// impossible: someone who can rewrite the whole file can rewrite the whole chain, and deleting
// the final entries is invisible unless the head hash was recorded elsewhere (expectedHead).
import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical.js";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerEntry {
  seq: number;
  ts: string;
  actor: string;
  event: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export type LedgerFailureKind =
  | "malformed_line"
  | "bad_shape"
  | "seq_mismatch"
  | "prev_hash_mismatch"
  | "hash_mismatch"
  | "truncated_tail"
  | "head_mismatch";

export interface LedgerFailure {
  kind: LedgerFailureKind;
  line: number;
  seq?: number;
  message: string;
}

export type VerifyResult =
  | { ok: true; entries: number; head: string }
  | { ok: false; entries: number; failure: LedgerFailure };

export class LedgerCorruptError extends Error {
  constructor(readonly failure: LedgerFailure) {
    super(`ledger is corrupt (${failure.kind}) at line ${failure.line}: ${failure.message}`);
    this.name = "LedgerCorruptError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = ["seq", "ts", "actor", "event", "payload", "prev_hash", "hash"] as const;

export function computeHash(prevHash: string, body: Omit<LedgerEntry, "prev_hash" | "hash">): string {
  const canonical = canonicalJson({
    seq: body.seq,
    ts: body.ts,
    actor: body.actor,
    event: body.event,
    payload: body.payload,
  });
  return createHash("sha256").update(prevHash + canonical, "utf8").digest("hex");
}

function parseEntry(row: string, line: number): LedgerEntry | LedgerFailure {
  let raw: unknown;
  try {
    raw = JSON.parse(row);
  } catch {
    return { kind: "malformed_line", line, message: "line is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "bad_shape", line, message: "entry is not a JSON object" };
  }
  const entry = raw as Record<string, unknown>;
  const keys = Object.keys(entry);
  const exact =
    keys.length === ENTRY_KEYS.length && ENTRY_KEYS.every((key) => Object.hasOwn(entry, key));
  if (!exact) {
    return { kind: "bad_shape", line, message: "entry has missing or unexpected fields" };
  }
  const ok =
    Number.isInteger(entry.seq) &&
    (entry.seq as number) >= 1 &&
    typeof entry.ts === "string" &&
    typeof entry.actor === "string" &&
    entry.actor !== "" &&
    typeof entry.event === "string" &&
    entry.event !== "" &&
    typeof entry.prev_hash === "string" &&
    HEX64.test(entry.prev_hash) &&
    typeof entry.hash === "string" &&
    HEX64.test(entry.hash);
  if (!ok) return { kind: "bad_shape", line, message: "entry field has the wrong type or format" };
  return entry as unknown as LedgerEntry;
}

function isFailure(value: LedgerEntry | LedgerFailure): value is LedgerFailure {
  return "kind" in value;
}

function splitRows(text: string): { rows: string[]; endsWithNewline: boolean } {
  const endsWithNewline = text.endsWith("\n");
  const rows = text.split("\n").map((row) => (row.endsWith("\r") ? row.slice(0, -1) : row));
  if (endsWithNewline) rows.pop();
  return { rows, endsWithNewline };
}

export interface VerifyOptions {
  /** Head hash recorded outside the ledger; detects deletion of trailing entries. */
  expectedHead?: string;
}

export async function verifyLedger(path: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return finish(0, GENESIS_HASH, options);
    }
    throw error;
  }
  if (text === "") return finish(0, GENESIS_HASH, options);

  const { rows, endsWithNewline } = splitRows(text);
  let prevHash = GENESIS_HASH;
  let verified = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const line = index + 1;
    const row = rows[index] as string;
    const isLast = index === rows.length - 1;
    if (isLast && !endsWithNewline) {
      return fail(verified, {
        kind: "truncated_tail",
        line,
        message: "final line has no terminating newline (interrupted write or truncation)",
      });
    }
    const parsed = parseEntry(row, line);
    if (isFailure(parsed)) return fail(verified, parsed);
    const expectedSeq = verified + 1;
    if (parsed.seq !== expectedSeq) {
      return fail(verified, {
        kind: "seq_mismatch",
        line,
        seq: parsed.seq,
        message: `expected seq ${expectedSeq}, found ${parsed.seq} (entry deleted, duplicated or reordered)`,
      });
    }
    if (parsed.prev_hash !== prevHash) {
      return fail(verified, {
        kind: "prev_hash_mismatch",
        line,
        seq: parsed.seq,
        message: "prev_hash does not match the previous entry (chain link broken)",
      });
    }
    if (computeHash(prevHash, parsed) !== parsed.hash) {
      return fail(verified, {
        kind: "hash_mismatch",
        line,
        seq: parsed.seq,
        message: "entry contents do not match its hash (entry was modified)",
      });
    }
    prevHash = parsed.hash;
    verified += 1;
  }
  return finish(verified, prevHash, options);
}

function fail(entries: number, failure: LedgerFailure): VerifyResult {
  return { ok: false, entries, failure };
}

function finish(entries: number, head: string, options: VerifyOptions): VerifyResult {
  if (options.expectedHead !== undefined && options.expectedHead !== head) {
    return fail(entries, {
      kind: "head_mismatch",
      line: entries,
      message: "ledger head differs from the expected head (trailing entries removed or replaced)",
    });
  }
  return { ok: true, entries, head };
}

// ---- append side -------------------------------------------------------------------------

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const TAIL_WINDOW_BYTES = 64 * 1024;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      // EPERM/EACCES: on Windows a lock file another process just deleted is "pending delete"
      // and refuses to be recreated for a moment. That is contention, not a failure.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > LOCK_STALE_MS) await unlink(lockPath);
      } catch {
        // lock vanished between checks; retry immediately
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ledger lock ${lockPath} (last error: ${code})`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function readLastLine(path: string): Promise<{ row: string; terminated: boolean } | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    let window = Math.min(TAIL_WINDOW_BYTES, size);
    for (;;) {
      const buffer = Buffer.alloc(window);
      await handle.read(buffer, 0, window, size - window);
      const text = buffer.toString("utf8");
      const terminated = text.endsWith("\n");
      const body = terminated ? text.slice(0, -1) : text;
      const start = body.lastIndexOf("\n");
      if (start !== -1 || window === size) {
        const row = body.slice(start + 1);
        return { row: row.endsWith("\r") ? row.slice(0, -1) : row, terminated };
      }
      window = Math.min(window * 2, size);
    }
  } finally {
    await handle.close();
  }
}

export interface LedgerOptions {
  now?: () => Date;
}

export interface AppendInput {
  actor: string;
  event: string;
  payload: unknown;
}

export class Ledger {
  private readonly now: () => Date;

  constructor(
    private readonly path: string,
    options: LedgerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Last entry's seq and hash, or genesis for an empty ledger. Throws if the tail is damaged. */
  async head(): Promise<{ seq: number; hash: string }> {
    const last = await this.readValidatedTail();
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  async append(input: AppendInput): Promise<LedgerEntry> {
    if (typeof input.actor !== "string" || input.actor === "") throw new Error("ledger entry needs an actor");
    if (typeof input.event !== "string" || input.event === "") throw new Error("ledger entry needs an event");
    // Fail before touching the file if the payload cannot be canonicalized.
    canonicalJson(input.payload);

    await mkdir(dirname(this.path), { recursive: true });
    return withLock(`${this.path}.lock`, async () => {
      const last = await this.readValidatedTail();
      const body = {
        seq: (last?.seq ?? 0) + 1,
        ts: this.now().toISOString(),
        actor: input.actor,
        event: input.event,
        payload: input.payload,
      };
      const prev_hash = last?.hash ?? GENESIS_HASH;
      const entry: LedgerEntry = { ...body, prev_hash, hash: computeHash(prev_hash, body) };
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return entry;
    });
  }

  private async readValidatedTail(): Promise<LedgerEntry | null> {
    const tail = await readLastLine(this.path);
    if (tail === null) return null;
    const line = 0; // tail check does not know the absolute line number
    if (!tail.terminated) {
      throw new LedgerCorruptError({
        kind: "truncated_tail",
        line,
        message: "final line has no terminating newline; run `mdj ledger verify`",
      });
    }
    const parsed = parseEntry(tail.row, line);
    if (isFailure(parsed)) throw new LedgerCorruptError(parsed);
    const { prev_hash, hash: _hash, ...rest } = parsed;
    if (computeHash(prev_hash, rest) !== parsed.hash) {
      throw new LedgerCorruptError({
        kind: "hash_mismatch",
        line,
        seq: parsed.seq,
        message: "last entry does not match its hash; run `mdj ledger verify`",
      });
    }
    return parsed;
  }
}
