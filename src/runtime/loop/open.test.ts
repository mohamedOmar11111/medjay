import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../../workspace/init.js";
import type { GrowthPort } from "../tools/growth.js";
import { NO_MODEL, openRun } from "./open.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-open-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const port: GrowthPort = {
  dataId: async () => "x",
  scout: async () => ({}),
  diagnose: async () => ({}),
  context: async () => ({}),
  simulate: async () => ({}),
};

describe("openRun tool set", () => {
  it("has the four built-in tools by default", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    opened.close();
  });

  it("adds the growth tools when a growth port is given", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, growth: port, home: join(root, "no-home") });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["growth_context", "growth_diagnose", "growth_scout", "growth_simulate", "lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    opened.close();
  });
});

describe("openRun with skills", () => {
  it("registers skill_search and skill_load when the workspace or a linked root has skills", async () => {
    await mkdir(join(dir, "skills", "brief"), { recursive: true });
    await writeFile(join(dir, "skills", "brief", "SKILL.md"), "---\nname: brief-writer\ndescription: Writes a content brief.\n---\nBody.\n");
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    const names = opened.deps.registry.specs().map((s) => s.name);
    expect(names).toContain("skill_search");
    expect(names).toContain("skill_load");
    opened.close();
  });

  it("registers nothing extra when there are no skills anywhere", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    opened.close();
  });

  it("reads a linked root from workspace.yaml", async () => {
    const hq = join(root, "hq");
    await mkdir(join(hq, "m09"), { recursive: true });
    await writeFile(join(hq, "m09", "SKILL.md"), "---\nname: gd-m09\ndescription: Email sequences.\n---\nBody.\n");
    const file = join(dir, "workspace.yaml");
    const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    config.skills = { paths: [{ path: hq, trust: "owner", name: "hq" }] };
    await writeFile(file, stringify(config));
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    expect(opened.deps.registry.specs().map((s) => s.name)).toContain("skill_load");
    opened.close();
  });
});

describe("openRun with mounts", () => {
  it("lets a run read a mounted folder as name:path, and treats an owner mount as trusted", async () => {
    const hq = join(root, "hq");
    await mkdir(join(hq, "03_Global_Assets"), { recursive: true });
    await writeFile(join(hq, "03_Global_Assets", "standards.md"), "evidence rules", "utf8");
    const file = join(dir, "workspace.yaml");
    const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    config.mounts = [{ name: "hq", path: hq, trust: "owner" }];
    await writeFile(file, stringify(config));
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    expect((await opened.deps.scope.readText("hq:03_Global_Assets/standards.md")).text).toBe("evidence rules");
    const out = await opened.deps.registry.invoke({ name: "read_file", input: { path: "hq:03_Global_Assets/standards.md" } }, { runId: "r", step: 1, scope: opened.deps.scope });
    expect(out).toMatchObject({ ok: true, trust: "trusted" });
    opened.close();
  });
});
