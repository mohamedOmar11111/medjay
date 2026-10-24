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
  it("has the built-in and draft tools by default", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["draft_diff", "draft_list", "draft_read", "draft_save", "lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    opened.close();
  });

  it("adds the growth tools when a growth port is given", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, growth: port, home: join(root, "no-home") });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["draft_diff", "draft_list", "draft_read", "draft_save", "growth_context", "growth_diagnose", "growth_scout", "growth_simulate", "lint_copy", "list_files", "propose_plan_actions", "read_file"]);
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
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["draft_diff", "draft_list", "draft_read", "draft_save", "lint_copy", "list_files", "propose_plan_actions", "read_file"]);
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

describe("openRun with a client folder in a mount", () => {
  async function setup() {
    const hq = join(root, "hq");
    for (const [rel, text] of [
      ["01_Active_Clients/etlaala/icp.md", "etlaala icp"],
      ["01_Active_Clients/aqarverse/brand.md", "aqarverse brand"],
      ["03_Global_Assets/frameworks/standards.md", "rules"],
      ["02_Client_Templates/_template/brand.md", "template"],
    ] as const) {
      await mkdir(join(hq, rel, ".."), { recursive: true });
      await writeFile(join(hq, rel), text, "utf8");
    }
    const file = join(dir, "workspace.yaml");
    const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    config.mounts = [{ name: "hq", path: hq, trust: "owner" }];
    config.client_docs = { mount: "hq", folder: "01_Active_Clients/etlaala", shared: ["03_Global_Assets"] };
    await writeFile(file, stringify(config));
    return openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
  }

  it("lets a run read only this client's folder and the shared folders of that mount", async () => {
    const opened = await setup();
    const scope = opened.deps.scope;
    expect((await scope.readText("hq:01_Active_Clients/etlaala/icp.md")).text).toBe("etlaala icp");
    expect((await scope.readText("hq:03_Global_Assets/frameworks/standards.md")).text).toBe("rules");
    await expect(scope.readText("hq:01_Active_Clients/aqarverse/brand.md")).rejects.toThrow(/not part of what this workspace may read/);
    await expect(scope.readText("hq:02_Client_Templates/_template/brand.md")).rejects.toThrow();
    opened.close();
  });
});

describe("openRun gives skills the client's files", () => {
  it("skill_load reports where icp.md, brand.md and offers.md can be read for this client", async () => {
    const hq = join(root, "hq3");
    await mkdir(join(hq, "01_Active_Clients", "etlaala"), { recursive: true });
    await writeFile(join(hq, "01_Active_Clients", "etlaala", "icp.md"), "icp", "utf8");
    await mkdir(join(dir, "skills", "planner"), { recursive: true });
    await writeFile(join(dir, "skills", "planner", "SKILL.md"), "---\nname: planner\ndescription: Plans email.\n---\nLoad first: brand.md, icp.md, offers.md and STRATEGY.md.\n");
    const file = join(dir, "workspace.yaml");
    const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    config.mounts = [{ name: "hq", path: hq, trust: "owner" }];
    config.client_docs = { mount: "hq", folder: "01_Active_Clients/etlaala", shared: [] };
    await writeFile(file, stringify(config));
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    const r = (await opened.deps.registry.invoke({ name: "skill_load", input: { name: "planner" } }, { runId: "r", step: 1, scope: opened.deps.scope })) as { ok: true; output: { client_files: { name: string; found: string | null; via: string | null }[] } };
    const by = Object.fromEntries(r.output.client_files.map((f) => [f.name, f]));
    expect(by["icp.md"]).toMatchObject({ found: "hq:01_Active_Clients/etlaala/icp.md", via: "client_folder" });
    expect(by["brand.md"]).toMatchObject({ found: "context/brand-voice.md", via: "native" });
    expect(by["offers.md"]).toMatchObject({ found: "context/offer-matrix.md", via: "native" });
    expect(by["STRATEGY.md"]).toMatchObject({ found: null });
    opened.close();
  });
});

describe("openRun with a linked plugin", () => {
  it("finds the plugin's skills through skill_search, and runs none of its hooks", async () => {
    const plug = join(root, "plug");
    await mkdir(join(plug, ".claude-plugin"), { recursive: true });
    await writeFile(join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
    await mkdir(join(plug, "skills", "audit"), { recursive: true });
    await writeFile(join(plug, "skills", "audit", "SKILL.md"), "---\nname: acme-audit\ndescription: Audit a landing page.\n---\nBody.\n");
    await mkdir(join(plug, "hooks"), { recursive: true });
    await writeFile(join(plug, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node should-never-run.js" }] }] } }));
    const file = join(dir, "workspace.yaml");
    const config = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    config.plugins = { paths: [plug] };
    await writeFile(file, stringify(config));
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, home: join(root, "no-home") });
    const found = (await opened.deps.registry.invoke({ name: "skill_search", input: { query: "audit landing page" } }, { runId: "r", step: 1, scope: opened.deps.scope })) as { ok: true; output: { matches: { name: string; source: string; trust: string }[] } };
    expect(found.output.matches[0]).toMatchObject({ name: "acme-audit", source: "plugin:acme", trust: "third_party" });
    opened.close();
  });
});
