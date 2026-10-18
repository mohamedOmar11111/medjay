import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../audit/canonical.js";
import { verifyLedger } from "../../audit/ledger.js";
import { join } from "node:path";
import { NOW, policyWith, readCall, scriptedDriver, setupRun, type RunHarness } from "../../../test/helpers/loop.js";
import { NUDGE_MARKER, policyHash, startRun } from "./run.js";
import { RunAbortedError } from "./types.js";

let h: RunHarness;
beforeEach(async () => {
  h = await setupRun({
    files: {
      "data/imports/meta.csv": 'campaign,spend\n"Maldives_Broad",640\n"KSA_Bookers",210\n',
    },
  });
});
afterEach(async () => {
  await h.cleanup();
});

const input = { task: "Find wasted spend.", surface: "diagnosis" as const, slot: "reasoning" as const };
const run = (script: Parameters<typeof scriptedDriver>[0], over: Partial<typeof input> = {}, signal?: AbortSignal, deps = h.deps) => {
  const driver = scriptedDriver(script);
  return startRun({ ...deps, driver }, { ...input, ...over }, signal).then((result) => ({ result, driver }));
};
const eventNames = async () => (await h.events()).map((e) => e.event);

describe("a normal run", () => {
  it("calls tools, feeds their results back, and completes with the final answer", async () => {
    const { result, driver } = await run([{ text: "Reading the CSV.", calls: [readCall("data/imports/meta.csv")] }, { text: "Maldives_Broad spent the most." }]);
    expect(result).toMatchObject({ status: "completed", steps: 2, finalText: "Maldives_Broad spent the most.", runId: "run_test1" });
    expect(driver.calls).toHaveLength(2);
  });

  it("shows the model a system prompt, the task, the tools and then stamped tool results", async () => {
    const { driver } = await run([{ calls: [readCall("context/brand-voice.md")] }, { text: "done" }]);
    const first = driver.calls[0]!;
    expect(first.system).toMatch(/cannot change any ad account/i);
    expect(first.system).toMatch(/Drop articles/); // diagnosis narration is terse
    expect(first.messages[0]).toMatchObject({ role: "user" });
    expect(first.messages.map((m) => m.content).join("\n")).toContain("Find wasted spend.");
    expect(first.tools.map((t) => t.name).sort()).toEqual(["lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    const second = driver.calls[1]!.messages.map((m) => m.content).join("\n");
    expect(second).toContain("file:context/brand-voice.md");
    expect(second).toMatch(/as_of 20\d\d-/);
    expect(second).toContain("c1_1");
    expect(second).toContain("read_file");
  });

  it("spotlights dropzone content in what the model sees", async () => {
    const { driver } = await run([{ calls: [readCall("data/imports/meta.csv")] }, { text: "ok" }]);
    const second = driver.calls[1]!.messages.map((m) => m.content).join("\n");
    expect(second).toMatch(/<untrusted_data id="[0-9a-f]{12}" source="file:data\/imports\/meta\.csv"/);
    expect(second).toContain("Maldives_Broad");
  });

  it("alternates user and assistant turns so every provider accepts the history", async () => {
    const { driver } = await run([{ text: "step one", calls: [readCall("context/brand-voice.md")] }, { text: "step two", calls: [readCall("context/claims.md")] }, { text: "done" }]);
    for (const call of driver.calls) {
      const roles = call.messages.map((m) => m.role);
      expect(roles[0]).toBe("user");
      for (let i = 1; i < roles.length; i += 1) expect(roles[i], roles.join(",")).not.toBe(roles[i - 1]);
    }
  });

  it("records the header, both phases of each step, the policy hash and usage telemetry with the surface", async () => {
    const { result } = await run([{ calls: [readCall("context/brand-voice.md")], usage: { inputTokens: 500, outputTokens: 50 } }, { text: "done", usage: { inputTokens: 700, outputTokens: 30 } }]);
    const header = h.repo.require(result.runId);
    expect(header).toMatchObject({ status: "completed", steps_done: 2, input_tokens: 1200, output_tokens: 80, surface: "diagnosis", slot: "reasoning", final_text: "done", lease_until: null });
    expect(header.policy_hash).toBe(policyHash(h.policy));
    expect(h.repo.steps(result.runId).map((s) => s.phase)).toEqual(["complete", "complete"]);
    expect(h.repo.steps(result.runId)[0]!.tool_results[0]).toMatchObject({ call_id: "c1_1", status: "done", ok: true, trust: "trusted" });
    const usage = h.store.usageSummary(undefined, { bySurface: true });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ surface: "diagnosis", slot: "reasoning", calls: 2, inputTokens: 1200, outputTokens: 80 });
  });

  it("holds a lease while running and releases it when done", async () => {
    let leaseDuring: string | null = null;
    const { result } = await run([{ onStep: () => { leaseDuring = h.repo.require("run_test1").lease_until; }, text: "done" }]);
    expect(leaseDuring).toBe(new Date(NOW.getTime() + 600_000).toISOString());
    expect(h.repo.require(result.runId).lease_until).toBeNull();
  });

  it("writes run.started, the tool calls and run.finished to a ledger whose chain still verifies", async () => {
    await run([{ calls: [readCall("context/brand-voice.md")] }, { text: "done" }]);
    const names = await eventNames();
    expect(names.indexOf("run.started")).toBeGreaterThan(-1);
    expect(names.indexOf("run.started")).toBeLessThan(names.indexOf("tool.invoked"));
    expect(names.indexOf("tool.invoked")).toBeLessThan(names.indexOf("run.finished"));
    const finished = (await h.events()).find((e) => e.event === "run.finished")!;
    expect(finished.payload).toMatchObject({ run_id: "run_test1", status: "completed", steps: 2 });
    expect(await verifyLedger(join(h.dir, ".medjay", "audit-log.jsonl"))).toMatchObject({ ok: true });
  });

  it("keeps personal data out of the prompt and out of what is saved", async () => {
    const { result, driver } = await run([{ calls: [readCall("data/imports/crm.csv")] }, { text: "done" }], { task: "Why did lead +201000000000 go quiet?" });
    expect(driver.calls[0]!.messages.map((m) => m.content).join("\n")).not.toContain("201000000000");
    expect(h.repo.require(result.runId).task).toContain("[PHONE_1]");
    expect(h.repo.require(result.runId).task).not.toContain("201000000000");
  });

  it("redacts personal data in tool results before they are saved or shown", async () => {
    await h.cleanup();
    h = await setupRun({ files: { "data/imports/crm.csv": "name,phone,mail\nSara,01000000000,sara@example.com\n" } });
    const { result, driver } = await run([{ calls: [readCall("data/imports/crm.csv")] }, { text: "done" }]);
    const saved = JSON.stringify(h.repo.steps(result.runId));
    expect(saved).not.toMatch(/01000000000|sara@example\.com/);
    expect(saved).toContain("[PHONE_");
    expect(driver.calls[1]!.messages.map((m) => m.content).join("\n")).not.toMatch(/01000000000|sara@example\.com/);
  });

  it("collects the proposals the agent made so a human can compile them into a plan", async () => {
    const proposal = { type: "budget_change", target: { platform: "meta", kind: "adset", id: "1", name: "Maldives_Broad" }, from: 95, to: 35, currency: "USD" };
    const { result } = await run([{ calls: [{ name: "propose_plan_actions", input: { proposals: [proposal] } }] }, { text: "Proposed a cut." }]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ type: "budget_change", from: 95, to: 35 });
  });

  it("tells the model about a failed or unknown tool call and carries on", async () => {
    const { result, driver } = await run([{ calls: [{ name: "delete_campaign", input: { id: "1" } }, readCall("../outside.txt")] }, { text: "I could not do that." }]);
    expect(result.status).toBe("completed");
    const second = driver.calls[1]!.messages.map((m) => m.content).join("\n");
    expect(second).toMatch(/unknown_tool/);
    expect(second).toMatch(/scope/);
  });
});

