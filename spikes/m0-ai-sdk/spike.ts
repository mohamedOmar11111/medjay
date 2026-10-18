// M0 spike: prove streamed multi-step tool calls through the Vercel AI SDK on three providers.
// Throwaway verification code; the real model layer lives in src/models/ (M0 scaffold).
// Keys are read from env for the spike only; the product uses the OS keychain.
import { writeFileSync } from "node:fs";
import { streamText, tool, isStepCount } from "ai";
import { z } from "zod";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";

const BUDGETS: Record<string, number> = { A: 95, B: 100 };
const EXPECTED_TOTAL = 195;

const tools = {
  lookup_budget: tool({
    description: "Look up the current daily budget (USD) of a campaign by its id.",
    inputSchema: z.object({ campaign: z.string().describe('Campaign id, e.g. "A"') }),
    execute: async ({ campaign }) => ({ campaign, daily_budget: BUDGETS[campaign] ?? null }),
  }),
  add: tool({
    description: "Add two numbers and return the sum.",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }) => ({ sum: a + b }),
  }),
};

const PROMPT =
  'Use the tools. Look up the daily budget of campaign "A" and of campaign "B", ' +
  "then use the add tool to sum the two budgets. Finish with exactly: TOTAL=<number>.";

type Target = { name: string; model: string; build: () => Parameters<typeof streamText>[0]["model"] };

const targets: Target[] = [
  {
    name: "anthropic",
    model: "claude-haiku-5-5",
    build: () => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })("claude-haiku-5-5"),
  },
  {
    name: "google",
    model: "gemini-3.8-flash",
    build: () =>
      createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })("gemini-3.8-flash"),
  },
  {
    name: "ollama",
    model: "gemma4:latest",
    build: () =>
      createOpenAICompatible({ name: "ollama", baseURL: "http://localhost:11434/v1", includeUsage: true }).chatModel(
        "gemma4:latest",
      ),
  },
  {
    name: "openai",
    model: process.env.SPIKE_OPENAI_MODEL ?? "gpt-6-luna",
    build: () =>
      createOpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL })(
        process.env.SPIKE_OPENAI_MODEL ?? "gpt-6-luna",
      ),
  },
];

const only = process.env.SPIKE_ONLY?.split(",");
const selected = only ? targets.filter((t) => only.includes(t.name)) : targets;

type Outcome = {
  provider: string;
  model: string;
  ok: boolean;
  steps: number;
  toolCalls: string[];
  toolResults: number;
  partTypes: string[];
  finalText: string;
  usage: unknown;
  ms: number;
  error?: string;
};

async function run(t: Target): Promise<Outcome> {
  const started = Date.now();
  const out: Outcome = {
    provider: t.name, model: t.model, ok: false, steps: 0, toolCalls: [], toolResults: 0,
    partTypes: [], finalText: "", usage: null, ms: 0,
  };
  try {
    const result = streamText({
      model: t.build(),
      tools,
      stopWhen: isStepCount(6),
      prompt: PROMPT,
      abortSignal: AbortSignal.timeout(180_000),
    });
    const seen = new Set<string>();
    for await (const part of result.stream) {
      seen.add(part.type);
      if (part.type === "tool-call") out.toolCalls.push(`${part.toolName}(${JSON.stringify(part.input)})`);
      if (part.type === "tool-result") out.toolResults += 1;
      if (part.type === "text-delta") out.finalText += part.text;
      if (part.type === "finish-step") out.steps += 1;
      if (part.type === "error") throw part.error;
    }
    out.partTypes = [...seen].sort();
    out.usage = await result.usage;
    const total = out.finalText.match(/TOTAL\s*=\s*(\d+(?:\.\d+)?)/);
    out.ok =
      out.steps >= 2 &&
      out.toolCalls.some((c) => c.startsWith("lookup_budget")) &&
      out.toolCalls.some((c) => c.startsWith("add")) &&
      out.toolResults >= 3 &&
      total !== null &&
      Number(total[1]) === EXPECTED_TOTAL;
  } catch (e) {
    out.error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 400) : String(e).slice(0, 400);
  }
  out.ms = Date.now() - started;
  return out;
}

const outcomes: Outcome[] = [];
for (const t of selected) {
  process.stdout.write(`running ${t.name} / ${t.model} ... `);
  const o = await run(t);
  outcomes.push(o);
  console.log(o.ok ? "PASS" : "FAIL", `(${o.ms} ms, ${o.steps} steps, ${o.toolCalls.length} tool calls)`);
  if (o.error) console.log("  error:", o.error);
}

writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(outcomes, null, 2));
console.log("\n" + JSON.stringify(outcomes, null, 2));
process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
