import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW, policyWith, readCall, scriptedDriver, setupRun, type RunHarness } from "../../../test/helpers/loop.js";
import { policyHash, startRun } from "./run.js";
import { resumeRun, ResumeError } from "./resume.js";
import { RunAbortedError } from "./types.js";

let h: RunHarness;
const harnesses: RunHarness[] = [];
const make = async (options: Parameters<typeof setupRun>[0] = {}) => {
  const made = await setupRun(options);
  harnesses.push(made);
  return made;
};
beforeEach(async () => {
  h = await make({ files: { "data/imports/crm.csv": "name,phone\nSara,+201000000000\n", "data/imports/crm2.csv": "name,phone\nOmar,+966551234567\n" } });
});
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.cleanup();
});

const input = { task: "Find wasted spend.", surface: "diagnosis" as const, slot: "reasoning" as const };
const eventsOf = async (name: string, harness = h) => (await harness.events()).filter((e) => e.event === name);
const toolRuns = async (harness = h) => (await eventsOf("tool.invoked", harness)).filter((e) => e.payload.ok);

/** A run that did step 1 (a read) and was aborted while the model was working on step 2. */
async function abortedAfterStepOne(harness = h) {
  const controller = new AbortController();
  const driver = scriptedDriver([{ text: "Reading.", calls: [readCall("context/brand-voice.md")] }, { onStep: () => controller.abort(), fail: new RunAbortedError() }]);
  const result = await startRun({ ...harness.deps, driver }, input, controller.signal);
  expect(result.status).toBe("aborted");
  return result;
}

describe("resume after an interruption", () => {
  it("continues from the next step and never re-runs or re-bills the finished ones", async () => {
    const first = await abortedAfterStepOne();
    const before = h.store.usageSummary()[0]!;
    const second = scriptedDriver([{ text: "Final answer." }]);
    const result = await resumeRun({ ...h.deps, driver: second }, first.runId);
    expect(result).toMatchObject({ status: "completed", steps: 2, finalText: "Final answer." });
    expect(second.calls).toHaveLength(1); // only step 2: step 1 was not asked again
    expect((await toolRuns()).length).toBe(1); // the read happened once, in the first run
    const after = h.store.usageSummary()[0]!;
    expect(after.calls).toBe(before.calls + 1);
    expect(h.repo.steps(first.runId).map((s) => s.phase)).toEqual(["complete", "complete"]);
  });

  it("gives the model the saved history, stamped, so it carries on where it left off", async () => {
    const first = await abortedAfterStepOne();
    const second = scriptedDriver([{ text: "done" }]);
    await resumeRun({ ...h.deps, driver: second }, first.runId);
    const seen = second.calls[0]!.messages.map((m) => m.content).join("\n");
    expect(seen).toContain("Find wasted spend.");
    expect(seen).toContain("Reading.");
    expect(seen).toContain("file:context/brand-voice.md");
    expect(seen).toContain("c1_1");
  });

  it("finishes a step whose model answer was saved but whose tools never ran, without calling the model again", async () => {
    const crashing = { ...h.deps.registry, specs: () => h.deps.registry.specs(), invoke: async () => { throw new Error("process crashed"); } } as unknown as typeof h.deps.registry;
    const driver = scriptedDriver([{ text: "Reading.", calls: [readCall("context/brand-voice.md")] }]);
    const first = await startRun({ ...h.deps, registry: crashing, driver }, input);
    expect(first.status).toBe("failed");
    expect(h.repo.steps(first.runId)[0]!.phase).toBe("model_done");
    expect(h.repo.require(first.runId).input_tokens).toBe(100); // already billed once

    const second = scriptedDriver([{ text: "All done." }]);
    const result = await resumeRun({ ...h.deps, driver: second }, first.runId);
    expect(result).toMatchObject({ status: "completed", steps: 2 });
    expect(second.calls).toHaveLength(1); // step 2 only: step 1's model answer was not re-bought
    expect(h.repo.steps(first.runId)[0]).toMatchObject({ phase: "complete" });
    expect(h.repo.steps(first.runId)[0]!.tool_results[0]).toMatchObject({ status: "done", ok: true });
    expect(h.repo.require(first.runId).input_tokens).toBe(200);
  });

  it("carries the counters over, so caps apply to the whole run", async () => {
    const limited = await make({ policy: policyWith({ runtime_limits: { max_steps: 3 } }) });
    const first = await abortedAfterStepOne(limited);
    const second = scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")] }));
    const result = await resumeRun({ ...limited.deps, driver: second }, first.runId);
    expect(result).toMatchObject({ status: "max_steps_reached", steps: 3 });
    expect(second.calls).toHaveLength(2); // steps 2 and 3, not three more
  });

  it("keeps the wrap-up nudge it already issued", async () => {
    const limited = await make({ policy: policyWith({ runtime_limits: { max_steps: 5 } }) });
    const controller = new AbortController();
    const driver = scriptedDriver((_i, n) => (n < 4 ? { calls: [readCall("context/brand-voice.md")] } : { onStep: () => controller.abort(), fail: new RunAbortedError() }));
    const first = await startRun({ ...limited.deps, driver }, input, controller.signal);
    expect(limited.repo.require(first.runId).nudged).toBe(true);
    const second = scriptedDriver([{ text: "wrapped up" }]);
    await resumeRun({ ...limited.deps, driver: second }, first.runId);
    expect(second.calls[0]!.messages.some((m) => m.content.includes("Runtime notice:"))).toBe(true);
  });

  it("does not reuse a redaction placeholder for a different value after a restart", async () => {
    const controller = new AbortController();
    const driver = scriptedDriver([{ calls: [readCall("data/imports/crm.csv")] }, { onStep: () => controller.abort(), fail: new RunAbortedError() }]);
    const first = await startRun({ ...h.deps, driver }, input, controller.signal);
    const second = scriptedDriver([{ calls: [readCall("data/imports/crm2.csv")] }, { text: "done" }]);
    await resumeRun({ ...h.deps, driver: second }, first.runId);
    const seen = second.calls[1]!.messages.map((m) => m.content).join("\n");
    expect(seen).toContain("[PHONE_1]");
    expect(seen).toContain("[PHONE_2]");
    expect(seen).not.toMatch(/201000000000|966551234567/);
  });
});

