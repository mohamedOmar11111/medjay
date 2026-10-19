import { describe, expect, it } from "vitest";
import { lastWindow, wrapText } from "./text.js";
import { COMPACT_BANNER, WORDMARK } from "./splash.js";

describe("wrapText", () => {
  it("breaks long lines at spaces and keeps blank lines", () => {
    expect(wrapText("alpha beta gamma\n\ndelta", 11)).toEqual(["alpha beta", "gamma", "", "delta"]);
  });
  it("hard-breaks a word longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("keeps leading indentation of table rows and never returns a line wider than the width", () => {
    const lines = wrapText("  | a | b | c | d |", 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines[0]!.startsWith("  |")).toBe(true);
  });
  it("tolerates a width below 1", () => {
    expect(wrapText("ab", 0)).toEqual(["a", "b"]);
  });
});

describe("lastWindow", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
  it("shows the newest lines by default", () => {
    expect(lastWindow(lines, 3, 0)).toEqual({ lines: ["l7", "l8", "l9"], offset: 0, more: 7 });
  });
  it("scrolls back by an offset and clamps at the top", () => {
    expect(lastWindow(lines, 3, 2).lines).toEqual(["l5", "l6", "l7"]);
    expect(lastWindow(lines, 3, 99)).toEqual({ lines: ["l0", "l1", "l2"], offset: 7, more: 0 });
  });
  it("returns everything when it fits", () => {
    expect(lastWindow(lines, 20, 0)).toEqual({ lines, offset: 0, more: 0 });
  });
});

describe("splash", () => {
  it("is five rows of equal width", () => {
    expect(WORDMARK).toHaveLength(5);
    expect(new Set(WORDMARK.map((r) => r.length)).size).toBe(1);
  });
  it("has a one-line banner", () => {
    expect(COMPACT_BANNER).toMatch(/MEDJAY/);
  });
});
