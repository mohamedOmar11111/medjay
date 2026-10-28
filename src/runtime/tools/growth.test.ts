import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { loadPolicy } from "../../shield/policy.js";
import { initWorkspace } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { growthTools, type GrowthPort } from "./growth.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-growth-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakePort(): GrowthPort & { id: string; calls: string[] } {
  const port = {
    id: "data-v1",
    calls: [] as string[],
    async dataId() {
      return port.id;
    },
    async scout(days: number) {
      port.calls.push(`scout:${days}`);
      return { snapshot: { status: "no_data" }, summary: { totals: { spend: 1000 } } };
    },
    async diagnose(days: number) {
      port.calls.push(`diagnose:${days}`);
      return { status: "no_data", findings: [] };
    },
    async context() {
      port.calls.push("context");
      return { unit_economics: "aov: 5000", claims: "", offers: "", tactics: [] };
    },
    async readiness() {
      port.calls.push("readiness");
      return { context: { files: [], ready_count: 0 }, data: { files_found: 0 }, connections: [] };
    },
    async simulate(input: { spend?: number; scale_pct?: number }) {
      port.calls.push(`simulate:${input.scale_pct ?? "-"}`);
      return { status: "ok", p_positive: 0.7 };
    },
  };
  return port;
}

async function setup(port: GrowthPort) {
  const policy = await loadPolicy(dir);
  const registry = new ToolRegistry({ policy, ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl")) });
  for (const tool of growthTools(port)) registry.register(tool);
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports") });
  const run = (runId: string) => ({ runId, step: 1, scope });
  return { registry, run };
}

describe("growth tools", () => {
  it("are read tools, and none can change anything", async () => {
    const { registry } = await setup(fakePort());
    const specs = registry.specs();
    expect(specs.map((s) => s.name)).toEqual(["growth_context", "growth_diagnose", "growth_scout", "growth_simulate", "workspace_readiness"]);
    expect(new Set(specs.map((s) => s.class))).toEqual(new Set(["read"]));
  });

  it("growth_scout returns the picture with a snapshot id, and diagnose then works", async () => {
    const port = fakePort();
    const { registry, run } = await setup(port);
    const scout = await registry.invoke({ name: "growth_scout", input: { days: 14 } }, run("run_a"));
    expect(scout).toMatchObject({ ok: true, trust: "untrusted" });
    expect((scout as { output: { snapshot_id: string } }).output.snapshot_id).toBe("data-v1");
    expect(port.calls).toEqual(["scout:14"]);
    const diag = await registry.invoke({ name: "growth_diagnose", input: {} }, run("run_a"));
    expect(diag).toMatchObject({ ok: true });
    expect(port.calls).toEqual(["scout:14", "diagnose:7"]);
  });

  it("workspace_readiness needs no scout, works on an empty workspace and is trusted (it reports the owner's own files)", async () => {
    const port = fakePort();
    const { registry, run } = await setup(port);
    const r = await registry.invoke({ name: "workspace_readiness", input: {} }, run("run_r"));
    expect(r).toMatchObject({ ok: true, trust: "trusted", output: { source: "workspace_readiness", context: { ready_count: 0 } } });
    expect(port.calls).toEqual(["readiness"]);
  });

  it("a scout that finds no data yet is still a scout: it is not an error and does not block diagnose", async () => {
    const port = fakePort();
    port.scout = async () => ({ status: "no_data_yet", files_found: 0 });
    port.diagnose = async () => ({ status: "no_data_yet", files_found: 0 });
    const { registry, run } = await setup(port);
    expect(await registry.invoke({ name: "growth_scout", input: {} }, run("run_n"))).toMatchObject({ ok: true, output: { status: "no_data_yet" } });
    expect(await registry.invoke({ name: "growth_diagnose", input: {} }, run("run_n"))).toMatchObject({ ok: true, output: { status: "no_data_yet" } });
  });

  it("diagnose and simulate refuse to run before a scout in the same run", async () => {
    const port = fakePort();
    const { registry, run } = await setup(port);
    for (const [name, input] of [["growth_diagnose", {}], ["growth_simulate", { scale_pct: 15 }]] as const) {
      const r = await registry.invoke({ name, input }, run("run_b"));
      expect(r).toMatchObject({ ok: false, error: { kind: "failed" } });
      expect((r as { error: { message: string } }).error.message).toMatch(/call growth_scout first/);
    }
    expect(port.calls).toEqual([]);
  });

  it("a simulation with a given spend needs no scout: it is asked to model the target only, never to read data", async () => {
    const port = fakePort();
    const seen: unknown[] = [];
    const inner = port.simulate.bind(port);
    port.simulate = async (input: Parameters<typeof inner>[0]) => {
      seen.push(input);
      return inner(input);
    };
    const { registry, run } = await setup(port);
    expect(await registry.invoke({ name: "growth_simulate", input: { spend: 40_000, scale_pct: 15 } }, run("run_t"))).toMatchObject({ ok: true });
    expect(seen).toEqual([{ spend: 40_000, scale_pct: 15, target_model: true }]);
  });

  it("after a scout, a simulation reads the data as before (no target-model flag)", async () => {
    const port = fakePort();
    const seen: unknown[] = [];
    const inner = port.simulate.bind(port);
    port.simulate = async (input: Parameters<typeof inner>[0]) => {
      seen.push(input);
      return inner(input);
    };
    const { registry, run } = await setup(port);
    await registry.invoke({ name: "growth_scout", input: {} }, run("run_u"));
    await registry.invoke({ name: "growth_simulate", input: { spend: 40_000 } }, run("run_u"));
    expect(seen).toEqual([{ spend: 40_000 }]);
  });

  it("a simulation without a spend and without a scout is still refused", async () => {
    const { registry, run } = await setup(fakePort());
    const r = await registry.invoke({ name: "growth_simulate", input: { scale_pct: 20 } }, run("run_v"));
    expect((r as { error: { message: string } }).error.message).toMatch(/call growth_scout first/);
  });

  it("a scout in one run does not unlock another run", async () => {
    const { registry, run } = await setup(fakePort());
    await registry.invoke({ name: "growth_scout", input: {} }, run("run_c"));
    expect(await registry.invoke({ name: "growth_diagnose", input: {} }, run("run_d"))).toMatchObject({ ok: false });
  });

  it("when the data changes after the scout, the old picture no longer counts", async () => {
    const port = fakePort();
    const { registry, run } = await setup(port);
    await registry.invoke({ name: "growth_scout", input: {} }, run("run_e"));
    port.id = "data-v2";
    const r = await registry.invoke({ name: "growth_simulate", input: { scale_pct: 20 } }, run("run_e"));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: { message: string } }).error.message).toMatch(/data changed/);
  });

  it("growth_context needs no scout and is trusted (owner-written files)", async () => {
    const { registry, run } = await setup(fakePort());
    expect(await registry.invoke({ name: "growth_context", input: {} }, run("run_f"))).toMatchObject({ ok: true, trust: "trusted" });
  });

  it("rejects unknown fields and out-of-range numbers", async () => {
    const { registry, run } = await setup(fakePort());
    expect(await registry.invoke({ name: "growth_scout", input: { days: 0 } }, run("run_g"))).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    expect(await registry.invoke({ name: "growth_scout", input: { path: "../x" } }, run("run_g"))).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
  });
});
