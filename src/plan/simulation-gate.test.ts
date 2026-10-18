import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryKeystore } from "../../test/helpers/keystore.js";
import { Ledger } from "../audit/ledger.js";
import { loadPolicy, PolicySchema } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { initWorkspace } from "../workspace/init.js";
import { approvePlan, rejectPlan } from "./approve.js";
import { PlanStateError, PolicyViolationError } from "./errors.js";
import { proposePlan, type PlanDeps } from "./propose.js";
import { PlanRepo } from "./repo.js";
import { reviseWithSimulation } from "./revise.js";
import { ensureSigningKey } from "./signing.js";
import { strikePlan } from "./strike.js";
import type { SimulationRef } from "./types.js";

const NOW = new Date("2026-10-17T10:00:00.000Z");
let root: string;
let dir: string;
let store: Store;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-simgate-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  store?.close();
  await rm(root, { recursive: true, force: true });
});

async function setup(limits: Record<string, unknown> = {}): Promise<PlanDeps> {
  store = Store.open(join(dir, ".medjay", "experiments.db"));
  const loaded = await loadPolicy(dir);
  const policy = PolicySchema.parse({ ...loaded, limits: { ...loaded.limits, ...limits } });
  let n = 0;
  return {
    dir,
    repo: new PlanRepo(store),
    ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl"), { now: () => NOW }),
    policy,
    signing: await ensureSigningKey({ dir, workspaceId: "ws", keystore: memoryKeystore(), env: {} }),
    now: () => NOW,
    random: { code: () => "123456", nonce: () => `nonce-${(n += 1)}` },
  };
}

const scaleUp = { type: "budget_change", target: { platform: "meta", kind: "adset", id: "999", name: "KSA_Bookers_LAL" }, from: 100, to: 115, currency: "USD" } as const;
const scaleDown = { type: "budget_change", target: { platform: "meta", kind: "adset", id: "998", name: "Broad" }, from: 100, to: 60, currency: "USD" } as const;
const input = (proposals: unknown[], simulation?: SimulationRef) => ({ workspace: "ws", origin: { job: "diagnose", finding_ids: [] }, proposals: proposals as never, ...(simulation ? { simulation } : {}) });
const sim = (over: Partial<SimulationRef> = {}): SimulationRef => ({ id: "sim_abc123abc123", seed: 42, p10: -120, p50: 400, p90: 900, p_positive: 0.82, ...over });
const rules = (plan: { policy_result: { checks: { rule: string; ok: boolean | null }[] } }) => plan.policy_result.checks.filter((c) => c.rule.includes("simulation"));
const approve = (deps: PlanDeps, n: number) => approvePlan(deps, n, { approver: "cli:omar", channel: "cli" });

