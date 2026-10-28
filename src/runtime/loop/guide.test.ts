// The whole Guide, Suggest, Act path against a scripted model on an EMPTY workspace: look at what is ready,
// ask, save what the owner said (only after they allow it), model a spend from it with no ad data, offer next
// steps. A scripted model proves the plumbing; whether a real model follows the pattern is checked live.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrowthPort } from "../../cli/growth-port.js";
import { ContextStore } from "../../context/store.js";
import type { RunEvent } from "../../run-events.js";
import { scriptedDriver, setupRun, type RunHarness } from "../../../test/helpers/loop.js";
import { contextTools } from "../tools/context-update.js";
import { growthTools } from "../tools/growth.js";
import { resumeRun } from "./resume.js";
import { startRun } from "./run.js";

let h: RunHarness;
beforeEach(async () => {
  h = await setupRun();
  const store = new ContextStore(h.dir, { audit: async ({ event, author, ...payload }) => void (await h.ledger.append({ actor: String(author), event: String(event), payload })) });
  for (const tool of contextTools(store)) h.deps.registry.register(tool);
  for (const tool of growthTools(createGrowthPort(h.dir))) h.deps.registry.register(tool);
});
afterEach(async () => {
  await h.cleanup();
});

const ECONOMICS = [
  "---",
  "currency: USD",
  "cpc: { value: 2, low: 1.5, high: 3, source: owner said, 28 Oct }",
  "landing_page_cvr: { value: 0.03, low: 0.02, high: 0.04, source: owner estimate }",
  "lead_to_chat: { value: 0.8, low: 0.7, high: 0.9, source: owner estimate }",
  "chat_to_qualified: { value: 0.5, low: 0.4, high: 0.6, source: owner estimate }",
  "qualified_to_deal: { value: 0.3, low: 0.2, high: 0.4, source: owner estimate }",
  "average_deal_value: { value: 4200, low: 3800, high: 4600, source: price list }",
  "gross_margin: { value: 0.25, low: 0.2, high: 0.3, source: owner said }",
  "---",
  "# Unit economics",
  "",
].join("\n");

const input = { task: "I just started. What should I do?", surface: "diagnosis" as const, slot: "reasoning" as const };

describe("an empty workspace, start to finish", () => {
  it("checks readiness, saves the owner's numbers once allowed, models a spend with no data, and offers next steps", async () => {
    const events: RunEvent[] = [];
    const onEvent = (e: RunEvent) => void events.push(e);

    // 1. The agent looks at what is ready, then proposes saving what the owner told it.
    const first = scriptedDriver([
      { text: "Let me check what is ready.", calls: [{ name: "workspace_readiness", input: {} }] },
      { text: "You gave me your numbers; I will save them.", calls: [{ name: "context_update", input: { file: "unit-economics", text: ECONOMICS, reason: "owner gave cost per click, rates and price" } }] },
    ]);
    const paused = await startRun({ ...h.deps, onEvent, driver: first }, input);
    expect(paused).toMatchObject({ status: "needs_human", pending: { callId: "c2_1", tool: "context_update" } });
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(1);
    // the readiness result the model saw said the files were not filled in
    const seen = first.calls[1]!.messages.map((m) => m.content).join("\n");
    expect(seen).toMatch(/unit-economics/);
    expect(await readFile(join(h.dir, "context", "unit-economics.md"), "utf8")).toContain("note: cost per click"); // nothing written yet

    // 2. The owner allows it; the agent models a spend with no scout and no data, then offers next steps.
    const second = scriptedDriver([
      { text: "Saved. Now a quick model.", calls: [{ name: "growth_simulate", input: { spend: 5000, scale_pct: 20 } }] },
      { calls: [{ name: "suggest_next", input: { actions: [{ label: "Export your Google Ads report", prompt: "Show me how to export my Google Ads report." }, { label: "Tell me your claims", prompt: "Ask me which claims I may make." }] } }] },
      { text: "Here is where you stand." },
    ]);
    const done = await resumeRun({ ...h.deps, onEvent, actor: "tui:omar", driver: second }, paused.runId, { approveTool: "c2_1" });
    expect(done.status).toBe("completed");

    // the file changed, the old text is kept, and the audit log says who and what (by hash)
    expect(await readFile(join(h.dir, "context", "unit-economics.md"), "utf8")).toBe(ECONOMICS);
    expect(await readFile(join(h.dir, ".medjay", "context-history", "unit-economics", "v1.md"), "utf8")).toContain("note: cost per click");
    const log = await h.events();
    expect(log.filter((e) => e.event === "context.updated")).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain("owner estimate");

    // the simulation ran as a target model and said so
    const sim = h.repo.steps(paused.runId).flatMap((s) => s.tool_results).find((r) => r.name === "growth_simulate");
    expect(sim).toMatchObject({ ok: true });
    expect(JSON.stringify(sim!.output)).toMatch(/target_model/);

    // nothing failed except the one call that waited for the owner
    const failed = events.filter((e): e is Extract<RunEvent, { type: "tool.finished" }> => e.type === "tool.finished" && !e.ok);
    expect(failed.map((e) => e.error_kind)).toEqual(["approval_required"]);

    // the offered steps are on the finished event
    const finished = events.filter((e): e is Extract<RunEvent, { type: "run.finished" }> => e.type === "run.finished").pop()!;
    expect(finished.suggestions).toHaveLength(2);
    expect(done.suggestions?.[0]?.label).toBe("Export your Google Ads report");
  });

  it("when the owner declines, the file is untouched and the agent moves on without it", async () => {
    const first = scriptedDriver([{ calls: [{ name: "context_update", input: { file: "unit-economics", text: ECONOMICS, reason: "r" } }] }]);
    const paused = await startRun({ ...h.deps, driver: first }, input);
    const done = await resumeRun({ ...h.deps, driver: scriptedDriver([{ text: "No problem. What would you like to change?" }]) }, paused.runId, { denyTool: "c1_1" });
    expect(done.status).toBe("completed");
    expect(await readFile(join(h.dir, "context", "unit-economics.md"), "utf8")).toContain("note: cost per click");
    expect((await h.events()).some((e) => e.event === "context.updated")).toBe(false);
  });
});
