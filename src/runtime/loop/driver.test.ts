import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelCatalog } from "../../models/catalog.js";
import { CredentialResolver, type KeyStore } from "../../models/credentials.js";
import { resolveSlot, ModelsSchema } from "../../models/slots.js";
import { createAiSdkDriver } from "./driver.js";
import { RunAbortedError } from "./types.js";

const usage = { inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 }, outputTokens: { total: 30, text: 30, reasoning: 5 } };
const finish = (unified: string) => ({ type: "finish" as const, finishReason: { unified, raw: unified }, usage });

const streamOf = (parts: unknown[]) => ({ stream: simulateReadableStream({ chunks: parts as never[] }) });
const textStream = (text: string, extra: unknown[] = []) =>
  streamOf([{ type: "stream-start", warnings: [] }, ...extra, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: text }, { type: "text-end", id: "t1" }, finish("stop")]);
const callStream = (name: string, input: unknown) =>
  streamOf([{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "x1", toolName: name, input: JSON.stringify(input) }, finish("tool-calls")]);

const slotsOf = (primary: Record<string, unknown>, fallbacks: Record<string, unknown>[] = []) =>
  resolveSlot(
    ModelsSchema.parse({ slots: { fast: { primary }, reasoning: { primary, fallbacks }, creative: { primary } } }),
    "reasoning",
  );

const keys: KeyStore = { get: async () => null, set: async () => {}, delete: async () => true } as unknown as KeyStore;
const credentials = (env: Record<string, string> = {}) => new CredentialResolver({ keystore: keys, env });
const catalog = { find: () => ({ cost: { input: 3, output: 15 }, temperature: true }) } as unknown as ModelCatalog;

const tools = [{ name: "read_file", description: "Read a file", class: "read" as const, input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const input = (signal = new AbortController().signal) => ({ system: "sys", messages: [{ role: "user" as const, content: "hi" }], tools, signal });

const ANTHROPIC = { provider: "anthropic", model: "claude-x" };
const OLLAMA = { provider: "ollama", model: "gemma4:latest" };

describe("AI SDK driver", () => {
  it("returns text, usage and an estimated cost from the stream", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => textStream("Hello there.") });
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC), credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }), catalog, makeModel: () => model });
    const result = await driver.step(input());
    expect(result).toMatchObject({ text: "Hello there.", toolCalls: [], model: { provider: "anthropic", model: "claude-x" }, finishReason: "stop", failovers: [] });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedTokens: 20, reasoningTokens: 5 });
    expect(result.costUsd).toBeCloseTo((100 * 3 + 20 * 3 + 30 * 15) / 1_000_000, 10);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the tools without executing them and returns the model's calls to the loop", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => callStream("read_file", { path: "context/a.md" }) });
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC), credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }), catalog, makeModel: () => model });
    const result = await driver.step(input());
    expect(result.toolCalls).toEqual([{ name: "read_file", input: { path: "context/a.md" } }]);
    expect(model.doStreamCalls[0]!.tools?.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("ignores stream parts it does not know, like Anthropic's custom parts", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => textStream("ok", [{ type: "custom", kind: "anthropic-compaction", providerMetadata: {} }]) });
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC), credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }), catalog, makeModel: () => model });
    expect((await driver.step(input())).text).toBe("ok");
  });

  it("fails over to the next target and reports what failed; local Ollama costs nothing", async () => {
    const primary = new MockLanguageModelV4({ doStream: async () => { throw Object.assign(new Error("overloaded"), { statusCode: 503 }); } });
    const local = new MockLanguageModelV4({ doStream: async () => textStream("from local") });
    const driver = createAiSdkDriver({
      targets: slotsOf(ANTHROPIC, [OLLAMA]),
      credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }),
      catalog,
      makeModel: (t) => (t.provider === "ollama" ? local : primary),
    });
    const result = await driver.step(input());
    expect(result).toMatchObject({ text: "from local", model: { provider: "ollama" }, costUsd: 0 });
    expect(result.failovers).toEqual([expect.objectContaining({ from: "anthropic/claude-x", kind: "transient" })]);
  });

  it("treats a missing vendor key as an auth failure and moves on", async () => {
    const local = new MockLanguageModelV4({ doStream: async () => textStream("local answer") });
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC, [OLLAMA]), credentials: credentials(), catalog, makeModel: () => local });
    const result = await driver.step(input());
    expect(result.failovers[0]).toMatchObject({ from: "anthropic/claude-x", kind: "auth" });
    expect(result.model.provider).toBe("ollama");
  });

  it("never puts the key in an error or failover message", async () => {
    const primary = new MockLanguageModelV4({ doStream: async () => { throw Object.assign(new Error("bad key sk-secret-123"), { statusCode: 401 }); } });
    const local = new MockLanguageModelV4({ doStream: async () => textStream("fine") });
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC, [OLLAMA]), credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "sk-secret-123" }), catalog, makeModel: (t) => (t.provider === "ollama" ? local : primary) });
    const result = await driver.step(input());
    expect(JSON.stringify(result.failovers)).not.toContain("sk-secret-123");
  });

  it("surfaces an error part from the stream as a failure", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => streamOf([{ type: "stream-start", warnings: [] }, { type: "error", error: Object.assign(new Error("boom"), { statusCode: 400 }) }]) });
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC), credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }), catalog, makeModel: () => model });
    await expect(driver.step(input())).rejects.toThrow(/boom/);
  });

  it("an abort is not a failover: it throws RunAbortedError and the fallback is never tried", async () => {
    const controller = new AbortController();
    const primary = new MockLanguageModelV4({ doStream: async () => { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
    let fallbackUsed = false;
    const driver = createAiSdkDriver({
      targets: slotsOf(ANTHROPIC, [OLLAMA]),
      credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }),
      catalog,
      makeModel: (t) => (t.provider === "ollama" ? ((fallbackUsed = true), primary) : primary),
    });
    await expect(driver.step(input(controller.signal))).rejects.toBeInstanceOf(RunAbortedError);
    expect(fallbackUsed).toBe(false);
  });

  it("reports an unknown price as null, never a guess", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => textStream("x") });
    const noPrice = { find: () => undefined } as unknown as ModelCatalog;
    const driver = createAiSdkDriver({ targets: slotsOf(ANTHROPIC), credentials: credentials({ MEDJAY_ANTHROPIC_API_KEY: "k" }), catalog: noPrice, makeModel: () => model });
    expect((await driver.step(input())).costUsd).toBeNull();
  });
});
