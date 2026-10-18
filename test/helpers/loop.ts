import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/audit/ledger.js";
import { RunAbortedError, type ModelDriver, type ModelStepInput, type ModelStepResult } from "../../src/runtime/loop/types.js";
import type { RunDeps } from "../../src/runtime/loop/run.js";
import { RunRepo } from "../../src/runtime/loop/repo.js";
import { ToolRegistry } from "../../src/runtime/registry.js";
import { RunScope } from "../../src/runtime/scope.js";
import { createBuiltinTools } from "../../src/runtime/tools/index.js";
import { loadPolicy, PolicySchema, type Policy } from "../../src/shield/policy.js";
import { Store } from "../../src/store/db.js";
import { StyleConfigSchema } from "../../src/style/config.js";
import { initWorkspace } from "../../src/workspace/init.js";

export interface ScriptItem {
  text?: string;
  calls?: { name: string; input: unknown }[];
  usage?: Partial<ModelStepResult["usage"]>;
  costUsd?: number | null;
  model?: { provider: string; model: string };
  failovers?: ModelStepResult["failovers"];
  /** Throw this instead of answering. */
  fail?: Error;
  /** Runs when the model is called, before it answers. */
  onStep?: (input: ModelStepInput, index: number) => void | Promise<void>;
}

export type Script = ScriptItem[] | ((input: ModelStepInput, index: number) => ScriptItem);

export interface ScriptedDriver extends ModelDriver {
  calls: ModelStepInput[];
}

/** A model that answers from a script and records everything it was shown. */
export function scriptedDriver(script: Script): ScriptedDriver {
  const calls: ModelStepInput[] = [];
  return {
    calls,
    async step(input) {
      const index = calls.length;
      calls.push(input);
      const item = typeof script === "function" ? script(input, index) : script[index];
      if (!item) throw new Error(`scripted driver has no answer for call ${index + 1}`);
      await item.onStep?.(input, index);
      if (input.signal.aborted) throw new RunAbortedError();
      if (item.fail) throw item.fail;
      return {
        text: item.text ?? "",
        toolCalls: item.calls ?? [],
        usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0, reasoningTokens: 0, ...item.usage },
        costUsd: item.costUsd === undefined ? 0 : item.costUsd,
        model: item.model ?? { provider: "test", model: "scripted" },
        latencyMs: 5,
        failovers: item.failovers ?? [],
        finishReason: item.calls && item.calls.length > 0 ? "tool-calls" : "stop",
      };
    },
  };
}

export interface RunHarness {
  dir: string;
  root: string;
  store: Store;
  repo: RunRepo;
  ledger: Ledger;
  policy: Policy;
  deps: Omit<RunDeps, "driver">;
  setNow: (date: Date) => void;
  events: () => Promise<{ seq: number; event: string; actor: string; payload: Record<string, any> }[]>;
  /** Rebuild the deps with a different policy, as when shield.policy.yaml changed while a run was paused. */
  withPolicy: (policy: Policy) => Omit<RunDeps, "driver">;
  cleanup: () => Promise<void>;
}

export const NOW = new Date("2026-10-17T12:00:00.000Z");

export async function setupRun(options: { policy?: Policy; files?: Record<string, string>; workspaceId?: string } = {}): Promise<RunHarness> {
  const root = await mkdtemp(join(tmpdir(), "medjay-loop-"));
  const workspaceId = options.workspaceId ?? "ws";
  const dir = join(root, workspaceId);
  await initWorkspace({ dir, id: workspaceId, businessType: "agency" });
  for (const [rel, text] of Object.entries(options.files ?? {})) await writeFile(join(dir, rel), text, "utf8");
  const store = Store.open(join(dir, ".medjay", "experiments.db"));
  const repo = new RunRepo(store);
  const ledger = new Ledger(join(dir, ".medjay", "audit-log.jsonl"));
  const policy = options.policy ?? (await loadPolicy(dir));
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId, dropzoneDir: join(dir, "data", "imports") });
  let now = NOW;
  let counter = 0;

  const build = (p: Policy): Omit<RunDeps, "driver"> => {
    const registry = new ToolRegistry({ policy: p, ledger, now: () => now });
    for (const tool of createBuiltinTools({ policy: p, style: { packs: ["protocol", "extended", "ar"], extraBanned: [], allow: [], claims: undefined, failOn: "error" } })) registry.register(tool);
    return {
      workspaceId,
      policy: p,
      ledger,
      store,
      registry,
      scope,
      style: StyleConfigSchema.parse({}),
      language: "en",
      now: () => now,
      newRunId: () => `run_test${++counter}`,
      leaseMs: 600_000,
    };
  };

  return {
    dir,
    root,
    store,
    repo,
    ledger,
    policy,
    deps: build(policy),
    withPolicy: build,
    setNow: (date) => {
      now = date;
    },
    events: async () => (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)),
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export const policyWith = (over: Record<string, unknown>): Policy =>
  PolicySchema.parse({
    defaults: { effect: "ask" },
    rules: [
      { action: "read.*", resource: "*", effect: "allow" },
      { action: "draft.*", resource: "*", effect: "allow" },
      { action: "propose.*", resource: "*", effect: "allow" },
    ],
    ...over,
  });

export const readCall = (path: string) => ({ name: "read_file", input: { path } });
