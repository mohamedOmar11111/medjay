// Answering a marketer's question: run the right read-only analysis through the CLI (as a child
// process, with --json), then turn the result into plain words. Nothing here can change a platform:
// the only commands used are scout, diagnose, simulate, ledger verify and the agent's `run`.
import { join } from "node:path";
import type { Diagnosis } from "../analysis/diagnose.js";
import type { Snapshot } from "../analysis/scout.js";
import type { SimulationResult } from "../analysis/simulate.js";
import type { PeriodSummary } from "../analysis/summary.js";
import { approveAnswer, dataAnswer, errorAnswer, helpAnswer, languageAnswer, noDataAnswer, modelErrorAnswer, performanceAnswer, summaryPerformanceAnswer, summaryWasteAnswer, plansAnswer, renderAnswer, scaleAnswer, trustAnswer, wasteAnswer, type Answer, type Suggestion } from "./answers.js";
import type { Dashboard } from "./dashboard.js";
import type { IntentName, Language, Routed } from "./intent.js";
import { classifyModelFailure, type ModelFailure } from "./model-errors.js";
import { lineSplitter } from "./lines.js";
import { parseEventLine, type RunEvent } from "../run-events.js";
import type { Runner } from "./runner.js";

/** Where exports go by default. A workspace can point elsewhere in workspace.yaml; this is only for wording. */
export const dropzoneOf = (workspaceDir: string): string => join(workspaceDir, "data", "imports");

const NO_DATA_ERROR = /no ingestion.mappings.yaml|no spend to simulate|could not be matched automatically|no CSV files found/;
export const DEFAULT_SCALE_PCT = 20;

export interface AskContext {
  runner: Runner;
  workspaceDir: string;
  dash: Dashboard;
  lang: Language;
  cancelled: () => boolean;
  /** Sees the agent's progress events as they arrive (the live cards). */
  onEvent?: (event: RunEvent) => void;
}

export interface Reply {
  text: string;
  suggestions: Suggestion[];
  /** Set when the answer is really a model-connection problem, so a caller can fall back. */
  modelFailure?: ModelFailure;
}

const reply = (a: Answer, lang: Language, extra: string[] = []): Reply => ({ text: renderAnswer({ ...a, body: [...a.body, ...extra] }, lang), suggestions: a.next });

interface Collected {
  code: number;
  out: string;
  err: string;
}

async function collect(ctx: AskContext, argv: string[]): Promise<Collected> {
  let out = "";
  let err = "";
  const { code } = await ctx.runner(argv, (text, stream) => (stream === "out" ? (out += text) : (err += text))).done;
  return { code, out, err };
}

function json<T>(c: Collected): T | null {
  const start = c.out.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(c.out.slice(start)) as T;
  } catch {
    return null;
  }
}

const firstLine = (c: Collected): string => (c.err.trim() || c.out.trim()).split("\n").find((l) => l.trim() !== "" && !l.startsWith("[info]")) ?? "";

const mappingNote = (c: Collected, lang: Language): string[] =>
  /Auto-generated ingestion\.mappings\.yaml/.test(c.err)
    ? [lang === "ar" ? "ملاحظة: اكتشفت طريقة قراءة ملفاتك تلقائياً. يستاهل تراجع ingestion.mappings.yaml بسرعة." : "Note: I worked out how to read your files automatically. Worth a quick look at ingestion.mappings.yaml."]
    : [];

/** Answer a recognized question. */
export async function answerIntent(routed: Routed, ctx: AskContext): Promise<Reply> {
  const { lang, workspaceDir: dir, dash } = ctx;
  const dropzone = dropzoneOf(dir);
  const failed = (c: Collected): Reply => (NO_DATA_ERROR.test(`${c.err}${c.out}`) ? reply(noDataAnswer(lang, dropzone), lang) : reply(errorAnswer(lang, firstLine(c)), lang));
  const intent: IntentName = routed.intent;
  switch (intent) {
    case "performance": {
      const c = await collect(ctx, ["scout", "--json", "--workspace", dir]);
      const data = json<{ snapshot: Snapshot; summary?: PeriodSummary | null }>(c);
      if (data?.snapshot.status === "no_data" && data.summary) return reply(summaryPerformanceAnswer(data.summary, lang), lang, mappingNote(c, lang));
      return data ? reply(performanceAnswer(data.snapshot, lang, dropzone), lang, mappingNote(c, lang)) : failed(c);
    }
    case "waste": {
      const c = await collect(ctx, ["diagnose", "--json", "--workspace", dir]);
      const data = json<Diagnosis & { summary?: PeriodSummary | null }>(c);
      if (data?.status === "no_data" && data.summary) return reply(summaryWasteAnswer(data.summary, lang), lang, mappingNote(c, lang));
      return data ? reply(wasteAnswer(data, lang, dropzone), lang, mappingNote(c, lang)) : failed(c);
    }
    case "scale": {
      const pct = routed.params.pct ?? DEFAULT_SCALE_PCT;
      const c = await collect(ctx, ["simulate", "--json", "--scale-pct", String(pct), "--workspace", dir]);
      const data = json<SimulationResult>(c);
      return data ? reply(scaleAnswer(data, pct, lang, dash.gate?.minChance ?? 0.6, dash.workspace?.currency ?? ""), lang, mappingNote(c, lang)) : failed(c);
    }
    case "plans":
      return reply(plansAnswer(dash, lang), lang);
    case "data":
      return reply(dataAnswer(dash, lang, dropzone), lang);
    case "trust": {
      const c = await collect(ctx, ["ledger", "verify", "--workspace", dir]);
      return reply(trustAnswer(`${c.out}${c.err}`, lang), lang);
    }
    case "approve":
      return reply(approveAnswer(routed.params.plan, lang), lang);
    case "language":
      return reply(languageAnswer(routed.params.language ?? lang), routed.params.language ?? lang);
    case "help":
    case "greet":
      return reply(helpAnswer(lang, intent === "greet"), lang);
  }
}

