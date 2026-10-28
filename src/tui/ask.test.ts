import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnose } from "../analysis/diagnose.js";
import { scout } from "../analysis/scout.js";
import { FIXTURE_NOW, setupIngest, type IngestHarness } from "../../test/helpers/ingest.js";
import { answerIntent, askAgent, resumeAgent, type AskContext } from "./ask.js";
import { emptyDashboard } from "./dashboard.js";
import type { Runner } from "./runner.js";
import { encodeEvent, type RunEvent } from "../run-events.js";

let h: IngestHarness;
let snapshot: ReturnType<typeof scout>;
beforeEach(async () => {
  h = await setupIngest();
  await h.ingest();
  snapshot = scout({ store: h.store, mappings: h.deps.mappings, baseCurrency: "SAR", timezone: "Asia/Riyadh", now: FIXTURE_NOW, days: 7, freshnessSlaHours: 24 });
});
afterEach(async () => {
  await h.cleanup();
});

function ctxWith(script: (argv: string[]) => { out?: string; err?: string; code?: number }, lang: "en" | "ar" = "en") {
  const calls: string[][] = [];
  const runner: Runner = (argv, onChunk) => {
    calls.push(argv);
    const r = script(argv);
    if (r.out) onChunk(r.out, "out");
    if (r.err) onChunk(r.err, "err");
    return { done: Promise.resolve({ code: r.code ?? 0 }), cancel: () => undefined };
  };
  const ctx: AskContext = { runner, workspaceDir: "/ws", dash: { ...emptyDashboard(), workspace: { id: "w", name: "W", currency: "SAR", timezone: "UTC" }, gate: { required: true, minChance: 0.6 } }, lang, cancelled: () => false };
  return { ctx, calls };
}

describe("answerIntent runs only read-only analyses and speaks plainly", () => {
  it("performance: scout --json, then a plain headline and a note when the mapping was generated", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: JSON.stringify({ ingest: null, snapshot }, null, 2), err: "[info] Auto-generated ingestion.mappings.yaml from detected CSV headers\n" }));
    const r = await answerIntent({ intent: "performance", params: {} }, ctx);
    expect(calls).toEqual([["scout", "--json", "--workspace", "/ws"]]);
    expect(r.text).toMatch(/^# Between 10–16 Oct you spent SAR 26,880/);
    expect(r.text).toContain("Note: I worked out how to read your files automatically");
    expect(r.text).toMatch(/> {3}1\. What's wasting money\?/);
    expect(r.suggestions.map((s) => s.intent)).toEqual(["waste", "scale", "plans"]);
  });

  it("waste: diagnose --json", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: JSON.stringify(diagnose(snapshot)) }));
    const r = await answerIntent({ intent: "waste", params: {} }, ctx);
    expect(calls[0]).toEqual(["diagnose", "--json", "--workspace", "/ws"]);
    expect(r.text).toContain("UMRAH-ALL-Broad-Reels on Meta spent SAR 3,780");
  });

  it("scale: passes the percentage, defaults to 20, and reports missing inputs when the CLI exits 1", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: JSON.stringify({ status: "insufficient_inputs", problems: [{ input: "cpc", problem: "missing", message: "m" }] }), code: 1 }));
    const r = await answerIntent({ intent: "scale", params: { pct: 35 } }, ctx);
    expect(calls[0]).toEqual(["simulate", "--json", "--scale-pct", "35", "--workspace", "/ws"]);
    expect(r.text).toMatch(/missing a few numbers/);
    await answerIntent({ intent: "scale", params: {} }, ctx);
    expect(calls[1]).toContain("20");
  });

  it("trust: ledger verify", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: "mdj ledger verify: OK, 9 entries, head abc\n" }));
    expect((await answerIntent({ intent: "trust", params: {} }, ctx)).text).toContain("Your activity log is intact: 9 entries");
    expect(calls[0]).toEqual(["ledger", "verify", "--workspace", "/ws"]);
  });

  it("local answers need no command: plans, data, approve, help, language", async () => {
    const { ctx, calls } = ctxWith(() => ({}));
    for (const intent of ["plans", "data", "approve", "help", "greet", "language"] as const) await answerIntent({ intent, params: {} }, ctx);
    expect(calls).toEqual([]);
    expect((await answerIntent({ intent: "approve", params: { plan: 4 } }, ctx)).text).toContain("mdj approve 4");
  });

  it("answers in Arabic when asked in Arabic", async () => {
    const { ctx } = ctxWith(() => ({ out: JSON.stringify(diagnose(snapshot)) }), "ar");
    expect((await answerIntent({ intent: "waste", params: {} }, ctx)).text).toContain("UMRAH-ALL-Broad-Reels على Meta صرفت");
  });

  it("explains a failure in one plain line instead of a stack trace", async () => {
    const { ctx } = ctxWith(() => ({ err: "error: no workspace found here\n", code: 1 }));
    const r = await answerIntent({ intent: "performance", params: {} }, ctx);
    expect(r.text).toMatch(/^# I couldn't finish that\.\nerror: no workspace found here/);
  });
});

