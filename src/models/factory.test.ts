import { afterEach, describe, expect, it, vi } from "vitest";
import { createLanguageModel } from "./factory.js";
import type { ResolvedTarget } from "./slots.js";

const target = (provider: ResolvedTarget["provider"], model: string, baseURL?: string) => ({ provider, model, baseURL }) as ResolvedTarget;
const baseOf = (m: unknown) => (m as { config: { baseURL: string } }).config.baseURL;

afterEach(() => vi.unstubAllEnvs());

describe("createLanguageModel", () => {
  it("ignores *_BASE_URL environment variables, so a stray one cannot redirect an API key", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://evil.example/v1");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example/v1");
    expect(baseOf(createLanguageModel(target("openai", "gpt-5.4-mini"), "k"))).toBe("https://api.openai.com/v1");
    expect(baseOf(createLanguageModel(target("anthropic", "claude-sonnet-5-5"), "k"))).toBe("https://api.anthropic.com/v1");
  });
  it("still honours a base_url written in workspace.yaml", () => {
    expect(baseOf(createLanguageModel(target("openai", "gpt-5.4-mini", "https://proxy.example/v1"), "k"))).toBe("https://proxy.example/v1");
  });
});
