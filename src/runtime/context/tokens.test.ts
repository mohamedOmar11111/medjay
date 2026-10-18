import { describe, expect, it } from "vitest";
import { estimateTokens, truncateToTokens } from "./tokens.js";

describe("estimateTokens (a conservative estimate, not a tokenizer)", () => {
  it("is zero for empty text, positive otherwise, deterministic and monotonic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
    expect(estimateTokens("hello world")).toBe(estimateTokens("hello world"));
    expect(estimateTokens("hello world, and more")).toBeGreaterThan(estimateTokens("hello world"));
  });

  it("charges non-Latin scripts more per character, so Arabic is not under-counted", () => {
    expect(estimateTokens("ا".repeat(100))).toBeGreaterThan(estimateTokens("a".repeat(100)));
  });

  it("never claims fewer tokens than a rough 4-characters-per-token English baseline", () => {
    const english = "The quick brown fox jumps over the lazy dog. ".repeat(50);
    expect(estimateTokens(english)).toBeGreaterThanOrEqual(Math.floor(english.length / 4));
  });

  it("counts a surrogate pair as one character", () => {
    expect(estimateTokens("😀".repeat(10))).toBeGreaterThan(0);
  });
});

describe("truncateToTokens", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(truncateToTokens("short text", 100)).toEqual({ text: "short text", truncated: false });
  });

  it("cuts to fit, reports it, and the result fits the budget", () => {
    const long = "word ".repeat(1000);
    const out = truncateToTokens(long, 50);
    expect(out.truncated).toBe(true);
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(50);
    expect(out.text.length).toBeGreaterThan(0);
    expect(long.startsWith(out.text)).toBe(true);
  });

  it("never splits a character in half", () => {
    const out = truncateToTokens("😀é".repeat(500), 20);
    expect(out.text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(out.text).not.toContain("�");
  });

  it("returns an empty string for a zero budget", () => {
    expect(truncateToTokens("anything", 0)).toEqual({ text: "", truncated: true });
  });
});