describe("an empty workspace", () => {
  it("says there is no data yet, with the folder to use, instead of a raw error, in both languages", async () => {
    const err = "error: no ingestion.mappings.yaml in this workspace, and the exports in /ws/data/imports could not be matched automatically.\n";
    for (const intent of ["performance", "waste", "scale"] as const) {
      const { ctx } = ctxWith(() => ({ err, code: 1 }));
      const r = await answerIntent({ intent, params: {} }, ctx);
      expect(r.text, intent).toMatch(/^# I don.t have any ad numbers yet./);
      expect(r.text).toContain(join("/ws", "data", "imports"));
      expect(r.text).not.toContain("ingestion.mappings.yaml");
    }
    const { ctx: ar } = ctxWith(() => ({ err, code: 1 }), "ar");
    expect((await answerIntent({ intent: "performance", params: {} }, ar)).text).toMatch(/^# ما عندي أرقام/);
  });
});

describe("answerIntent when only period summaries exist", () => {
  const summary = {
    platform: "google",
    currency: "SAR",
    period: { start: "2026-09-01", end: "2026-09-30", days: 30 },
    totals: { spend: 1000, conversions: 10, clicks: 0, cost_per_conversion: 100 },
    campaigns: [{ name: "georgia", spend: 1000, conversions: 10, cost_per_conversion: 100, share_of_spend: 1 }],
    zero_conversion_terms: [{ term: "thailand", spend: 164.71, clicks: 17 }],
    zero_conversion_total: { terms: 1, spend: 164.71 },
    top_keywords: [],
    devices: [],
    daily: [],
    notes: [],
  };
  it("performance answers from the summary instead of saying there is no data", async () => {
    const { ctx } = ctxWith(() => ({ out: JSON.stringify({ ingest: null, snapshot: { status: "no_data" }, summary }) }));
    const r = await answerIntent({ intent: "performance", params: {} }, ctx);
    expect(r.text).toMatch(/^# Between 1–30 Sep you spent SAR 1,000/);
    expect(r.text).not.toMatch(/don.t have any ad numbers/);
  });
  it("waste answers from the summary's search terms", async () => {
    const { ctx } = ctxWith(() => ({ out: JSON.stringify({ status: "no_data", period: null, findings: [], top: [], summary }) }));
    const r = await answerIntent({ intent: "waste", params: {} }, ctx);
    expect(r.text).toContain("1 search terms that never turned into a conversion");
    expect(r.text).toContain("thailand: SAR 165");
  });
  it("still says there is no data when there is neither a snapshot nor a summary", async () => {
    const { ctx } = ctxWith(() => ({ out: JSON.stringify({ ingest: null, snapshot: { status: "no_data" }, summary: null }) }));
    const r = await answerIntent({ intent: "performance", params: {} }, ctx);
    expect(r.text).toMatch(/^# I don.t have any ad numbers yet/);
  });
});

describe("askAgent", () => {
  const finished = (over: Partial<Extract<RunEvent, { type: "run.finished" }>> = {}): RunEvent => ({ type: "run.finished", status: "completed", steps: 1, tokens: { input: 10, output: 5 }, cost_usd: 0.001, cost_known: true, final_text: "", proposals: 0, ...over });
  const stream = (...events: RunEvent[]) => events.map(encodeEvent).join("");

  it("sends the question after `--` with a marketer-language instruction, asks for events, and answers with the final text", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: stream(finished({ final_text: "Cut the broad Reels ad set first.", proposals: 1 })) }));
    const r = await askAgent("what should I cut?", ctx);
    expect(calls[0]!.slice(0, 5)).toEqual(["run", "--events", "--workspace", "/ws", "--"]);
    expect(calls[0]![5]).toContain("Question: what should I cut?");
    expect(calls[0]![5]).toContain("no jargon");
    expect(r.text).toContain("Cut the broad Reels ad set first.");
    expect(r.text).not.toMatch(/run_|tokens|\$0\./);
    expect(r.text).toContain("I prepared 1 plan(s) for you to review");
  });

  it("passes every event to the live view, even when a chunk ends mid-line", async () => {
    const seen: string[] = [];
    const lines = stream({ type: "run.started", run_id: "run_1", slot: "reasoning" }, { type: "step.started", step: 1, max_steps: 12 }, finished({ final_text: "ok" }));
    const half = Math.floor(lines.length / 2);
    const calls: string[][] = [];
    const runner: Runner = (argv, onChunk) => {
      calls.push(argv);
      onChunk(lines.slice(0, half), "out");
      onChunk(lines.slice(half), "out");
      return { done: Promise.resolve({ code: 0 }), cancel: () => undefined };
    };
    const { ctx } = ctxWith(() => ({}));
    const r = await askAgent("hi", { ...ctx, runner, onEvent: (e) => seen.push(e.type) });
    expect(seen).toEqual(["run.started", "step.started", "run.finished"]);
    expect(r.text).toContain("ok");
  });

  it("a missing key points to /connect with the provider", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({ status: "failed", steps: 0, error: { kind: "auth", message: 'all model targets failed: anthropic/x (auth: no API key for anthropic: store one with "mdj auth set anthropic")' } })), code: 1 }));
    const r = await askAgent("write three headlines", ctx);
    expect(r.text).toMatch(/^# I don.t have a key for anthropic yet/);
    expect(r.text).toContain("/connect anthropic");
    expect(r.text).not.toMatch(/run_x|targets failed/);
  });

  it("a rejected key is not reported as not connected", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({ status: "failed", steps: 0, error: { kind: "auth", message: "all model targets failed: openai/gpt-5.4-mini (auth: Invalid API key)" } })), code: 1 }));
    expect((await askAgent("hi", ctx)).text).toMatch(/^# openai rejected the saved key/);
  });

  it("a spend cap shows the reset date", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({ status: "failed", steps: 0, error: { kind: "failed", message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC." } })), code: 1 }));
    expect((await askAgent("hi", ctx)).text).toContain("2026-11-01");
  });

  it("when the command dies before any event, it still explains from the error text", async () => {
    const { ctx } = ctxWith(() => ({ err: "error: no workspace found here", code: 1 }));
    expect((await askAgent("hi", ctx)).text).toMatch(/^# I couldn't finish that/);
  });

  it("says plainly when the run stopped at a limit or is waiting, instead of showing nothing", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({ status: "max_steps_reached", steps: 12 })), code: 3 }));
    expect((await askAgent("hi", ctx)).text).toMatch(/had to stop before I finished/);
  });

  it("uses an Arabic instruction when the question is Arabic", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: stream(finished({ final_text: "تمام" })) }), "ar");
    await askAgent("اكتب لي عناوين", ctx);
    expect(calls[0]![5]).toMatch(/^أجب بالعربية/);
  });
});

