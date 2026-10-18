import { describe, expect, it } from "vitest";
import { ModelsSchema, parseModelRef, resolveSlot } from "./slots.js";

const slots = {
  fast: { primary: { provider: "ollama", model: "qwen2.5" } },
  reasoning: { primary: { provider: "anthropic", model: "claude-sonnet-5-5" } },
  creative: { primary: { provider: "anthropic", model: "claude-sonnet-5-5" } },
};
const models = (over: Record<string, unknown> = {}) => ({ slots: { ...slots, ...over } });
const parse = (value: unknown) => ModelsSchema.parse(value);

describe("ModelsSchema", () => {
  it("accepts the v1 shape with routing defaults", () => {
    const parsed = parse(models());
    expect(parsed.routing).toEqual({ default_slot: "reasoning", auto_fallback: true, log_usage: true });
  });

  it("requires all three slots and a primary target in each", () => {
    expect(ModelsSchema.safeParse({ slots: { fast: slots.fast, reasoning: slots.reasoning } }).success).toBe(false);
    expect(ModelsSchema.safeParse(models({ fast: { fallbacks: [] } })).success).toBe(false);
  });

  it("rejects unknown providers and keys, including camelCase spellings and inline secrets", () => {
    const bad = (target: Record<string, unknown>) =>
      ModelsSchema.safeParse(models({ fast: { primary: { provider: "ollama", model: "x", ...target } } })).success;
    expect(ModelsSchema.safeParse(models({ fast: { primary: { provider: "mystery", model: "x" } } })).success).toBe(false);
    expect(bad({ apiKey: "nope" })).toBe(false);
    expect(bad({ timeoutMs: 1000 })).toBe(false);
    expect(bad({ baseURL: "http://localhost:1/v1" })).toBe(false);
  });

  it("requires base_url for openai_compatible and only accepts http(s) URLs", () => {
    const target = (t: Record<string, unknown>) => models({ fast: { primary: { provider: "openai_compatible", model: "m", ...t } } });
    expect(ModelsSchema.safeParse(target({})).success).toBe(false);
    expect(ModelsSchema.safeParse(target({ base_url: "http://127.0.0.1:20128/v1" })).success).toBe(true);
    expect(ModelsSchema.safeParse(target({ base_url: "file:///etc/passwd" })).success).toBe(false);
  });

  it("restricts env_fallback to MEDJAY_* so vendor variables can never be referenced", () => {
    const withEnv = (env_fallback: string) =>
      ModelsSchema.safeParse(models({ reasoning: { primary: { provider: "anthropic", model: "m", env_fallback } } })).success;
    expect(withEnv("MEDJAY_ANTHROPIC_API_KEY")).toBe(true);
    expect(withEnv("MEDJAY_CLIENT_A_KEY")).toBe(true);
    for (const bad of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "medjay_lower", "MEDJAY_", "MEDJAY-X", "PATH"]) {
      expect(withEnv(bad), bad).toBe(false);
    }
  });

  it("validates keychain_ref format", () => {
    const withRef = (keychain_ref: string) =>
      ModelsSchema.safeParse(models({ reasoning: { primary: { provider: "anthropic", model: "m", keychain_ref } } })).success;
    expect(withRef("anthropic_default")).toBe(true);
    expect(withRef("client-a.anthropic")).toBe(true);
    for (const bad of ["", "UPPER", "has space", "../x", "a".repeat(80)]) expect(withRef(bad), bad).toBe(false);
  });

  it("bounds timeout_ms, max_retries and temperature", () => {
    const withField = (f: Record<string, unknown>) =>
      ModelsSchema.safeParse(models({ fast: { primary: { provider: "ollama", model: "x", ...f } } })).success;
    expect(withField({ timeout_ms: 15000, max_retries: 0, temperature: 0 })).toBe(true);
    for (const f of [{ timeout_ms: 0 }, { timeout_ms: 1.5 }, { max_retries: -1 }, { max_retries: 9 }, { temperature: 3 }, { temperature: -0.1 }]) {
      expect(withField(f), JSON.stringify(f)).toBe(false);
    }
  });

  it("allows up to three fallbacks and no nested fallbacks", () => {
    const fb = (n: number) => Array.from({ length: n }, () => ({ provider: "google", model: "g" }));
    expect(ModelsSchema.safeParse(models({ fast: { primary: slots.fast.primary, fallbacks: fb(3) } })).success).toBe(true);
    expect(ModelsSchema.safeParse(models({ fast: { primary: slots.fast.primary, fallbacks: fb(4) } })).success).toBe(false);
    expect(
      ModelsSchema.safeParse(models({ fast: { primary: slots.fast.primary, fallbacks: [{ provider: "google", model: "g", fallbacks: [] }] } })).success,
    ).toBe(false);
  });

  it("requires healthcheck_path to start with a slash", () => {
    const hp = (healthcheck_path: string) =>
      ModelsSchema.safeParse(models({ fast: { primary: { provider: "ollama", model: "x", healthcheck_path } } })).success;
    expect(hp("/models")).toBe(true);
    expect(hp("models")).toBe(false);
  });
});

