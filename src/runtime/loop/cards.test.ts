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
    expect(cardFor("some_new_tool", {}, {}, true)).toEqual({ label: "some_new_tool", summary: "done" });
  });
});

describe("cardFor the growth tools", () => {
  it("scout: spend and campaigns for a period summary, spend and leads for a daily snapshot, or no data", () => {
    const summary = { currency: "SAR", totals: { spend: 33304.31 }, campaigns: [{}, {}, {}], period: { start: "2026-09-01", end: "2026-09-30" } };
    expect(cardFor("growth_scout", {}, { snapshot: { status: "no_data" }, summary }, true)).toEqual({ label: "Truth check", summary: "SAR 33,304 · 3 campaigns · 1 Sep – 30 Sep" });
    const snapshot = { status: "ok", currency: "SAR", totals: { spend: 26880, leads: 120 }, period: { start: "2026-10-10", end: "2026-10-16" } };
    expect(cardFor("growth_scout", {}, { snapshot, summary: null }, true).summary).toBe("SAR 26,880 · 120 leads · 10 Oct – 16 Oct");
    expect(cardFor("growth_scout", {}, { snapshot: { status: "no_data" }, summary: null }, true).summary).toBe("no ad data found");
  });
  it("diagnose: how many findings", () => {
    expect(cardFor("growth_diagnose", {}, { findings: [{}, {}] }, true)).toEqual({ label: "Diagnosis", summary: "2 findings" });
    expect(cardFor("growth_diagnose", {}, { findings: [], summary: { zero_conversion_total: { terms: 87, spend: 3843 }, currency: "SAR" } }, true).summary).toBe("87 search terms never converted");
  });
  it("context and simulate", () => {
    expect(cardFor("growth_context", {}, { tactics: [{}, {}, {}] }, true)).toEqual({ label: "Your context", summary: "economics, claims, offers · 3 tactics" });
    expect(cardFor("growth_simulate", {}, { result: { status: "ok", monte_carlo: { p_positive: 0.742 } } }, true)).toEqual({ label: "Simulation", summary: "74% chance it pays off" });
    expect(cardFor("growth_simulate", {}, { result: { status: "insufficient_inputs", problems: [{}, {}] } }, true).summary).toBe("missing 2 numbers");
  });
  it("a refused call says why in a few words", () => {
    expect(cardFor("growth_diagnose", {}, undefined, false, "failed")).toEqual({ label: "Diagnosis", summary: "failed (failed)" });
  });
});