describe("stop conditions", () => {
  it("stops with needs_human the moment a tool needs approval, skips the rest of that step, and records what is pending", async () => {
    const asking = await setupRun({ policy: policyWith({ rules: [{ action: "propose.*", resource: "*", effect: "allow" }] }) });
    const driver = scriptedDriver([{ calls: [readCall("context/brand-voice.md"), { name: "list_files", input: {} }] }, { text: "never reached" }]);
    const result = await startRun({ ...asking.deps, driver }, input);
    expect(result).toMatchObject({ status: "needs_human", steps: 1, pending: { callId: "c1_1", tool: "read_file" } });
    expect(driver.calls).toHaveLength(1);
    const step = asking.repo.steps(result.runId)[0]!;
    expect(step.tool_results.map((r) => r.status)).toEqual(["pending_approval", "skipped"]);
    expect(asking.repo.require(result.runId)).toMatchObject({ status: "needs_human", stop_reason: "approval_required", pending: { callId: "c1_1", tool: "read_file", step: 1 } });
    await asking.cleanup();
  });

  it("stops at max_steps without calling the model again and keeps the partial findings", async () => {
    const limited = await setupRun({ policy: policyWith({ runtime_limits: { max_steps: 3 } }) });
    const driver = scriptedDriver(() => ({ text: "still working", calls: [readCall("context/brand-voice.md")] }));
    const result = await startRun({ ...limited.deps, driver }, input);
    expect(result).toMatchObject({ status: "max_steps_reached", steps: 3, finalText: "still working" });
    expect(driver.calls).toHaveLength(3);
    expect(limited.repo.steps(result.runId)).toHaveLength(3);
    expect(limited.repo.require(result.runId).stop_reason).toBe("max_steps");
    await limited.cleanup();
  });

  it("stops at max_tokens as soon as the running total crosses the cap", async () => {
    const limited = await setupRun({ policy: policyWith({ runtime_limits: { max_tokens: 1000 } }) });
    const driver = scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")], usage: { inputTokens: 400, outputTokens: 100 } }));
    const result = await startRun({ ...limited.deps, driver }, input);
    expect(result).toMatchObject({ status: "max_tokens_reached", steps: 2 });
    expect(driver.calls).toHaveLength(2);
    await limited.cleanup();
  });

  it("stops at max_cost_usd, and an unknown price counts as zero but is flagged", async () => {
    const limited = await setupRun({ policy: policyWith({ runtime_limits: { max_cost_usd: 0.01 } }) });
    const driver = scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")], costUsd: 0.006 }));
    const result = await startRun({ ...limited.deps, driver }, input);
    expect(result).toMatchObject({ status: "max_cost_reached", steps: 2 });
    expect(result.costUsd).toBeCloseTo(0.012);
    await limited.cleanup();

    const unknown = await setupRun({ policy: policyWith({ runtime_limits: { max_steps: 2 } }) });
    const free = await startRun({ ...unknown.deps, driver: scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")], costUsd: null })) }, input);
    expect(free.status).toBe("max_steps_reached");
    expect(free.costKnown).toBe(false);
    expect(unknown.repo.require(free.runId).cost_known).toBe(false);
    await unknown.cleanup();
  });

  it("never throws: a failing model ends the run as failed with the error recorded and a usage row", async () => {
    const error = Object.assign(new Error("invalid x-api-key"), { statusCode: 401 });
    const { result } = await run([{ calls: [readCall("context/brand-voice.md")] }, { fail: error }]);
    expect(result).toMatchObject({ status: "failed", steps: 1, error: { kind: "auth", message: "invalid x-api-key" } });
    expect(h.repo.require(result.runId)).toMatchObject({ status: "failed", error: { kind: "auth" } });
    const usage = h.store.usageSummary();
    expect(usage.find((r) => r.provider === "unknown")).toMatchObject({ failures: 1, calls: 1 });
    expect(usage.find((r) => r.provider === "test")).toMatchObject({ failures: 0, calls: 1 });
    expect((await h.events()).find((e) => e.event === "run.finished")!.payload.status).toBe("failed");
  });

  it("treats an empty answer with no tool calls as a failure, not a completion", async () => {
    const { result } = await run([{ text: "", calls: [] }]);
    expect(result).toMatchObject({ status: "failed", error: { kind: "empty_response" } });
  });

  it("saves an aborted run as aborted and resumable, without recording the interrupted step", async () => {
    const controller = new AbortController();
    const { result } = await run([{ calls: [readCall("context/brand-voice.md")] }, { onStep: () => controller.abort(), fail: new RunAbortedError() }], {}, controller.signal);
    expect(result).toMatchObject({ status: "aborted", steps: 1 });
    expect(h.repo.steps(result.runId)).toHaveLength(1);
    expect(h.repo.require(result.runId)).toMatchObject({ status: "aborted", lease_until: null });
  });
});

describe("the 80 percent wrap-up nudge", () => {
  const nudged = (call: { messages: { content: string }[] }) => call.messages.filter((m) => m.content.includes(NUDGE_MARKER)).length;
  const loopForever = () => ({ calls: [readCall("context/brand-voice.md")] });

  it("appears once, before step 10 of 12, and never earlier", async () => {
    const { driver } = await run(loopForever);
    expect(driver.calls).toHaveLength(12);
    for (let i = 0; i < 9; i += 1) expect(nudged(driver.calls[i]!), `call ${i + 1}`).toBe(0);
    for (let i = 9; i < 12; i += 1) expect(nudged(driver.calls[i]!), `call ${i + 1}`).toBe(1);
  });

  it("tells the model to stop exploring, synthesize, and propose if ready", async () => {
    const { driver } = await run(loopForever);
    const text = driver.calls[9]!.messages.find((m) => m.content.includes(NUDGE_MARKER))!.content;
    expect(text).toMatch(/80%/);
    expect(text).toMatch(/do not (start|open) new/i);
    expect(text).toMatch(/propose_plan_actions/);
    expect(text).toMatch(/conclude|final answer/i);
  });

  it("is persisted, so a resumed run keeps it", async () => {
    const { result } = await run(loopForever);
    expect(h.repo.require(result.runId).nudged).toBe(true);
    const flags = h.repo.steps(result.runId).map((s) => s.nudge);
    expect(flags.slice(0, 9).every((f) => f === false)).toBe(true);
    expect(flags.slice(9).every((f) => f === true)).toBe(true);
  });

  it("also fires at 80 percent of the token cap and of the cost cap", async () => {
    const tokens = await setupRun({ policy: policyWith({ runtime_limits: { max_tokens: 10_000 } }) });
    const a = scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")], usage: { inputTokens: 3500, outputTokens: 500 } }));
    await startRun({ ...tokens.deps, driver: a }, input);
    expect(nudged(a.calls[1]!)).toBe(0);
    expect(nudged(a.calls[2]!)).toBe(1); // 8000 of 10000 after two steps
    await tokens.cleanup();

    const cost = await setupRun({ policy: policyWith({ runtime_limits: { max_cost_usd: 1 } }) });
    const b = scriptedDriver(() => ({ calls: [readCall("context/brand-voice.md")], costUsd: 0.4 }));
    await startRun({ ...cost.deps, driver: b }, input);
    expect(nudged(b.calls[1]!)).toBe(0);
    expect(nudged(b.calls[2]!)).toBe(1); // 0.8 of 1.0 after two steps
    await cost.cleanup();
  });

  it("does not fire for a run that finishes early", async () => {
    const { driver } = await run([{ calls: [readCall("context/brand-voice.md")] }, { text: "done" }]);
    for (const call of driver.calls) expect(nudged(call)).toBe(0);
  });
});

describe("limits are audited when a policy raises them", () => {
  it("writes run_limits_elevated before the first step, naming each raised cap", async () => {
    const raised = await setupRun({ policy: policyWith({ runtime_limits: { max_steps: 20, max_cost_usd: 2 } }) });
    await startRun({ ...raised.deps, driver: scriptedDriver([{ calls: [readCall("context/brand-voice.md")] }, { text: "done" }]) }, input);
    const events = await raised.events();
    const names = events.map((e) => e.event);
    expect(names).toContain("run_limits_elevated");
    expect(names.indexOf("run_limits_elevated")).toBeLessThan(names.indexOf("tool.invoked"));
    expect(events.find((e) => e.event === "run_limits_elevated")!.payload).toMatchObject({
      run_id: "run_test1",
      raised: [{ key: "max_steps", default: 12, configured: 20 }, { key: "max_cost_usd", default: 1, configured: 2 }],
    });
    await raised.cleanup();
  });

  it("writes nothing extra for default or lowered limits", async () => {
    await run([{ text: "done" }]);
    expect(await eventNames()).not.toContain("run_limits_elevated");
    const lowered = await setupRun({ policy: policyWith({ runtime_limits: { max_steps: 5 } }) });
    await startRun({ ...lowered.deps, driver: scriptedDriver([{ text: "done" }]) }, input);
    expect((await lowered.events()).map((e) => e.event)).not.toContain("run_limits_elevated");
    await lowered.cleanup();
  });
});

describe("model failover is visible", () => {
  it("logs which target failed, why, and which one answered", async () => {
    const { result } = await run([
      { text: "done", model: { provider: "ollama", model: "gemma4:latest" }, failovers: [{ from: "google/gemini-3.8-flash", kind: "timeout", message: "stopped after 15000 ms" }] },
    ]);
    const event = (await h.events()).find((e) => e.event === "model.failover")!;
    expect(event.payload).toMatchObject({ run_id: result.runId, step: 1, from: "google/gemini-3.8-flash", to: "ollama/gemma4:latest", kind: "timeout" });
    expect(h.repo.steps(result.runId)[0]!.model).toEqual({ provider: "ollama", model: "gemma4:latest" });
  });
});

describe("policyHash", () => {
  it("is the SHA-256 of the canonical policy and changes when the policy changes", () => {
    expect(policyHash(h.policy)).toBe(createHash("sha256").update(canonicalJson(h.policy), "utf8").digest("hex"));
    expect(policyHash(policyWith({ runtime_limits: { max_steps: 5 } }))).not.toBe(policyHash(h.policy));
    expect(policyHash(h.policy)).toBe(policyHash(h.policy));
  });
});
