// The real model driver: one streamed model call per step through the Vercel AI SDK, with slot
// failover, timeouts, credential lookup and cost estimation. Tools are described to the model but
// never given an `execute`: the loop owns every tool call so each goes through the registry.
import { jsonSchema, streamText, tool, type LanguageModel } from "ai";
import { estimateCostUsd, temperatureFor, type ModelCatalog } from "../../models/catalog.js";
import type { CredentialResolver } from "../../models/credentials.js";
import { createLanguageModel } from "../../models/factory.js";
import { withFallback } from "../../models/fallback.js";
import type { ResolvedTarget } from "../../models/slots.js";
import { RunAbortedError, type ModelDriver, type ModelStepInput, type ModelStepResult, type StepUsage } from "./types.js";

export interface AiSdkDriverOptions {
  targets: ResolvedTarget[];
  credentials: CredentialResolver;
  catalog: ModelCatalog;
  /** Override for tests; defaults to the provider factory. */
  makeModel?: (target: ResolvedTarget, apiKey?: string) => LanguageModel;
}

interface TokenCounts {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
  outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
}

const toUsage = (u: TokenCounts | undefined): StepUsage => ({
  inputTokens: u?.inputTokens ?? 0,
  outputTokens: u?.outputTokens ?? 0,
  cachedTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
  reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? 0,
});

/** Keep the error's shape (so it classifies for failover) but never its copy of the key. */
function scrub(error: unknown, secret: string | undefined): unknown {
  if (!secret || !(error instanceof Error) || !error.message.includes(secret)) return error;
  const shape = error as unknown as { statusCode?: unknown; code?: unknown };
  return Object.assign(new Error(error.message.split(secret).join("[REDACTED_SECRET]")), {
    name: error.name,
    ...(typeof shape.statusCode === "number" ? { statusCode: shape.statusCode } : {}),
    ...(typeof shape.code === "string" ? { code: shape.code } : {}),
  });
}

export function createAiSdkDriver(options: AiSdkDriverOptions): ModelDriver {
  const make = options.makeModel ?? createLanguageModel;

  async function attempt(target: ResolvedTarget, timeout: AbortSignal, input: ModelStepInput) {
    let apiKey: string | undefined;
    if (target.credentialRequired) {
      const resolved = await options.credentials.resolve({ keychainRef: target.keychainRef, envFallback: target.envFallback });
      if (resolved.source === "none") {
        throw Object.assign(new Error(`no API key for ${target.provider}: store one with "mdj auth set ${target.provider}"`), { statusCode: 401 });
      }
      apiKey = resolved.value;
    }
    const abortSignal = AbortSignal.any([input.signal, timeout]);
    const tools = Object.fromEntries(input.tools.map((spec) => [spec.name, tool({ description: spec.description, inputSchema: jsonSchema(spec.input_schema as never) })]));
    const temperature = temperatureFor(target, options.catalog);
    const started = Date.now();
    try {
      const run = streamText({
        model: make(target, apiKey),
        system: input.system,
        messages: input.messages,
        tools,
        abortSignal,
        maxRetries: target.maxRetries,
        ...(temperature === undefined ? {} : { temperature }),
        onError: () => {},
      });
      let text = "";
      const toolCalls: { name: string; input: unknown }[] = [];
      let usage: TokenCounts | undefined;
      let finishReason = "unknown";
      for await (const part of run.fullStream) {
        // Parts this driver does not know (Anthropic `custom`, source, reasoning...) are ignored.
        if (part.type === "text-delta") text += part.text;
        else if (part.type === "tool-call") toolCalls.push({ name: part.toolName, input: part.input });
        else if (part.type === "finish") {
          usage = part.totalUsage;
          finishReason = part.finishReason;
        } else if (part.type === "error") throw part.error;
      }
      if (input.signal.aborted) throw new RunAbortedError(); // an aborted stream ends quietly, not with an error
      return { text, toolCalls, usage: toUsage(usage), finishReason, latencyMs: Date.now() - started };
    } catch (error) {
      if (input.signal.aborted) throw new RunAbortedError();
      throw scrub(error, apiKey);
    }
  }

  return {
    async step(input) {
      const { value, target, attempts } = await withFallback(options.targets, (t, timeout) => attempt(t, timeout, input));
      return {
        text: value.text,
        toolCalls: value.toolCalls,
        usage: value.usage,
        costUsd: estimateCostUsd(target, options.catalog, value.usage),
        model: { provider: target.provider, model: target.model },
        latencyMs: value.latencyMs,
        failovers: attempts.map((a) => ({ from: `${a.target.provider}/${a.target.model}`, kind: a.kind, message: a.message })),
        finishReason: value.finishReason,
      } satisfies ModelStepResult;
    },
  };
}
