import { describe, expect, it } from "vitest";
import { cardFor } from "./cards.js";

describe("cardFor", () => {
  it("describes a file read by its path and size", () => {
    const c = cardFor("read_file", { path: "data/imports/Searches.csv" }, { path: "data/imports/Searches.csv", bytes: 2048, truncated: false }, true);
    expect(c).toEqual({ label: "Read file", summary: "data/imports/Searches.csv · 2 KB" });
  });
  it("says when a file was cut short", () => {
    expect(cardFor("read_file", { path: "a.csv" }, { path: "a.csv", bytes: 5000, truncated: true }, true).summary).toContain("truncated");
  });
  it("counts listed files", () => {
    expect(cardFor("list_files", { dir: "data/imports" }, { dir: "data/imports", entries: ["a", "b", "c"] }, true)).toEqual({ label: "List files", summary: "data/imports · 3 entries" });
    expect(cardFor("list_files", {}, { dir: "", entries: [] }, true).summary).toBe("workspace · 0 entries");
  });
  it("reports a copy check as pass or the number of problems", () => {
    expect(cardFor("lint_copy", {}, { pass: true, counts: { error: 0, warn: 0 } }, true)).toEqual({ label: "Copy check", summary: "passes" });
    expect(cardFor("lint_copy", {}, { pass: false, counts: { error: 2, warn: 1 } }, true).summary).toBe("2 errors, 1 warning");
  });
  it("counts proposals and shows what the policy said", () => {
    const out = { proposals: [{}, {}], policy: { status: "pass" } };
    expect(cardFor("propose_plan_actions", {}, out, true)).toEqual({ label: "Proposed changes", summary: "2 proposals · policy check: pass" });
  });
  it("explains a failed call in one short line", () => {
    expect(cardFor("read_file", { path: "x" }, undefined, false, "scope")).toEqual({ label: "Read file", summary: "failed (scope)" });
  });
  it("gives an unknown tool a generic card", () => {
    expect(cardFor("growth_scout", {}, {}, true)).toEqual({ label: "growth_scout", summary: "done" });
  });
});