describe("resume writes to the ledger", () => {
  it("records run.resumed with who, from which state and where it picked up", async () => {
    const first = await abortedAfterStepOne();
    await resumeRun({ ...h.deps, actor: "cli:omar", driver: scriptedDriver([{ text: "done" }]) }, first.runId);
    const [event] = await eventsOf("run.resumed");
    expect(event!.actor).toBe("cli:omar");
    expect(event!.payload).toMatchObject({ run_id: first.runId, from_status: "aborted", steps_done: 1 });
  });

  it("records a policy change when shield.policy.yaml differs from the one the run started under", async () => {
    const first = await abortedAfterStepOne();
    const changed = policyWith({ forbidden_actions: ["delete_campaign"] });
    await resumeRun({ ...h.withPolicy(changed), driver: scriptedDriver([{ text: "done" }]) }, first.runId);
    const [event] = await eventsOf("run.policy_changed");
    expect(event!.payload).toMatchObject({ run_id: first.runId, old: policyHash(h.policy), new: policyHash(changed) });
    expect(h.repo.require(first.runId).policy_hash).toBe(policyHash(changed));
  });

  it("writes no policy_changed entry when the policy is the same", async () => {
    const first = await abortedAfterStepOne();
    await resumeRun({ ...h.deps, driver: scriptedDriver([{ text: "done" }]) }, first.runId);
    expect(await eventsOf("run.policy_changed")).toEqual([]);
  });

  it("applies the CURRENT limits: a cap tightened while paused stops the run at once, and a raised one is audited again", async () => {
    const first = await abortedAfterStepOne();
    const tight = h.withPolicy(policyWith({ runtime_limits: { max_steps: 1 } }));
    const stopped = scriptedDriver([{ text: "never asked" }]);
    expect(await resumeRun({ ...tight, driver: stopped }, first.runId)).toMatchObject({ status: "max_steps_reached", steps: 1 });
    expect(stopped.calls).toHaveLength(0);

    const raisedHarness = await make({ policy: policyWith({ runtime_limits: { max_steps: 20 } }) });
    const second = await abortedAfterStepOne(raisedHarness);
    await resumeRun({ ...raisedHarness.deps, driver: scriptedDriver([{ text: "done" }]) }, second.runId);
    expect((await eventsOf("run_limits_elevated", raisedHarness)).length).toBe(2); // at start, and again at resume
  });
});