describe("resolveSlot", () => {
  it("returns the primary first, then fallbacks in order", () => {
    const m = parse(
      models({
        fast: {
          primary: { provider: "google", model: "gemini-3.8-flash" },
          fallbacks: [
            { provider: "anthropic", model: "claude-haiku-5-5", timeout_ms: 5000 },
            { provider: "ollama", model: "gemma4:latest" },
          ],
        },
      }),
    );
    const targets = resolveSlot(m, "fast");
    expect(targets.map((t) => `${t.provider}/${t.model}`)).toEqual([
      "google/gemini-3.8-flash",
      "anthropic/claude-haiku-5-5",
      "ollama/gemma4:latest",
    ]);
    expect(targets[1]!.timeoutMs).toBe(5000);
  });

  it("derives credential references from the provider unless overridden", () => {
    const m = parse(
      models({
        reasoning: { primary: { provider: "anthropic", model: "m", keychain_ref: "client_a", env_fallback: "MEDJAY_CLIENT_A_KEY" } },
        creative: { primary: { provider: "openai_compatible", model: "m", base_url: "http://127.0.0.1:20128/v1" } },
      }),
    );
    expect(resolveSlot(m, "reasoning")[0]).toMatchObject({ keychainRef: "client_a", envFallback: "MEDJAY_CLIENT_A_KEY" });
    expect(resolveSlot(m, "creative")[0]).toMatchObject({
      keychainRef: "openai_compatible",
      envFallback: "MEDJAY_OPENAI_COMPATIBLE_API_KEY",
    });
    expect(resolveSlot(parse(models()), "reasoning")[0]).toMatchObject({
      keychainRef: "anthropic",
      envFallback: "MEDJAY_ANTHROPIC_API_KEY",
    });
  });

  it("defaults Ollama to its local /v1 endpoint, a long timeout, no retries and no credential", () => {
    expect(resolveSlot(parse(models()), "fast")[0]).toMatchObject({
      provider: "ollama",
      baseURL: "http://localhost:11434/v1",
      local: true,
      timeoutMs: 300_000,
      maxRetries: 0,
      credentialRequired: false,
      healthcheckPath: "/models",
    });
  });

  it("gives cloud providers a short timeout, two retries and a required credential", () => {
    expect(resolveSlot(parse(models()), "reasoning")[0]).toMatchObject({
      local: false,
      timeoutMs: 60_000,
      maxRetries: 2,
      credentialRequired: true,
    });
  });

  it("treats a localhost proxy as local with an optional credential", () => {
    const m = parse(models({ creative: { primary: { provider: "openai", model: "gpt-6-luna", base_url: "http://127.0.0.1:20128/v1" } } }));
    expect(resolveSlot(m, "creative")[0]).toMatchObject({ local: true, timeoutMs: 300_000, credentialRequired: false, maxRetries: 0 });
  });

  it("honors explicit timeout, retries, temperature and health path", () => {
    const m = parse(
      models({ fast: { primary: { provider: "ollama", model: "x", timeout_ms: 20_000, max_retries: 1, temperature: 0.3, healthcheck_path: "/health" } } }),
    );
    expect(resolveSlot(m, "fast")[0]).toMatchObject({ timeoutMs: 20_000, maxRetries: 1, temperature: 0.3, healthcheckPath: "/health" });
  });
});

describe("parseModelRef", () => {
  it("parses provider/model, keeping colons and slashes in the model id", () => {
    expect(parseModelRef("anthropic/claude-sonnet-5-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(parseModelRef("ollama/gemma4:latest")).toEqual({ provider: "ollama", model: "gemma4:latest" });
    expect(parseModelRef("openai_compatible/org/model-x")).toEqual({ provider: "openai_compatible", model: "org/model-x" });
  });

  it("accepts the hyphenated spelling of openai_compatible and normalizes it", () => {
    expect(parseModelRef("openai-compatible/m")).toEqual({ provider: "openai_compatible", model: "m" });
  });

  it("rejects malformed references and unknown providers", () => {
    expect(() => parseModelRef("nomodel")).toThrow(/provider\/model/);
    expect(() => parseModelRef("/model")).toThrow(/provider\/model/);
    expect(() => parseModelRef("mystery/model")).toThrow(/provider/);
  });
});