describe("the simulation gate on budget increases", () => {
  it("lets a scale plan be proposed without one, marks the check as not evaluated, and refuses to approve it", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, input([scaleUp]));
    expect(rules(plan)).toEqual([expect.objectContaining({ rule: "scale_requires_simulation", ok: null })]);
    await expect(approve(deps, row.number)).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(approve(deps, row.number)).rejects.toThrow(/cites no simulation/);
  });

  it("does not ask for a simulation when the plan only lowers budgets or changes status", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, input([scaleDown]));
    expect(rules(plan)).toEqual([]);
    expect((await approve(deps, row.number)).status).toBe("approved");
  });

  it("approves and strikes a scale plan that cites a passing simulation", async () => {
    const deps = await setup();
    const { row, plan } = await proposePlan(deps, input([scaleUp], sim()));
    expect(rules(plan)).toEqual([expect.objectContaining({ rule: "simulation_passes", ok: true })]);
    expect((await approve(deps, row.number)).status).toBe("approved");
    const struck = await strikePlan(deps, row.number, { actor: "cli:omar" });
    expect(struck.state).toBe("exported");
  });

  it("refuses at proposal time a plan whose simulation fails, by P50 or by probability", async () => {
    const deps = await setup();
    await expect(proposePlan(deps, input([scaleUp], sim({ p50: -5 })))).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(proposePlan(deps, input([scaleUp], sim({ p_positive: 0.59 })))).rejects.toBeInstanceOf(PolicyViolationError);
    expect(deps.repo.list()).toHaveLength(0);
  });

  it("uses the CURRENT threshold at approval and at strike, so tightening the policy blocks an old plan", async () => {
    const deps = await setup();
    const { row } = await proposePlan(deps, input([scaleUp], sim({ p_positive: 0.7 })));
    const stricter = PolicySchema.parse({ ...deps.policy, limits: { ...deps.policy.limits, min_simulation_p_positive: 0.9 } });
    await expect(approve({ ...deps, policy: stricter }, row.number)).rejects.toBeInstanceOf(PolicyViolationError);
    await approve(deps, row.number);
    await expect(strikePlan({ ...deps, policy: stricter }, row.number, { actor: "cli:omar" })).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it("can be switched off in policy, and the threshold can be lowered", async () => {
    const off = await setup({ require_simulation_for_scale: false });
    const { plan } = await proposePlan(off, input([scaleUp]));
    expect(rules(plan)).toEqual([]);
    store.close();
    const lenient = await setup({ min_simulation_p_positive: 0.5 });
    const { plan: p2 } = await proposePlan(lenient, input([{ ...scaleUp, target: { ...scaleUp.target, id: "1000" } }], sim({ p_positive: 0.55 })));
    expect(rules(p2)[0]).toMatchObject({ ok: true });
  });

  it("the simulation is part of the plan hash, so swapping it changes the hash", async () => {
    const deps = await setup();
    const a = await proposePlan(deps, input([scaleUp], sim()));
    const b = await proposePlan(deps, input([scaleUp], sim({ id: "sim_def456def456", p50: 500 })));
    expect(a.plan.plan_hash).not.toBe(b.plan.plan_hash);
  });
});

describe("reviseWithSimulation", () => {
  it("compiles a new plan with the simulation attached and rejects the old one as superseded", async () => {
    const deps = await setup();
    const first = await proposePlan(deps, input([scaleUp, scaleDown]));
    const revised = await reviseWithSimulation(deps, first.row.number, sim(), { actor: "cli:omar" });
    expect(revised.row.number).toBe(2);
    expect(revised.plan.simulation).toMatchObject({ id: "sim_abc123abc123" });
    expect(revised.plan.actions.map((a) => a.type)).toEqual(["budget_change", "budget_change"]);
    expect(revised.plan.plan_hash).not.toBe(first.plan.plan_hash);
    expect(deps.repo.require(1).state).toBe("rejected");
    expect((await approve(deps, 2)).status).toBe("approved");
    const events = (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const revision = events.find((e) => e.event === "plan.revised");
    expect(revision.payload).toMatchObject({ from: 1, to: 2, simulation: "sim_abc123abc123" });
    expect(events.find((e) => e.event === "plan.rejected").payload.reason).toMatch(/superseded by #2/);
  });

  it("keeps all action kinds intact through the round trip", async () => {
    const deps = await setup({ require_simulation_for_scale: false });
    const mixed = [
      scaleDown,
      { type: "status_change", target: { platform: "google_ads", kind: "campaign", id: "5" }, from: "ENABLED", to: "PAUSED" },
      { type: "add_negative_keywords", target: { platform: "google_ads", kind: "campaign", id: "5" }, terms: [{ text: "free", match: "BROAD" }] },
      { type: "register_experiment", experiment_id: "EXP-1", hypothesis: "h", metric: "m" },
    ];
    const first = await proposePlan(deps, input(mixed));
    const revised = await reviseWithSimulation(deps, first.row.number, sim(), { actor: "cli:omar" });
    const strip = (p: { actions: Record<string, unknown>[] }) => p.actions.map(({ id: _id, ...rest }) => rest);
    expect(strip(revised.plan)).toEqual(strip(first.plan));
  });

  it("only revises a plan nobody has acted on, and leaves the old plan alone if the new one is refused", async () => {
    const deps = await setup();
    const first = await proposePlan(deps, input([scaleUp]));
    await expect(reviseWithSimulation(deps, first.row.number, sim({ p50: -1 }), { actor: "cli:omar" })).rejects.toBeInstanceOf(PolicyViolationError);
    expect(deps.repo.require(1).state).toBe("proposed");
    await rejectPlan(deps, 1, { actor: "cli:omar" });
    await expect(reviseWithSimulation(deps, 1, sim(), { actor: "cli:omar" })).rejects.toBeInstanceOf(PlanStateError);
  });
});
