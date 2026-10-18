import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, Ledger, LedgerCorruptError, verifyLedger } from "./ledger.js";

const FIXED = new Date("2026-10-17T00:00:00.000Z");
const clock = () => FIXED;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-ledger-"));
  file = join(dir, "audit-log.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(count: number, path = file): Promise<Ledger> {
  const ledger = new Ledger(path, { now: clock });
  for (let i = 1; i <= count; i += 1) {
    await ledger.append({ actor: "owner", event: `event.${i}`, payload: { n: i, note: `entry ${i}` } });
  }
  return ledger;
}

const lines = async (path = file) => (await readFile(path, "utf8")).split("\n");
const writeLines = (rows: string[], path = file) => writeFile(path, rows.join("\n"), "utf8");

describe("genesis and hashing", () => {
  it("uses a fixed all-zero genesis hash", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  it("matches an independently computed SHA-256(prev_hash + canonical entry JSON)", async () => {
    const ledger = new Ledger(file, { now: clock });
    const entry = await ledger.append({ actor: "owner", event: "x", payload: { b: 2, a: 1 } });
    const canonical =
      '{"actor":"owner","event":"x","payload":{"a":1,"b":2},"seq":1,"ts":"2026-10-17T00:00:00.000Z"}';
    const expected = createHash("sha256").update("0".repeat(64) + canonical, "utf8").digest("hex");
    expect(entry.prev_hash).toBe(GENESIS_HASH);
    expect(entry.hash).toBe(expected);
  });

  it("produces byte-identical files for identical inputs", async () => {
    const other = join(dir, "other.jsonl");
    await seed(4, file);
    await seed(4, other);
    expect(await readFile(file, "utf8")).toBe(await readFile(other, "utf8"));
  });
});

describe("valid append and verification", () => {
  it("appends multiple entries and verifies the chain", async () => {
    const ledger = await seed(5);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toBe(5);
    expect(result.head).toBe((await ledger.head()).hash);
  });

  it("numbers entries from 1, links each to its predecessor, and ends the file with LF", async () => {
    await seed(3);
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toMatch(/\r/);
    const entries = raw.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0].prev_hash).toBe(GENESIS_HASH);
    expect(entries[1].prev_hash).toBe(entries[0].hash);
    expect(entries[2].prev_hash).toBe(entries[1].hash);
  });

  it("treats a missing or empty ledger as valid with zero entries", async () => {
    const missing = await verifyLedger(join(dir, "nope.jsonl"));
    expect(missing).toMatchObject({ ok: true, entries: 0, head: GENESIS_HASH });
    await writeFile(file, "", "utf8");
    expect(await verifyLedger(file)).toMatchObject({ ok: true, entries: 0, head: GENESIS_HASH });
  });

  it("works under a folder with an Arabic name", async () => {
    const arabic = join(dir, "عميل-السعودية");
    await mkdir(arabic);
    const path = join(arabic, "audit-log.jsonl");
    await seed(2, path);
    expect(await verifyLedger(path)).toMatchObject({ ok: true, entries: 2 });
  });

  it("serializes concurrent appends from separate instances into one valid chain", async () => {
    const writers = Array.from({ length: 4 }, () => new Ledger(file, { now: clock }));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writers[i % 4]!.append({ actor: "agent", event: "concurrent", payload: { i } }),
      ),
    );
    const result = await verifyLedger(file);
    expect(result).toMatchObject({ ok: true, entries: 20 });
    const seqs = (await lines()).filter(Boolean).map((l) => JSON.parse(l).seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("line-ending robustness", () => {
  it("verifies a ledger whose line endings were converted to CRLF", async () => {
    await seed(4);
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.replace(/\n/g, "\r\n"), "utf8");
    expect(await verifyLedger(file)).toMatchObject({ ok: true, entries: 4 });
  });

  it("keeps CRLF inside a payload string intact and verifiable", async () => {
    const ledger = new Ledger(file, { now: clock });
    await ledger.append({ actor: "owner", event: "note", payload: { text: "a\r\nb" } });
    expect(await verifyLedger(file)).toMatchObject({ ok: true, entries: 1 });
  });
});

describe("tamper detection", () => {
  it("detects a one-byte change to a payload in the middle of the log", async () => {
    await seed(5);
    const rows = await lines();
    rows[2] = rows[2]!.replace('"entry 3"', '"entry 4"');
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: "hash_mismatch", line: 3, seq: 3 });
    expect(result.entries).toBe(2);
  });

  it("detects a rewritten hash field", async () => {
    await seed(3);
    const rows = await lines();
    const entry = JSON.parse(rows[1]!);
    entry.hash = "f".repeat(64);
    rows[1] = JSON.stringify(entry);
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "hash_mismatch", line: 2 });
  });

  it("detects a deleted line through the sequence gap", async () => {
    await seed(5);
    const rows = await lines();
    rows.splice(2, 1);
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "seq_mismatch", line: 3 });
  });

  it("detects a deleted line even when the attacker renumbers later sequences (broken prev_hash link)", async () => {
    await seed(5);
    const rows = await lines();
    rows.splice(2, 1);
    const fixed = rows.map((row, index) => {
      if (!row) return row;
      const entry = JSON.parse(row);
      entry.seq = index + 1;
      return JSON.stringify(entry);
    });
    await writeLines(fixed);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "prev_hash_mismatch", line: 3 });
  });

  it("detects reordered lines", async () => {
    await seed(4);
    const rows = await lines();
    [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "seq_mismatch", line: 2 });
  });

  it("rejects an entry carrying an extra field that the hash would not cover", async () => {
    await seed(2);
    const rows = await lines();
    const entry = JSON.parse(rows[1]!);
    entry.approved_by = "attacker";
    rows[1] = JSON.stringify(entry);
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "bad_shape", line: 2 });
  });

  it("detects an entry with missing or wrongly typed fields", async () => {
    await seed(2);
    const rows = await lines();
    const entry = JSON.parse(rows[1]!);
    delete entry.actor;
    rows[1] = JSON.stringify(entry);
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "bad_shape", line: 2 });
  });
});

