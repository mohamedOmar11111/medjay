import { describe, expect, it } from "vitest";
import { declaredTools, toolDictionary, translateTools } from "./tools.js";

describe("declaredTools", () => {
  it("reads a comma string, a list, and the usual key spellings, dropping argument patterns", () => {
    expect(declaredTools({ "allowed-tools": "Read, Grep, Bash(git:*)" })).toEqual(["Read", "Grep", "Bash"]);
    expect(declaredTools({ allowed_tools: ["Read", "Write"] })).toEqual(["Read", "Write"]);
    expect(declaredTools({ tools: "Glob" })).toEqual(["Glob"]);
    expect(declaredTools({})).toEqual([]);
  });
});

describe("translateTools", () => {
  it("maps Read and Glob to tools that exist, and says which are not available yet", () => {
    const t = translateTools(["Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "WebSearch"]);
    expect(t.mapped).toEqual([
      { from: "Read", to: "read_file", class: "read" },
      { from: "Glob", to: "list_files", class: "read" },
    ]);
    expect(t.unavailable.map((u) => `${u.from}->${u.to}`)).toEqual(["Grep->search_files", "Write->draft_save", "Edit->draft_edit", "WebFetch->web_fetch", "WebSearch->web_search"]);
  });
  it("never maps a shell: it is stripped", () => {
    const t = translateTools(["Bash", "Shell", "PowerShell"]);
    expect(t.mapped).toEqual([]);
    expect(t.stripped).toEqual(["Bash", "Shell", "PowerShell"]);
  });
  it("treats MCP tools as not available yet and lists anything it does not know", () => {
    const t = translateTools(["mcp__meta__get_campaigns", "Teleport"]);
    expect(t.unavailable.map((u) => u.from)).toEqual(["mcp__meta__get_campaigns"]);
    expect(t.unknown).toEqual(["Teleport"]);
  });
});

describe("toolDictionary", () => {
  it("explains only the tool names the skill text actually uses", () => {
    const d = toolDictionary("Use Read to open the brief, then Write the result. Run Bash scripts.");
    expect(d).toContain('"Read" = read_file');
    expect(d).toMatch(/"Write".*not available yet/);
    expect(d).toMatch(/shell|Bash/i);
    expect(d).not.toContain("WebFetch");
  });
  it("is empty when the skill names no tools", () => {
    expect(toolDictionary("Build a sequence. Load the brand file first.")).toBe("");
  });
  it("does not trigger on ordinary words that merely contain a tool name", () => {
    expect(toolDictionary("The reader will edit the thread, and bash out ideas.")).toBe("");
  });
});