describe("next steps at the end of an answer", () => {
  const finished = (over: Partial<Extract<RunEvent, { type: "run.finished" }>> = {}): RunEvent => ({ type: "run.finished", status: "completed", steps: 2, tokens: { input: 10, output: 5 }, cost_usd: 0.001, cost_known: true, final_text: "Here is where we are.", proposals: 0, ...over });
  const stream = (...events: RunEvent[]) => events.map(encodeEvent).join("");
  const offered = [
    { label: "Fill in your unit economics", prompt: "Ask me for my cost per click and price." },
    { label: "Show me what to export", prompt: "Which reports should I export from Google Ads?" },
  ];
  const dataOk = (c: ReturnType<typeof ctxWith>["ctx"]) => ({ ...c, dash: { ...c.dash, data: { status: "ok" as const, sources: [] } } });

  it("shows what the agent offered as a numbered list, and a typed number can pick it", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({ suggestions: offered })) }));
    const r = await askAgent("what now?", ctx);
    expect(r.text).toContain("Here is where we are.");
    expect(r.text).toMatch(/What next\? Type a number:\n>\s+1\. Fill in your unit economics\n>\s+2\. Show me what to export/);
    expect(r.suggestions).toEqual([
      { label: "Fill in your unit economics", intent: "help", prompt: "Ask me for my cost per click and price." },
      { label: "Show me what to export", intent: "help", prompt: "Which reports should I export from Google Ads?" },
    ]);
  });

  it("uses the Arabic heading for an Arabic question", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({ suggestions: offered })) }), "ar");
    expect((await askAgent("وش أسوي؟", ctx)).text).toContain("وبعدين؟ اكتب رقم:");
  });

  it("with no offer from the agent and no data yet, falls back to ways forward that need no data, never the generic ads menu", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({})) }));
    const r = await askAgent("hello", ctx);
    expect(r.suggestions.length).toBe(3);
    expect(r.suggestions.every((s) => typeof s.prompt === "string" && s.prompt.length > 0)).toBe(true);
    expect(r.text).toMatch(/1\. .*business/i);
    expect(r.text).not.toMatch(/How are my ads doing\?|What's wasting money\?/);
  });

  it("with data in place and no offer, keeps the usual suggestions", async () => {
    const { ctx } = ctxWith(() => ({ out: stream(finished({})) }));
    const r = await askAgent("hello", dataOk(ctx));
    expect(r.suggestions.map((s) => s.intent)).toContain("performance");
    expect(r.suggestions.some((s) => s.prompt !== undefined)).toBe(false);
  });
});

