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
