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

describe("cardFor workspace_readiness", () => {
  const ready = (n: number, files: number) => ({ context: { ready_count: n, files: [{}, {}, {}, {}] }, data: { files_found: files }, connections: [] });
  it("says how much context and data there is, in a few words", () => {
    expect(cardFor("workspace_readiness", {}, ready(0, 0), true)).toEqual({ label: "Workspace check", summary: "0 of 4 context files ready · no data files" });
    expect(cardFor("workspace_readiness", {}, ready(2, 3), true).summary).toBe("2 of 4 context files ready · 3 data files");
    expect(cardFor("workspace_readiness", {}, ready(4, 1), true).summary).toBe("4 of 4 context files ready · 1 data file");
  });
});

describe("cardFor an expected 'no data yet' state", () => {
  it("is a plain statement, not an error", () => {
    expect(cardFor("growth_scout", {}, { status: "no_data_yet", files_found: 0 }, true)).toEqual({ label: "Truth check", summary: "no data yet" });
    expect(cardFor("growth_diagnose", {}, { status: "no_data_yet" }, true).summary).toBe("no data yet");
    expect(cardFor("growth_simulate", {}, { result: { status: "no_data_yet" } }, true).summary).toBe("no data yet");
    expect(cardFor("growth_simulate", {}, { result: { status: "ok", mode: "target_model", monte_carlo: { p_positive: 0.5 } } }, true).summary).toBe("target model, not your results · 50% chance it pays off");
    expect(cardFor("growth_simulate", {}, { result: { status: "template_not_filled", missing: [{}, {}, {}] } }, true).summary).toBe("unit economics not filled in (3 numbers)");
  });
  it("says how many files could not be read when there are some", () => {
    expect(cardFor("growth_scout", {}, { status: "no_data_yet", files_found: 2, unmatched: [{}, {}] }, true).summary).toBe("no data yet · 2 files could not be read");
  });
});

describe("cardFor the draft tools", () => {
  const SHA = "1a2b3c4d5e6f0000000000000000000000000000000000000000000000000000";
  it("save: which draft, version, short hash and the copy check as PASS or FAIL", () => {
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 2, sha256: SHA, check: { status: "pass" } }, true)).toEqual({ label: "Draft saved", summary: "email/umrah v2 · sha 1a2b3c4d · copy check: PASS" });
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 3, sha256: SHA, check: { status: "fail", errors: 2 } }, true).summary).toBe("email/umrah v3 · sha 1a2b3c4d · copy check: FAIL (2 errors)");
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 1, sha256: SHA, check: { status: "not_checked" } }, true).summary).toBe("email/umrah v1 · sha 1a2b3c4d · copy check: not checked");
  });
  it("save: no hash in the output leaves it out and never prints a long value", () => {
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 2, check: { status: "pass" } }, true).summary).toBe("email/umrah v2 · copy check: PASS");
    expect(cardFor("draft_save", {}, { workflow: "email", slug: "umrah", version: 2, sha256: "not a hash <script>", check: { status: "pass" } }, true).summary).toBe("email/umrah v2 · copy check: PASS");
  });
  it("read shows the short hash and flags a draft changed outside Medjay", () => {
    expect(cardFor("draft_read", {}, { workflow: "email", slug: "umrah", version: 2, sha256: SHA, intact: true }, true)).toEqual({ label: "Draft read", summary: "email/umrah v2 · sha 1a2b3c4d" });
    expect(cardFor("draft_read", {}, { workflow: "email", slug: "umrah", version: 2, intact: false }, true).summary).toBe("email/umrah v2 · changed outside Medjay");
  });
  it("list and diff", () => {
    expect(cardFor("draft_list", {}, { drafts: [{}, {}] }, true)).toEqual({ label: "Drafts", summary: "2 drafts" });
    expect(cardFor("draft_diff", {}, { workflow: "email", slug: "umrah", from: 1, to: 2, added: 3, removed: 1 }, true)).toEqual({ label: "Draft changes", summary: "email/umrah v1 to v2 · +3 -1 lines" });
    expect(cardFor("draft_diff", {}, { workflow: "email", slug: "umrah", from: 1, to: 2, added: 3, removed: 1, from_sha256: SHA, to_sha256: "ffeeddcc".padEnd(64, "0") }, true).summary).toBe("email/umrah v1 (1a2b3c4d) to v2 (ffeeddcc) · +3 -1 lines");
  });
  it("skill_load shows the skill's short hash when the tool reports one", () => {
    expect(cardFor("skill_load", {}, { name: "email-sequence", source: "workspace", trust: "owned", sha256: SHA }, true).summary).toBe("email-sequence (workspace, yours) · sha 1a2b3c4d");
    expect(cardFor("skill_load", {}, { name: "email-sequence", source: "workspace", trust: "owned" }, true).summary).toBe("email-sequence (workspace, yours)");
  });
});
