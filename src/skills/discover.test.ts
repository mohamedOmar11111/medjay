import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRoots, discoverSkills, loadSkillBody, type SkillRoot } from "./discover.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-skills-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skill(dir: string, folder: string, name: string, description = "Does a thing.", extra = ""): Promise<string> {
  const path = join(dir, folder);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`);
  return path;
}

const owned = (path: string, label: string): SkillRoot => ({ path, label, trust: "owned" });

describe("discoverSkills", () => {
  it("finds skill folders, ignores folders without SKILL.md and a missing root", async () => {
    const hq = join(root, "hq");
    await skill(hq, "gd-m09", "gd-m09-email-lifecycle-planner");
    await skill(hq, "gd-e05", "gd-e05-content-brief-writer");
    await mkdir(join(hq, "not-a-skill"), { recursive: true });
    await writeFile(join(hq, "README.md"), "x");
    const d = await discoverSkills([owned(hq, "hq"), owned(join(root, "missing"), "gone")]);
    expect(d.skills.map((s) => s.name).sort()).toEqual(["gd-e05-content-brief-writer", "gd-m09-email-lifecycle-planner"]);
    expect(d.skills[0]).toMatchObject({ root: "hq", trust: "owned" });
    expect(d.problems).toEqual([]);
  });

  it("the first root wins a name and the hidden copies are listed as collisions", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await skill(a, "x", "shared-name", "From A.");
    await skill(b, "y", "shared-name", "From B.");
    const d = await discoverSkills([owned(a, "workspace"), owned(b, "hq")]);
    expect(d.skills).toHaveLength(1);
    expect(d.skills[0]).toMatchObject({ description: "From A.", root: "workspace" });
    expect(d.collisions).toEqual([{ name: "shared-name", kept: "workspace", hidden: ["hq"] }]);
  });

  it("follows a linked skill folder (the owner's HQ links plugin skills in)", async () => {
    const real = await skill(join(root, "plugins"), "cro", "cro");
    const hq = join(root, "hq");
    await mkdir(hq, { recursive: true });
    try {
      await symlink(real, join(hq, "cro@"), "junction");
    } catch {
      return; // this machine does not allow links; nothing to check
    }
    const d = await discoverSkills([owned(hq, "hq")]);
    expect(d.skills.map((s) => s.name)).toEqual(["cro"]);
  });

  it("reports a skill that is too large or unreadable instead of loading it", async () => {
    const dir = join(root, "r");
    await skill(dir, "big", "big-skill", "ok", "");
    await writeFile(join(dir, "big", "SKILL.md"), `---\nname: big-skill\ndescription: ok\n---\n${"x".repeat(2000)}`);
    const d = await discoverSkills([owned(dir, "r")], { maxBytes: 1000 });
    expect(d.skills).toEqual([]);
    expect(d.problems[0]).toMatchObject({ file: expect.stringContaining("big") });
    expect(d.problems[0]!.message).toMatch(/larger than/);
  });

  it("records what a skill declares: translated tools, stripped shell, and parse problems", async () => {
    const dir = join(root, "r");
    await skill(dir, "a", "writer", "Writes.", "allowed-tools: Read, Write, Bash\n");
    const d = await discoverSkills([owned(dir, "r")]);
    const s = d.skills[0]!;
    expect(s.translation.mapped.map((m) => m.to)).toEqual(["read_file"]);
    expect(s.translation.stripped).toEqual(["Bash"]);
    expect(s.translation.unavailable.map((u) => u.to)).toEqual(["draft_save"]);
    expect(s.bytes).toBeGreaterThan(20);
  });
});

describe("loadSkillBody", () => {
  it("returns the body of a discovered skill, and the dictionary for the tool names it uses", async () => {
    const dir = join(root, "r");
    await skill(dir, "a", "reader", "Reads.");
    await writeFile(join(dir, "a", "SKILL.md"), "---\nname: reader\ndescription: Reads.\n---\nUse Read on the brief, then Write the draft.\n");
    const d = await discoverSkills([owned(dir, "r")]);
    const loaded = await loadSkillBody(d.skills[0]!);
    expect(loaded.body).toContain("Use Read on the brief");
    expect(loaded.dictionary).toContain('"Read" = read_file');
  });
});

describe("defaultRoots", () => {
  it("lists workspace, user and linked roots in priority order, and opts in to ~/.claude only when asked", () => {
    const base = { workspaceDir: join(root, "ws"), home: join(root, "home") };
    const config = { skills: { paths: [{ path: "~/hq-skills", trust: "owner" as const, name: "hq" }, { path: join(root, "other"), trust: "untrusted" as const }], include_claude_global: false } };
    const roots = defaultRoots(config, base);
    expect(roots.map((r) => r.label)).toEqual(["workspace", "workspace-claude", "workspace-agents", "user", "hq", "other"]);
    expect(roots.find((r) => r.label === "hq")).toMatchObject({ trust: "owned", path: join(root, "home", "hq-skills") });
    expect(roots.find((r) => r.label === "other")).toMatchObject({ trust: "third_party" });
    const withGlobal = defaultRoots({ skills: { ...config.skills, include_claude_global: true } }, base);
    expect(withGlobal[withGlobal.length - 1]).toMatchObject({ label: "claude-global", trust: "third_party" });
  });
});