const CHAT_PREFIX: Record<Language, string> = {
  en: "You are Medjay, a friendly growth assistant for a busy marketer. The user is chatting. Reply warmly in one or two short sentences, in their language, then offer one concrete thing you could look at in their ads. Do not list a menu. They said: ",
  ar: "أنت Medjay، مساعد نمو ودود لمسوّق مشغول. المستخدم يتحدث معك. رد بجملة أو جملتين بكلام بسيط وودي، ثم اقترح شيئاً واحداً محدداً تقدر تراجعه في إعلاناته. بدون قوائم. قال: ",
};

const TASK_PREFIX: Record<Language, string> = {
  en: 'Answer for a busy marketer: plain words, lead with the money impact, no jargon (say "revenue per ad dollar", not MER). Question: ',
  ar: "أجب بالعربية وبكلمات بسيطة لمسوّق مشغول: ابدأ بأثر المال ولا تستخدم مصطلحات تقنية. السؤال: ",
};

/** Hand an open question to the agent. Progress arrives as events while it works; the answer is the final event. */
export async function askAgent(text: string, ctx: AskContext, tone: "task" | "chat" = "task"): Promise<Reply> {
  const state: { finished: Extract<RunEvent, { type: "run.finished" }> | null; runId: string | null; stray: string; err: string } = { finished: null, runId: null, stray: "", err: "" };
  const split = lineSplitter((line) => {
    const event = parseEventLine(line);
    if (event === null) {
      state.stray += `${line}\n`;
      return;
    }
    if (event.type === "run.finished") state.finished = event;
    if (event.type === "run.started") state.runId = event.run_id;
    try {
      ctx.onEvent?.(event);
    } catch {
      // a bug in the live view must not lose the answer
    }
  });
  const { code } = await ctx.runner(["run", "--events", "--workspace", ctx.workspaceDir, "--", `${(tone === "chat" ? CHAT_PREFIX : TASK_PREFIX)[ctx.lang]}${text}`], (chunk, stream) => (stream === "out" ? split.push(chunk) : void (state.err += chunk))).done;
  split.end();
  const lang = ctx.lang;
  const fin = state.finished;
  if (fin === null) {
    // the command ended before it could report: explain from whatever it printed
    const failure = code !== 0 ? classifyModelFailure(`${state.err}\n${state.stray}`) : null;
    if (failure) return { ...reply(modelErrorAnswer(failure, lang), lang), modelFailure: failure };
    if (code !== 0) return reply(errorAnswer(lang, firstLine({ code, out: state.stray, err: state.err })), lang);
    return { text: state.stray.trim(), suggestions: helpAnswer(lang, false).next.slice(0, 4) };
  }
  if (fin.error) {
    const failure = classifyModelFailure(`${fin.error.kind}: ${fin.error.message}`);
    return failure ? { ...reply(modelErrorAnswer(failure, lang), lang), modelFailure: failure } : reply(errorAnswer(lang, fin.error.message), lang);
  }
  const suggestions = helpAnswer(lang, false).next.slice(0, 4);
  if (fin.status !== "completed") {
    const resume = state.runId ? ` mdj resume ${state.runId}` : "";
    const head = lang === "ar" ? "اضطريت أوقف قبل ما أخلص." : "I had to stop before I finished.";
    const why = fin.status.startsWith("max_") ? (lang === "ar" ? "وصلت لحد الأمان المحدد لكل مرة." : "I reached the safety limit for one request.") : fin.status === "needs_human" ? (lang === "ar" ? "أحتاج موافقتك على خطوة." : "I need your OK on one step.") : lang === "ar" ? "تم الإيقاف." : "I was stopped.";
    const tail = resume ? (lang === "ar" ? `تكملها من الطرفية:${resume}` : `You can continue it from a terminal:${resume}`) : "";
    return { text: [`# ${head}`, why, ...(fin.final_text.trim() ? ["", fin.final_text.trim()] : []), ...(tail ? ["", tail] : [])].join("\n"), suggestions };
  }
  const lines = [fin.final_text.trim()];
  if (fin.proposals > 0) lines.push("", lang === "ar" ? `جهّزت ${fin.proposals} خطة لتراجعها. اسألني \"ايش ينتظر موافقتي؟\"` : `I prepared ${fin.proposals} plan(s) for you to review. Ask me \"What's waiting for my approval?\"`);
  return { text: lines.join("\n"), suggestions };
}
