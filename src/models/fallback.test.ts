import { describe, expect, it } from "vitest";
import { AllTargetsFailedError, classifyError, withFallback } from "./fallback.js";
import type { ResolvedTarget } from "./slots.js";

const target = (provider: ResolvedTarget["provider"], model: string, timeoutMs = 1000): ResolvedTarget => ({
  provider,
  model,
  timeoutMs,
  maxRetries: 0,
  local: provider === "ollama",
  credentialRequired: false,
  keychainRef: provider,
  envFallback: "MEDJAY_TEST_KEY",
  healthcheckPath: "/models",
});

const apiError = (statusCode: number | undefined, message: string) =>
  Object.assign(new Error(message), { name: "AI_APICallError", statusCode });

describe("classifyError", () => {
  it("classifies timeouts", () => {
    expect(classifyError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
  });

  it("classifies connection failures", () => {
    expect(classifyError(apiError(undefined, "Cannot connect to API: "))).toBe("connection");
    expect(classifyError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe("connection");
  });

  it("classifies auth, billing, transient and other errors", () => {
    expect(classifyError(apiError(401, "invalid x-api-key"))).toBe("auth");
    expect(classifyError(apiError(403, "forbidden"))).toBe("auth");
    expect(classifyError(apiError(400, "Your credit balance is too low to access the Anthropic API"))).toBe("billing");
    expect(classifyError(apiError(429, "rate limited"))).toBe("transient");
    expect(classifyError(apiError(503, "overloaded"))).toBe("transient");
    expect(classifyError(apiError(400, "tools.0.input_schema invalid"))).toBe("other");
    expect(classifyError("boom")).toBe("other");
  });
});

describe("withFallback", () => {
  it("returns the first target's result when it succeeds", async () => {
    const result = await withFallback([target("ollama", "a"), target("google", "b")], async (t) => t.model);
    expect(result).toMatchObject({ value: "a", attempts: [] });
    expect(result.target.model).toBe("a");
  });

  it("moves to the next target on connection errors and records the attempt", async () => {
    const result = await withFallback([target("ollama", "a"), target("google", "b")], async (t) => {
      if (t.model === "a") throw apiError(undefined, "Cannot connect to API: ");
      return t.model;
    });
    expect(result.value).toBe("b");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ kind: "connection" });
    expect(result.attempts[0]!.target.model).toBe("a");
  });

  it("does not hang: a target that never answers is aborted at its timeout and skipped", async () => {
    const started = Date.now();
    const result = await withFallback([target("ollama", "slow", 60), target("google", "fast")], (t, signal) =>
      t.model === "slow"
        ? new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          })
        : Promise.resolve("ok"),
    );
    expect(result.value).toBe("ok");
    expect(result.attempts[0]).toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not fall back on a request error that would fail everywhere", async () => {
    const bad = apiError(400, "tools.0.input_schema invalid");
    await expect(
      withFallback([target("anthropic", "a"), target("google", "b")], async () => {
        throw bad;
      }),
    ).rejects.toBe(bad);
  });

  it("throws AllTargetsFailedError listing every attempt when all targets fail over", async () => {
    const run = withFallback([target("ollama", "a"), target("google", "b")], async () => {
      throw apiError(401, "invalid x-api-key");
    });
    await expect(run).rejects.toBeInstanceOf(AllTargetsFailedError);
    await expect(run).rejects.toThrow(/ollama\/a.*auth.*google\/b.*auth/s);
  });

  it("fails clearly when given no targets", async () => {
    await expect(withFallback([], async () => 1)).rejects.toThrow(/no model targets/i);
  });
});
