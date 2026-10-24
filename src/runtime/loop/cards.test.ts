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

describe("cardFor the skill tools", () => {
  it("search: how many matches and the best names", () => {
    const out = { matches: [{ name: "gd-m09-email-lifecycle-planner" }, { name: "emails" }, { name: "cold-email" }], searched: 145 };
    expect(cardFor("skill_search", { query: "email sequence" }, out, true)).toEqual({ label: "Skill search", summary: "3 matches: gd-m09-email-lifecycle-planner, emails, cold-email" });
    expect(cardFor("skill_search", {}, { matches: [], searched: 145 }, true).summary).toBe("no match among 145");
  });
  it("load: which skill and whose it is", () => {
    expect(cardFor("skill_load", {}, { name: "gd-m09-email-lifecycle-planner", source: "hq", trust: "owned" }, true)).toEqual({ label: "Skill", summary: "gd-m09-email-lifecycle-planner (hq, yours)" });
    expect(cardFor("skill_load", {}, { name: "x", source: "market", trust: "third_party" }, true).summary).toBe("x (market, from another author)");
  });
});

describe("cardFor the draft tools", () => {
  it("save: which draft, which version, and the copy check", () => {
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 2, check: { status: "pass" } }, true)).toEqual({ label: "Draft saved", summary: "email/umrah v2 · copy check: pass" });
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 3, check: { status: "fail", errors: 2 } }, true).summary).toBe("email/umrah v3 · copy check: fail (2 errors)");
  });
  it("read, list and diff", () => {
    expect(cardFor("draft_read", {}, { workflow: "email", slug: "umrah", version: 2, intact: true }, true)).toEqual({ label: "Draft read", summary: "email/umrah v2" });
    expect(cardFor("draft_read", {}, { workflow: "email", slug: "umrah", version: 2, intact: false }, true).summary).toBe("email/umrah v2 · changed outside Medjay");
    expect(cardFor("draft_list", {}, { drafts: [{}, {}] }, true)).toEqual({ label: "Drafts", summary: "2 drafts" });
    expect(cardFor("draft_diff", {}, { workflow: "email", slug: "umrah", from: 1, to: 2, added: 3, removed: 1 }, true)).toEqual({ label: "Draft changes", summary: "email/umrah v1 to v2 · +3 -1 lines" });
  });
});
