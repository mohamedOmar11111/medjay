// Answering a marketer's question: run the right read-only analysis through the CLI (as a child
// process, with --json), then turn the result into plain words. Nothing here can change a platform:
// the only commands used are scout, diagnose, simulate, ledger verify and the agent's `run`.
import { join } from "node:path";
import type { Diagnosis } from "../analysis/diagnose.js";
import type { Snapshot } from "../analysis/scout.js";
import type { SimulationResult } from "../analysis/simulate.js";
import { approveAnswer, dataAnswer, errorAnswer, helpAnswer, languageAnswer, noDataAnswer, noModelAnswer, performanceAnswer, plansAnswer, renderAnswer, scaleAnswer, trustAnswer, wasteAnswer, type Answer, type Suggestion } from "./answers.js";
import type { Dashboard } from "./dashboard.js";
import type { IntentName, Language, Routed } from "./intent.js";
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
}

export interface Reply {
  text: string;
  suggestions: Suggestion[];
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
      const data = json<{ snapshot: Snapshot }>(c);
      return data ? reply(performanceAnswer(data.snapshot, lang, dropzone), lang, mappingNote(c, lang)) : failed(c);
    }
    case "waste": {
      const c = await collect(ctx, ["diagnose", "--json", "--workspace", dir]);
      const data = json<Diagnosis>(c);
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

const TASK_PREFIX: Record<Language, string> = {
  en: 'Answer for a busy marketer: plain words, lead with the money impact, no jargon (say "revenue per ad dollar", not MER). Question: ',
  ar: "أجب بالعربية وبكلمات بسيطة لمسوّق مشغول: ابدأ بأثر المال ولا تستخدم مصطلحات تقنية. السؤال: ",
};

/** Hand an open question to the agent, and strip the run bookkeeping from what comes back. */
export async function askAgent(text: string, ctx: AskContext): Promise<Reply> {
  const c = await collect(ctx, ["run", "--workspace", ctx.workspaceDir, "--", `${TASK_PREFIX[ctx.lang]}${text}`]);
  if (/no API key|\bauth:|all model targets failed/i.test(`${c.err}${c.out}`)) return reply(noModelAnswer(ctx.lang), ctx.lang);
  const cut = c.out.search(/\nrun run_[0-9a-f]+:/);
  const answer = (cut === -1 ? c.out : c.out.slice(0, cut)).trim();
  const proposals = /(\d+) proposal\(s\) ready/.exec(c.out);
  if (c.code !== 0 && answer === "") return reply(errorAnswer(ctx.lang, firstLine(c)), ctx.lang);
  const lines = [answer === "" ? firstLine(c) : answer];
  if (proposals) lines.push("", ctx.lang === "ar" ? `جهّزت ${proposals[1]} خطة لتراجعها. اسألني "ايش ينتظر موافقتي؟"` : `I prepared ${proposals[1]} plan(s) for you to review. Ask me "What's waiting for my approval?"`);
  return { text: lines.join("\n"), suggestions: helpAnswer(ctx.lang, false).next.slice(0, 4) };
}
