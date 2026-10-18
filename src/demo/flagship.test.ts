import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";
import { FIXTURE } from "../../test/helpers/ingest.js";
import { runFlagship } from "./flagship.js";

vi.setConfig({ testTimeout: 90_000 });

const NOW = new Date("2026-10-17T07:00:00.000Z");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-flagship-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (name: string, autoApprove: boolean, lines: string[] = []) => runFlagship({ fixtureDir: FIXTURE, dir: join(root, name), autoApprove, now: () => NOW, say: (l) => lines.push(l) });

describe("the flagship closed loop on etlaala-ksa", () => {
  it("scouts, diagnoses, matches a tactic, plans with a simulation check, and stops at the approval gate", async () => {
    const lines: string[] = [];
    const r = await run("a", false, lines);
    expect(r.stoppedAt).toBe("approval");
    expect(r.blendedMer).toBe(7.46);
    expect(r.platformRoas.google).toBe(19.8);
    expect(r.top[0]).toBe("bleeding_adset:meta:umrah-all-broad-reels");
    expect(r.top.some((id) => id.startsWith("over_attribution"))).toBe(true);
    expect(r.matchedTactic).toBe("TACTIC-ETL-001");
    expect(r.skippedTactics).toEqual(["TACTIC-ETL-002"]);
    expect(r.plans[0]).toMatchObject({ number: 1, state: "proposed" });
    const out = lines.join("\n");
    expect(out).toMatch(/Google reports ROAS 19.8: the platform claims 2.7x what the business earned/);
    expect(out).toMatch(/Warning: 8 data cell\(s\) read like instructions to an AI/);
    expect(out).toMatch(/TACTIC-ETL-002 matches a finding but was invalidated/);
    expect(out).toMatch(/now hypothesized, bound to EXP-ETL-001/);
    expect(out).toMatch(/Stopped before approval/);
    expect(out).not.toMatch(/ignore your previous instructions/i);
  });

  it("the scale-up plan carries a stored seeded simulation, fails the gate, and cannot be approved", async () => {
    const r = await run("b", false);
    expect(r.scalePlan).toMatchObject({ number: 2, passes: false, approvalRefused: true });
    expect(r.scalePlan!.simulation).toMatch(/^sim_[0-9a-f]{12}$/);
    expect(r.plans[1]).toMatchObject({ number: 2, state: "proposed" });
  });

  it("with --auto-approve it strikes into a valid export and leaves a verifiable ledger", async () => {
    const r = await run("c", true);
    expect(r.stoppedAt).toBe("done");
    expect(r.plans[0]).toMatchObject({ state: "exported" });
    expect(r.exportValid).toBe(true);
    expect(r.ledger.ok).toBe(true);
    const path = join(root, "c", ".medjay", "audit-log.jsonl");
    expect(await verifyLedger(path)).toMatchObject({ ok: true, head: r.ledger.head });
    const events = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown> });
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["ingest.completed", "tactic.hypothesized", "plan.proposed", "simulation.completed", "plan.approved", "plan.exported"]));
    expect(events.find((e) => e.event === "plan.approved")!.payload.channel).toBe("demo");
    expect(await readFile(join(root, "c", "tactics", "TACTIC-ETL-001.md"), "utf8")).toMatch(/state: hypothesized/);
  });

  it("is deterministic: three runs on the same data and clock compile the same plan hashes and simulation", async () => {
    const results = [await run("d1", false), await run("d2", false), await run("d3", false)];
    expect(new Set(results.map((r) => r.plans[0]!.hash)).size).toBe(1);
    expect(new Set(results.map((r) => r.plans[1]!.hash)).size).toBe(1);
    expect(new Set(results.map((r) => r.scalePlan!.simulation)).size).toBe(1);
  });
});
