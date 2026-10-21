// Skills written for other tools name those tools (Read, Write, Bash...). Medjay does not rewrite the
// skill: it translates what a skill DECLARES, and gives the model a short dictionary for the names the
// text mentions. The registry (class, policy, scope) stays the only thing that decides what runs.

export interface MappedTool {
  from: string;
  to: string;
  class: "read" | "draft";
}
export interface UnavailableTool {
  from: string;
  to: string;
  reason: string;
}
export interface ToolTranslation {
  mapped: MappedTool[];
  /** Mapped to a Medjay tool that is not built yet. */
  unavailable: UnavailableTool[];
  /** Never mapped: running shell commands is not something a skill can ask for. */
  stripped: string[];
  unknown: string[];
}

interface Entry {
  to: string;
  class: "read" | "draft";
  reason: string;
}
const TABLE: Record<string, Entry> = {
  Read: { to: "read_file", class: "read", reason: "" },
  Glob: { to: "list_files", class: "read", reason: "" },
  Grep: { to: "search_files", class: "read", reason: "workspace text search is not built yet" },
  WebFetch: { to: "web_fetch", class: "read", reason: "web tools are not built yet" },
  WebSearch: { to: "web_search", class: "read", reason: "web tools are not built yet" },
  Write: { to: "draft_save", class: "draft", reason: "the drafts store is not built yet" },
  Edit: { to: "draft_edit", class: "draft", reason: "the drafts store is not built yet" },
};
/** Medjay tools that exist today. Update when search_files, the drafts tools and the web tools land. */
const AVAILABLE = new Set(["read_file", "list_files"]);
const SHELL = new Set(["Bash", "Shell", "PowerShell", "Terminal"]);

export function declaredTools(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter["allowed-tools"] ?? frontmatter.allowed_tools ?? frontmatter.tools;
  const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw.map(String) : [];
  return list.map((t) => t.trim().replace(/\(.*$/, "").trim()).filter((t) => t !== "");
}

export function translateTools(declared: readonly string[]): ToolTranslation {
  const out: ToolTranslation = { mapped: [], unavailable: [], stripped: [], unknown: [] };
  for (const name of declared) {
    if (SHELL.has(name)) out.stripped.push(name);
    else if (name.startsWith("mcp__")) out.unavailable.push({ from: name, to: name, reason: "MCP tools arrive with the MCP client; write tools will stay behind a plan" });
    else {
      const entry = TABLE[name];
      if (!entry) out.unknown.push(name);
      else if (AVAILABLE.has(entry.to)) out.mapped.push({ from: name, to: entry.to, class: entry.class });
      else out.unavailable.push({ from: name, to: entry.to, reason: entry.reason });
    }
  }
  return out;
}

/** One short paragraph for the names the text actually uses; empty when it uses none. */
export function toolDictionary(text: string): string {
  const lines: string[] = [];
  for (const name of [...Object.keys(TABLE), ...SHELL]) {
    if (!new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)) continue;
    if (SHELL.has(name)) lines.push(`"${name}": shell commands are not available in Medjay; use the growth_* tools for analysis`);
    else {
      const entry = TABLE[name] as Entry;
      lines.push(AVAILABLE.has(entry.to) ? `"${name}" = ${entry.to}` : `"${name}" (${entry.to}) is not available yet: ${entry.reason}`);
    }
  }
  return lines.length === 0 ? "" : `Tool names in this skill, in Medjay terms: ${lines.join("; ")}.`;
}
