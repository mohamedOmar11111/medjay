import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextStore } from "../../context/store.js";
import type { RunEvent } from "../../run-events.js";
import { scriptedDriver, setupRun, type RunHarness } from "../../../test/helpers/loop.js";
import { contextTools } from "../tools/context-update.js";
import { ResumeError, resumeRun } from "./resume.js";
import { startRun } from "./run.js";

let h: RunHarness;
beforeEach(async () => {
  h = await setupRun();
  const store = new ContextStore(h.dir, { audit: async ({ event, author, ...payload }) => void (await h.ledger.append({ actor: String(author), event: String(event), payload })) });
  for (const tool of contextTools(store)) h.deps.registry.register(tool);
});
afterEach(async () => {
  await h.cleanup();
});

const OFFERS = "---\nworkspace: ws\n---\n# Offers\n\nUmrah 7 nights, 4200 SAR.\n";
const OTHER = `${OFFERS}\nHajj packages on request.\n`;
const update = (text: string) => ({ name: "context_update", input: { file: "offer-matrix", text, reason: "owner gave the offers" } });
const input = { task: "Save my offers.", surface: "diagnosis" as const, slot: "reasoning" as const };
const offersFile = () => readFile(join(h.dir, "context", "offer-matrix.md"), "utf8");
const collect = () => {
  const events: RunEvent[] = [];
  return { events, onEvent: (e: RunEvent) => void events.push(e), requests: () => events.filter((e): e is Extract<RunEvent, { type: "permission.requested" }> => e.type === "permission.requested") };
};

describe("a run that needs a person's OK for a context change", () => {
  it("stops, tells the observer what would change (with the diff), and writes nothing", async () => {
    const seen = collect();
    const before = await offersFile();
    const result = await startRun({ ...h.deps, onEvent: seen.onEvent, driver: scriptedDriver([{ text: "Saving.", calls: [update(OFFERS)] }]) }, input);
    expect(result).toMatchObject({ status: "needs_human", pending: { callId: "c1_1", tool: "context_update" } });
    expect(seen.requests()).toHaveLength(1);
    const [request] = seen.requests();
    expect(request).toMatchObject({ call_id: "c1_1", tool: "context_update" });
    expect(request!.summary).toMatch(/offer-matrix/);
    expect(request!.diff).toContain("+ Umrah 7 nights");
    expect(await offersFile()).toBe(before);
  });

  it("does not ask when the text could not be saved anyway: the model is told what to fix", async () => {
    const seen = collect();
    const bad = { name: "context_update", input: { file: "unit-economics", text: "---\ncurrency: SAR\ncpc: 2\n---\n# x\n", reason: "r" } };
    const driver = scriptedDriver([{ calls: [bad] }, { text: "I will use a range." }]);
    const result = await startRun({ ...h.deps, onEvent: seen.onEvent, driver }, input);
    expect(result.status).toBe("completed");
    expect(seen.requests()).toEqual([]);
    expect(driver.calls[1]!.messages.map((m) => m.content).join("\n")).toMatch(/bare number|low and high/);
  });

  it("writes the change when the person allows that call, then the run carries on", async () => {
    const paused = await startRun({ ...h.deps, driver: scriptedDriver([{ calls: [update(OFFERS)] }]) }, input);
    const result = await resumeRun({ ...h.deps, actor: "tui:omar", driver: scriptedDriver([{ text: "Saved your offers." }]) }, paused.runId, { approveTool: "c1_1" });
    expect(result).toMatchObject({ status: "completed", finalText: "Saved your offers." });
    expect(await offersFile()).toBe(OFFERS);
    const events = await h.events();
    expect(events.find((e) => e.event === "context.updated")).toBeDefined();
    expect(events.find((e) => e.event === "tool.approved_once")?.actor).toBe("tui:omar");
  });

  it("with a denial: writes nothing, tells the model the owner declined, records who said no, and the run carries on", async () => {
    const paused = await startRun({ ...h.deps, driver: scriptedDriver([{ calls: [update(OFFERS)] }]) }, input);
    const before = await offersFile();
    const second = scriptedDriver([{ text: "Understood, I will not save that." }]);
    const result = await resumeRun({ ...h.deps, actor: "tui:omar", driver: second }, paused.runId, { denyTool: "c1_1" });
    expect(result).toMatchObject({ status: "completed", finalText: "Understood, I will not save that." });
    expect(await offersFile()).toBe(before);
    expect(second.calls[0]!.messages.map((m) => m.content).join("\n")).toMatch(/owner declined/i);
    const events = await h.events();
    expect(events.find((e) => e.event === "tool.denied_once")).toMatchObject({ actor: "tui:omar", payload: { call_id: "c1_1", tool: "context_update" } });
    expect(events.find((e) => e.event === "context.updated")).toBeUndefined();
    expect(events.find((e) => e.event === "run.resumed")?.payload).toMatchObject({ denied_call: "c1_1" });
  });

  it("refuses the same proposal again in the same run, without asking the person a second time", async () => {
    const seen = collect();
    const paused = await startRun({ ...h.deps, onEvent: seen.onEvent, driver: scriptedDriver([{ calls: [update(OFFERS)] }]) }, input);
    const second = scriptedDriver([{ calls: [update(OFFERS)] }, { text: "Fine, leaving it." }]);
    const result = await resumeRun({ ...h.deps, onEvent: seen.onEvent, driver: second }, paused.runId, { denyTool: "c1_1" });
    expect(result.status).toBe("completed");
    expect(seen.requests()).toHaveLength(1); // only the first proposal ever reached the person
    expect(second.calls[1]!.messages.map((m) => m.content).join("\n")).toMatch(/already declined/i);
    expect(await offersFile()).not.toContain("Umrah");
  });

  it("does ask again for a different proposal after a denial", async () => {
    const seen = collect();
    const paused = await startRun({ ...h.deps, onEvent: seen.onEvent, driver: scriptedDriver([{ calls: [update(OFFERS)] }]) }, input);
    const result = await resumeRun({ ...h.deps, onEvent: seen.onEvent, driver: scriptedDriver([{ calls: [update(OTHER)] }]) }, paused.runId, { denyTool: "c1_1" });
    expect(result).toMatchObject({ status: "needs_human", pending: { callId: "c2_1" } });
    expect(seen.requests()).toHaveLength(2);
  });

  it("will not allow and deny at once, or deny a call that is not the pending one", async () => {
    const paused = await startRun({ ...h.deps, driver: scriptedDriver([{ calls: [update(OFFERS)] }]) }, input);
    const driver = scriptedDriver([{ text: "x" }]);
    await expect(resumeRun({ ...h.deps, driver }, paused.runId, { approveTool: "c1_1", denyTool: "c1_1" })).rejects.toThrow(ResumeError);
    await expect(resumeRun({ ...h.deps, driver }, paused.runId, { denyTool: "c9_9" })).rejects.toThrow(/pending/);
    expect(driver.calls).toHaveLength(0);
  });
});
