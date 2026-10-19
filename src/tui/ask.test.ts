import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnose } from "../analysis/diagnose.js";
import { scout } from "../analysis/scout.js";
import { FIXTURE_NOW, setupIngest, type IngestHarness } from "../../test/helpers/ingest.js";
import { answerIntent, askAgent, type AskContext } from "./ask.js";
import { emptyDashboard } from "./dashboard.js";
import type { Runner } from "./runner.js";

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

describe("askAgent", () => {
  it("sends the question after `--` with a marketer-language instruction and strips run bookkeeping", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: "\nCut the broad Reels ad set first.\n\nrun run_ab12cd34ef: completed after 3 step(s), 1200 tokens, $0.0100\n1 proposal(s) ready: `mdj runs proposals run_ab12cd34ef`\n" }));
    const r = await askAgent("what should I cut?", ctx);
    expect(calls[0]!.slice(0, 4)).toEqual(["run", "--workspace", "/ws", "--"]);
    expect(calls[0]![4]).toContain("Question: what should I cut?");
    expect(calls[0]![4]).toContain("no jargon");
    expect(r.text).toContain("Cut the broad Reels ad set first.");
    expect(r.text).not.toMatch(/run_ab12|tokens|\$0\./);
    expect(r.text).toContain("I prepared 1 plan(s) for you to review");
  });

  it("explains a missing model key in plain words", async () => {
    const { ctx } = ctxWith(() => ({ out: "run run_x: failed after 0 step(s)\n", err: 'auth: all model targets failed: anthropic/x (auth: no API key for anthropic: store one with "mdj auth set anthropic")\n', code: 1 }));
    const r = await askAgent("write three headlines", ctx);
    expect(r.text).toMatch(/^# I'm not connected to an AI model yet/);
    expect(r.text).not.toMatch(/run_x|targets failed/);
  });

  it("uses an Arabic instruction when the question is Arabic", async () => {
    const { ctx, calls } = ctxWith(() => ({ out: "تمام\n" }), "ar");
    await askAgent("اكتب لي عناوين", ctx);
    expect(calls[0]![4]).toMatch(/^أجب بالعربية/);
  });
});
