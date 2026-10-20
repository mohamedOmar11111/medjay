import { describe, expect, it } from "vitest";
import { classifyModelFailure } from "./model-errors.js";

const kind = (t: string) => classifyModelFailure(t)?.kind;

describe("classifyModelFailure", () => {
  it("tells a missing key from a rejected key", () => {
    expect(kind('auth: all model targets failed: anthropic/x (auth: no API key for anthropic: store one with "mdj auth set anthropic")')).toBe("no_key");
    expect(kind("auth: all model targets failed: openai/gpt-5.4-mini (auth: Invalid API key)")).toBe("key_rejected");
  });
  it("recognises a malformed stored key before calling it a network problem", () => {
    expect(kind("connection: all model targets failed: anthropic/c (connection: Failed after 3 attempts. Last error: AI_APICallError: Cannot connect to API: invalid x-api-key header)")).toBe("key_malformed");
  });
  it("reads a spend cap with its reset date", () => {
    const f = classifyModelFailure("failed: You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.");
    expect(f?.kind).toBe("quota");
    expect(f?.detail).toContain("2026-11-01");
  });
  it("recognises network and unknown-model failures and names the provider", () => {
    expect(kind("connection: all model targets failed: google/g (connection: Cannot connect to API: fetch failed)")).toBe("network");
    const f = classifyModelFailure("all model targets failed: openai/gpt-9 (other: The model gpt-9 does not exist)");
    expect(f).toMatchObject({ kind: "model_not_found", provider: "openai" });
  });
  it("returns null for ordinary output", () => {
    expect(classifyModelFailure("Cut the broad Reels ad set first.")).toBeNull();
  });
});