describe("truncated and corrupted tails", () => {
  it("reports a half-written trailing line as truncated_tail and counts the verified prefix", async () => {
    await seed(5);
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.slice(0, raw.length - 40), "utf8");
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: "truncated_tail", line: 5 });
    expect(result.entries).toBe(4);
  });

  it("reports a complete final entry that lost its newline as truncated_tail", async () => {
    await seed(3);
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.slice(0, -1), "utf8");
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "truncated_tail", line: 3 });
  });

  it("reports a garbage trailing line that ends with a newline as malformed_line", async () => {
    await seed(3);
    const raw = await readFile(file, "utf8");
    await writeFile(file, `${raw}{not json\n`, "utf8");
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "malformed_line", line: 4 });
  });

  it("reports a blank line in the middle as malformed_line", async () => {
    await seed(3);
    const rows = await lines();
    rows.splice(1, 0, "");
    await writeLines(rows);
    const result = await verifyLedger(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ kind: "malformed_line", line: 2 });
  });

  it("refuses to append after a truncated tail rather than extending a damaged log", async () => {
    await seed(3);
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.slice(0, raw.length - 25), "utf8");
    const ledger = new Ledger(file, { now: clock });
    await expect(ledger.append({ actor: "owner", event: "late", payload: {} })).rejects.toBeInstanceOf(
      LedgerCorruptError,
    );
  });

  it("refuses to append when the last entry fails its own hash check", async () => {
    await seed(3);
    const rows = await lines();
    rows[2] = rows[2]!.replace('"entry 3"', '"entry 9"');
    await writeLines(rows);
    const ledger = new Ledger(file, { now: clock });
    await expect(ledger.append({ actor: "owner", event: "late", payload: {} })).rejects.toBeInstanceOf(
      LedgerCorruptError,
    );
  });
});

describe("head anchor", () => {
  it("cannot see deletion of the final entry without an anchor (documented limit)", async () => {
    await seed(5);
    const rows = await lines();
    rows.splice(4, 1);
    await writeLines(rows);
    expect(await verifyLedger(file)).toMatchObject({ ok: true, entries: 4 });
  });

  it("detects deletion of the final entry when the expected head is supplied", async () => {
    const ledger = await seed(5);
    const anchor = (await ledger.head()).hash;
    const rows = await lines();
    rows.splice(4, 1);
    await writeLines(rows);
    const result = await verifyLedger(file, { expectedHead: anchor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("head_mismatch");
  });

  it("passes when the expected head matches", async () => {
    const ledger = await seed(3);
    const anchor = (await ledger.head()).hash;
    expect(await verifyLedger(file, { expectedHead: anchor })).toMatchObject({ ok: true, entries: 3 });
  });
});

describe("append validation", () => {
  it("rejects a non-canonical payload and writes nothing", async () => {
    const ledger = new Ledger(file, { now: clock });
    await expect(
      ledger.append({ actor: "owner", event: "bad", payload: { v: Number.NaN } }),
    ).rejects.toThrow(/not canonical|not serializable|unsupported/i);
    expect(await verifyLedger(file)).toMatchObject({ ok: true, entries: 0 });
  });

  it("rejects an empty actor or event name", async () => {
    const ledger = new Ledger(file, { now: clock });
    await expect(ledger.append({ actor: "", event: "x", payload: {} })).rejects.toThrow(/actor/);
    await expect(ledger.append({ actor: "owner", event: "", payload: {} })).rejects.toThrow(/event/);
  });

  it("reports head as genesis when empty and as the last hash after appends", async () => {
    const ledger = new Ledger(file, { now: clock });
    expect(await ledger.head()).toEqual({ seq: 0, hash: GENESIS_HASH });
    const entry = await ledger.append({ actor: "owner", event: "x", payload: {} });
    expect(await ledger.head()).toEqual({ seq: 1, hash: entry.hash });
  });
});