describe("resume of a run that stopped for a human", () => {
  const askingPolicy = () => policyWith({ rules: [{ action: "propose.*", resource: "*", effect: "allow" }] });
  const pausedRun = async (harness: RunHarness) => {
    const driver = scriptedDriver([{ text: "Reading.", calls: [readCall("context/brand-voice.md")] }]);
    const result = await startRun({ ...harness.deps, driver }, input);
    expect(result).toMatchObject({ status: "needs_human", pending: { callId: "c1_1", tool: "read_file" } });
    return result;
  };

  it("re-checks the policy: once it allows the call, resume runs it and carries on", async () => {
    const asking = await make({ policy: askingPolicy() });
    const paused = await pausedRun(asking);
    const allowed = asking.withPolicy(policyWith({}));
    const driver = scriptedDriver([{ text: "Thanks, finished." }]);
    const result = await resumeRun({ ...allowed, driver }, paused.runId);
    expect(result).toMatchObject({ status: "completed", steps: 2 });
    expect(asking.repo.steps(paused.runId)[0]!.tool_results[0]).toMatchObject({ status: "done", ok: true });
    expect(driver.calls[0]!.messages.map((m) => m.content).join("\n")).toContain("file:context/brand-voice.md");
    expect((await eventsOf("run.policy_changed", asking)).length).toBe(1);
    expect(asking.repo.require(paused.runId).pending).toBeNull();
  });

  it("stays paused, asks the model nothing and says why, when the policy still asks and nobody approved", async () => {
    const asking = await make({ policy: askingPolicy() });
    const paused = await pausedRun(asking);
    const driver = scriptedDriver([{ text: "must not be asked" }]);
    const result = await resumeRun({ ...asking.deps, driver }, paused.runId);
    expect(result).toMatchObject({ status: "needs_human", pending: { callId: "c1_1", tool: "read_file" } });
    expect(driver.calls).toHaveLength(0);
    expect((await eventsOf("run.resumed", asking)).length).toBe(1);
  });

  it("runs the one pending call when a human approves it by id, logged as approved_once, and widens nothing", async () => {
    const asking = await make({ policy: askingPolicy() });
    const paused = await pausedRun(asking);
    const driver = scriptedDriver([{ calls: [readCall("context/claims.md")] }, { text: "never reached" }]);
    const result = await resumeRun({ ...asking.deps, actor: "cli:omar", driver }, paused.runId, { approveTool: "c1_1" });
    expect(asking.repo.steps(paused.runId)[0]!.tool_results[0]).toMatchObject({ status: "done", ok: true });
    const approvals = await eventsOf("tool.approved_once", asking);
    expect(approvals[0]!.payload).toMatchObject({ run_id: paused.runId, call_id: "c1_1", tool: "read_file" });
    expect(approvals[0]!.actor).toBe("cli:omar");
    // the next read is not covered by that approval, so the run pauses again, on the new call
    expect(result).toMatchObject({ status: "needs_human", steps: 2, pending: { callId: "c2_1", tool: "read_file" } });
    expect(driver.calls).toHaveLength(1);
  });

  it("refuses an approval for a call that is not the pending one", async () => {
    const asking = await make({ policy: askingPolicy() });
    const paused = await pausedRun(asking);
    await expect(resumeRun({ ...asking.deps, driver: scriptedDriver([]) }, paused.runId, { approveTool: "c9_9" })).rejects.toThrow(/pending/);
    expect(await eventsOf("tool.approved_once", asking)).toEqual([]);
  });

  it("never lets an approval override a deny that was added while paused", async () => {
    const asking = await make({ policy: askingPolicy() });
    const paused = await pausedRun(asking);
    const denying = asking.withPolicy(policyWith({ rules: [{ action: "read.*", resource: "*", effect: "deny" }] }));
    const driver = scriptedDriver([{ text: "I was refused access." }]);
    const result = await resumeRun({ ...denying, driver }, paused.runId, { approveTool: "c1_1" });
    expect(result.status).toBe("completed");
    expect(asking.repo.steps(paused.runId)[0]!.tool_results[0]).toMatchObject({ status: "done", ok: false, error: { kind: "denied" } });
    expect(driver.calls[0]!.messages.map((m) => m.content).join("\n")).toMatch(/denied/);
  });
});

describe("what cannot be resumed", () => {
  it("refuses an unknown run, and runs that already finished", async () => {
    await expect(resumeRun({ ...h.deps, driver: scriptedDriver([]) }, "run_nope")).rejects.toBeInstanceOf(ResumeError);
    const done = await startRun({ ...h.deps, driver: scriptedDriver([{ text: "done" }]) }, input);
    await expect(resumeRun({ ...h.deps, driver: scriptedDriver([]) }, done.runId)).rejects.toThrow(/finished|completed/);
    const limited = await make({ policy: policyWith({ runtime_limits: { max_steps: 1 } }) });
    const capped = await startRun({ ...limited.deps, driver: scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")] })) }, input);
    await expect(resumeRun({ ...limited.deps, driver: scriptedDriver([]) }, capped.runId)).rejects.toThrow(/finished|max_steps/);
  });

  it("refuses a run that still holds a live lease, and allows it once the lease has expired", async () => {
    const first = await abortedAfterStepOne();
    h.repo.setStatus(first.runId, "running", { now: NOW });
    h.repo.setLease(first.runId, new Date(NOW.getTime() + 600_000));
    await expect(resumeRun({ ...h.deps, driver: scriptedDriver([{ text: "done" }]) }, first.runId)).rejects.toThrow(/still running|lease/);
    h.setNow(new Date(NOW.getTime() + 700_000));
    expect((await resumeRun({ ...h.deps, driver: scriptedDriver([{ text: "done" }]) }, first.runId)).status).toBe("completed");
  });

  it("allows a failed run to be retried from where it stopped", async () => {
    const driver = scriptedDriver([{ calls: [readCall("context/brand-voice.md")] }, { fail: Object.assign(new Error("overloaded"), { statusCode: 503 }) }]);
    const failed = await startRun({ ...h.deps, driver }, input);
    expect(failed).toMatchObject({ status: "failed", steps: 1 });
    const retry = scriptedDriver([{ text: "recovered" }]);
    expect(await resumeRun({ ...h.deps, driver: retry }, failed.runId)).toMatchObject({ status: "completed", steps: 2, finalText: "recovered" });
    expect(retry.calls).toHaveLength(1);
  });
});