describe("a change that needs the owner's OK", () => {
  const finished = (over: Partial<Extract<RunEvent, { type: "run.finished" }>> = {}): RunEvent => ({ type: "run.finished", status: "completed", steps: 1, tokens: { input: 10, output: 5 }, cost_usd: 0.001, cost_known: true, final_text: "", proposals: 0, ...over });
  const stream = (...events: RunEvent[]) => events.map(encodeEvent).join("");
  const asking = (tool = "context_update"): string =>
    stream(
      { type: "run.started", run_id: "run_9", slot: "reasoning" },
      { type: "permission.requested", call_id: "c1_1", tool, summary: "offer-matrix: +2 / -0 lines (owner gave the offers)", diff: "+ Umrah 7 nights, 4200 SAR." },
      finished({ status: "needs_human", final_text: "I can save your offers.", pending: { call_id: "c1_1", tool } }),
    );

  it("hands the question back with what would change, instead of telling the owner to go to a terminal", async () => {
    const { ctx } = ctxWith(() => ({ out: asking(), code: 2 }));
    const r = await askAgent("save my offers", ctx);
    expect(r.permission).toEqual({ runId: "run_9", callId: "c1_1", tool: "context_update", summary: "offer-matrix: +2 / -0 lines (owner gave the offers)", diff: "+ Umrah 7 nights, 4200 SAR." });
    expect(r.text).toContain("I can save your offers.");
    expect(r.text).not.toContain("mdj resume");
  });

  it("offers the prompt only for a context change: any other waiting tool keeps the terminal instruction", async () => {
    for (const tool of ["read_file", "propose_plan_actions", "strike_plan", "approve_plan"]) {
      const { ctx } = ctxWith(() => ({ out: asking(tool), code: 2 }));
      const r = await askAgent("do it", ctx);
      expect(r.permission, tool).toBeUndefined();
      expect(r.text, tool).toContain("mdj resume run_9");
    }
  });

  it("resumeAgent allows exactly the waiting call once, or declines it, and answers with the run's next words", async () => {
    const seen: string[][] = [];
    const runner: Runner = (argv, onChunk) => {
      seen.push(argv);
      onChunk(stream(finished({ final_text: "Saved your offers." })), "out");
      return { done: Promise.resolve({ code: 0 }), cancel: () => undefined };
    };
    const { ctx } = ctxWith(() => ({}));
    const permission = { runId: "run_9", callId: "c1_1", tool: "context_update", summary: "s" };
    const allowed = await resumeAgent(permission, "allow", { ...ctx, runner });
    expect(seen[0]).toEqual(["resume", "run_9", "--events", "--workspace", "/ws", "--approve-tool", "c1_1"]);
    expect(allowed.text).toContain("Saved your offers.");
    await resumeAgent(permission, "deny", { ...ctx, runner });
    expect(seen[1]).toEqual(["resume", "run_9", "--events", "--workspace", "/ws", "--deny-tool", "c1_1"]);
  });

  it("refuses to build a command from an id that does not look like one of ours", async () => {
    const { ctx, calls } = ctxWith(() => ({}));
    for (const bad of [{ runId: "run_9; rm -rf", callId: "c1_1" }, { runId: "run_9", callId: "--approve-tool" }, { runId: "../x", callId: "c1_1" }]) {
      await expect(resumeAgent({ ...bad, tool: "context_update", summary: "s" }, "allow", ctx)).rejects.toThrow(/id/);
    }
    expect(calls).toEqual([]);
  });
});
