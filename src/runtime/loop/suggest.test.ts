import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEventLine, encodeEvent, type RunEvent } from "../../run-events.js";
import { scriptedDriver, setupRun, type RunHarness } from "../../../test/helpers/loop.js";
import { startRun } from "./run.js";

let h: RunHarness;
beforeEach(async () => {
  h = await setupRun();
});
afterEach(async () => {
  await h.cleanup();
});

const input = { task: "What should I do first?", surface: "diagnosis" as const, slot: "reasoning" as const };
const act = (n: number) => ({ label: `Option ${n}`, prompt: `Please do option ${n} for me.` });
const suggest = (...n: number[]) => ({ name: "suggest_next", input: { actions: n.map(act) } });
const finishedOf = (events: RunEvent[]) => events.find((e): e is Extract<RunEvent, { type: "run.finished" }> => e.type === "run.finished")!;

async function runWith(script: Parameters<typeof scriptedDriver>[0]) {
  const events: RunEvent[] = [];
  const result = await startRun({ ...h.deps, onEvent: (e) => void events.push(e), driver: scriptedDriver(script) }, input);
  return { result, events };
}

describe("suggestions at the end of a run", () => {
  it("the finished event carries what suggest_next offered, and so does the result", async () => {
    const { result, events } = await runWith([{ text: "Here is the plan.", calls: [suggest(1, 2, 3)] }, { text: "Pick one below." }]);
    expect(result.status).toBe("completed");
    expect(finishedOf(events).suggestions).toEqual([act(1), act(2), act(3)]);
    expect(result.suggestions).toEqual([act(1), act(2), act(3)]);
  });

  it("the last offer wins when the agent changes its mind", async () => {
    const { events } = await runWith([{ calls: [suggest(1, 2)] }, { calls: [suggest(3)] }, { text: "Done." }]);
    expect(finishedOf(events).suggestions).toEqual([act(3)]);
  });

  it("an offer the tool refused (four options) is not recorded, and the agent is told why", async () => {
    const bad = { name: "suggest_next", input: { actions: [act(1), act(2), act(3), act(4)] } };
    const driver = scriptedDriver([{ calls: [bad] }, { text: "Done." }]);
    const events: RunEvent[] = [];
    await startRun({ ...h.deps, onEvent: (e) => void events.push(e), driver }, input);
    expect(finishedOf(events).suggestions).toBeUndefined();
    expect(driver.calls[1]!.messages.map((m) => m.content).join("\n")).toMatch(/actions/);
  });

  it("no offer means no suggestions field at all, so the app falls back to its own", async () => {
    const { result, events } = await runWith([{ text: "Done." }]);
    expect(finishedOf(events).suggestions).toBeUndefined();
    expect(result.suggestions).toBeUndefined();
  });

  it("the event line round-trips and a malformed list is not accepted as an event", () => {
    const base = { type: "run.finished" as const, status: "completed", steps: 1, tokens: { input: 1, output: 1 }, cost_usd: 0, cost_known: true, final_text: "x", proposals: 0 };
    expect(parseEventLine(encodeEvent({ ...base, suggestions: [act(1)] }))).toMatchObject({ suggestions: [act(1)] });
    expect(parseEventLine(JSON.stringify({ ...base, suggestions: [act(1), act(2), act(3), act(4)] }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...base, suggestions: [{ label: "x" }] }))).toBeNull();
  });
});

describe("offering next steps ends the run", () => {
  it("a turn that writes its answer and calls suggest_next is the last turn: no second model call, the text is the answer", async () => {
    const driver = scriptedDriver([{ text: "Step 1: open Google Ads. Tell me when the file is saved.", calls: [suggest(1, 2)] }, { text: "I will repeat myself." }]);
    const events: RunEvent[] = [];
    const result = await startRun({ ...h.deps, onEvent: (e) => void events.push(e), driver }, input);
    expect(driver.calls).toHaveLength(1);
    expect(result).toMatchObject({ status: "completed", steps: 1, finalText: "Step 1: open Google Ads. Tell me when the file is saved." });
    expect(finishedOf(events).suggestions).toEqual([act(1), act(2)]);
  });

  it("a suggest_next call with no text of its own is not the end: the agent is asked for its answer", async () => {
    const driver = scriptedDriver([{ calls: [suggest(1)] }, { text: "Here is the answer." }]);
    const result = await startRun({ ...h.deps, driver }, input);
    expect(driver.calls).toHaveLength(2);
    expect(result).toMatchObject({ status: "completed", finalText: "Here is the answer." });
    expect(result.suggestions).toEqual([act(1)]);
  });

  it("a suggest_next that was refused does not end the run", async () => {
    const bad = { name: "suggest_next", input: { actions: [act(1), act(2), act(3), act(4)] } };
    const driver = scriptedDriver([{ text: "Answer.", calls: [bad] }, { text: "Fixed answer." }]);
    const result = await startRun({ ...h.deps, driver }, input);
    expect(driver.calls).toHaveLength(2);
    expect(result.finalText).toBe("Fixed answer.");
  });

  it("other tools alongside suggest_next in the same turn mean the turn is not final", async () => {
    const driver = scriptedDriver([{ text: "Looking.", calls: [suggest(1), { name: "list_files", input: { path: "context" } }] }, { text: "Done." }]);
    await startRun({ ...h.deps, driver }, input);
    expect(driver.calls).toHaveLength(2);
  });

  it("a stray 'Tool calls: ...' line the model copied from the history log never reaches the owner", async () => {
    const { result } = await runWith([{ text: "Real answer.\n\nTool calls: c5_1 suggest_next {\"actions\":[]}" }]);
    expect(result.finalText).toBe("Real answer.");
    const second = await runWith([{ text: "Answer two.", calls: [suggest(1)] }]);
    expect(second.result.finalText).toBe("Answer two.");
  });
});
