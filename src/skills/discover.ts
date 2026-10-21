// Finds SKILL.md folders in a priority-ordered list of roots, without copying anything. Only the
// SKILL.md of each folder is read, under a size cap. The first root to define a name wins; the rest are
// reported as collisions so a person can see what is hidden.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseSkill } from "./parse.js";
import { declaredTools, toolDictionary, translateTools, type ToolTranslation } from "./tools.js";

export type SkillTrust = "owned" | "third_party";

export interface SkillRoot {
  path: string;
  label: string;
  trust: SkillTrust;
}

export interface SkillEntry {
  name: string;
  description: string;
  /** Label of the root it came from. */
  root: string;
  trust: SkillTrust;
  dir: string;
  file: string;
  bytes: number;
  frontmatter: Record<string, unknown>;
  translation: ToolTranslation;
  problems: string[];
}

export interface Discovery {
  skills: SkillEntry[];
  collisions: { name: string; kept: string; hidden: string[] }[];
  problems: { file: string; message: string }[];
}

export const DEFAULT_MAX_SKILL_BYTES = 60_000;

export async function discoverSkills(roots: readonly SkillRoot[], options: { maxBytes?: number } = {}): Promise<Discovery> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  const found = new Map<string, SkillEntry>();
  const hidden = new Map<string, string[]>();
  const problems: Discovery["problems"] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = (await readdir(root.path)).sort();
    } catch {
      continue; // a root that is not there is not an error: workspaces differ
    }
    for (const folder of names) {
      const dir = join(root.path, folder);
      const file = join(dir, "SKILL.md");
      let size: number;
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        size = (await stat(file)).size;
      } catch {
        continue; // not a skill folder
      }
      if (size > maxBytes) {
        problems.push({ file, message: `larger than ${maxBytes} bytes; not loaded` });
        continue;
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        problems.push({ file, message: `cannot be read: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const parsed = parseSkill(text, folder);
      const entry: SkillEntry = {
        name: parsed.name,
        description: parsed.description,
        root: root.label,
        trust: root.trust,
        dir,
        file,
        bytes: size,
        frontmatter: parsed.frontmatter,
        translation: translateTools(declaredTools(parsed.frontmatter)),
        problems: parsed.problems,
      };
      const key = entry.name.toLowerCase();
      if (found.has(key)) hidden.set(key, [...(hidden.get(key) ?? []), root.label]);
      else found.set(key, entry);
    }
  }
  const skills = [...found.values()];
  const collisions = [...hidden].map(([key, labels]) => ({ name: (found.get(key) as SkillEntry).name, kept: (found.get(key) as SkillEntry).root, hidden: labels }));
  return { skills, collisions, problems };
}

/** The body of a discovered skill, read fresh, with the dictionary for the tool names it uses. */
export async function loadSkillBody(entry: SkillEntry): Promise<{ body: string; dictionary: string }> {
  const parsed = parseSkill(await readFile(entry.file, "utf8"), entry.name);
  return { body: parsed.body, dictionary: toolDictionary(parsed.body) };
}

interface RootConfig {
  skills: { paths: { path: string; trust: "owner" | "untrusted"; name?: string | undefined }[]; include_claude_global: boolean };
}

const expandHome = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? join(home, path.slice(2)) : path);

/** Workspace folders, the user's own folder, then the roots the owner linked; ~/.claude only on request. */
export function defaultRoots(config: RootConfig, base: { workspaceDir: string; home: string }): SkillRoot[] {
  const roots: SkillRoot[] = [
    { path: join(base.workspaceDir, "skills"), label: "workspace", trust: "owned" },
    { path: join(base.workspaceDir, ".claude", "skills"), label: "workspace-claude", trust: "owned" },
    { path: join(base.workspaceDir, ".agents", "skills"), label: "workspace-agents", trust: "owned" },
    { path: join(base.home, ".medjay", "skills"), label: "user", trust: "owned" },
  ];
  for (const linked of config.skills.paths) {
    const path = resolve(expandHome(linked.path, base.home));
    roots.push({ path, label: linked.name ?? (basename(path) || "linked"), trust: linked.trust === "owner" ? "owned" : "third_party" });
  }
  if (config.skills.include_claude_global) roots.push({ path: join(base.home, ".claude", "skills"), label: "claude-global", trust: "third_party" });
  return roots;
}
