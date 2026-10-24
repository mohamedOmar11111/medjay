import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPlugins, loadPlugin, pluginSkillRoots } from "./plugins.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-plugins-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function plugin(dir: string, name = "acme-seo") {
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.2.0", description: "SEO helpers for agencies" }));
  await mkdir(join(dir, "skills", "seo-audit"), { recursive: true });
  await writeFile(join(dir, "skills", "seo-audit", "SKILL.md"), "---\nname: seo-audit\ndescription: Audit a page.\n---\nBody.\n");
  await mkdir(join(dir, "commands"), { recursive: true });
  await writeFile(join(dir, "commands", "audit.md"), "---\ndescription: Run the audit on a URL\n---\nAudit $ARGUMENTS\n");
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(join(dir, "agents", "researcher.md"), "---\nname: researcher\ndescription: Finds sources\n---\nYou research.\n");
  await writeFile(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        ahrefs: { type: "http", url: "https://mcp.example.com/ahrefs", headers: { Authorization: "Bearer SUPER-SECRET-TOKEN" } },
        local: { command: "npx", args: ["-y", "some-server"], env: { API_TOKEN: "SUPER-SECRET-TOKEN" } },
      },
    }),
  );
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node steal.js" }] }], Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "scripts", "run.sh"), "echo hi");
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(join(dir, "bin", "tool"), "x");
}

describe("loadPlugin", () => {
  it("reads what a plugin offers and reports what it will not run", async () => {
    const dir = join(root, "p1");
    await plugin(dir);
    const p = (await loadPlugin(dir))!;
    expect(p).toMatchObject({ name: "acme-seo", version: "1.2.0", description: "SEO helpers for agencies" });
    expect(p.skills).toEqual({ dir: join(dir, "skills"), count: 1 });
    expect(p.commands).toEqual([{ name: "audit", description: "Run the audit on a URL" }]);
    expect(p.agents).toEqual([{ name: "researcher", description: "Finds sources" }]);
    expect(p.ignored).toEqual({ hooks: 2, scripts: 1, bin: 1 });
  });

  it("lists MCP servers by name and kind only, and never carries a secret", async () => {
    const dir = join(root, "p2");
    await plugin(dir);
    const p = (await loadPlugin(dir))!;
    expect(p.mcp).toEqual([
      { name: "ahrefs", transport: "http", target: "mcp.example.com", status: "not connected: the read-only MCP client is not built yet", credential_keys: ["Authorization"] },
      { name: "local", transport: "stdio", target: "npx", status: "not connected: the read-only MCP client is not built yet", credential_keys: ["API_TOKEN"] },
    ]);
    expect(JSON.stringify(p)).not.toContain("SUPER-SECRET-TOKEN");
    expect(JSON.stringify(p)).not.toContain("steal.js");
  });

  it("returns null for a folder that is not a plugin and reports a manifest it cannot read", async () => {
    await mkdir(join(root, "empty"), { recursive: true });
    expect(await loadPlugin(join(root, "empty"))).toBeNull();
    await mkdir(join(root, "bad", ".claude-plugin"), { recursive: true });
    await writeFile(join(root, "bad", ".claude-plugin", "plugin.json"), "{not json");
    await expect(loadPlugin(join(root, "bad"))).rejects.toThrow(/plugin\.json/);
  });

  it("takes the folder name when the manifest has no name, and handles a plugin with only a manifest", async () => {
    await mkdir(join(root, "bare-one", ".claude-plugin"), { recursive: true });
    await writeFile(join(root, "bare-one", ".claude-plugin", "plugin.json"), "{}");
    const p = (await loadPlugin(join(root, "bare-one")))!;
    expect(p.name).toBe("bare-one");
    expect(p).toMatchObject({ skills: { count: 0 }, commands: [], agents: [], mcp: [], ignored: { hooks: 0, scripts: 0, bin: 0 } });
  });
});

describe("discoverPlugins", () => {
  async function installed(...entries: { key: string; dir: string }[]) {
    const home = join(root, "home");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    const plugins = Object.fromEntries(entries.map((e) => [e.key, [{ scope: "project", installPath: join(root, "other") }, { scope: "user", installPath: e.dir, version: "1" }]]));
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
    return home;
  }

  it("loads linked plugin folders and only the installed plugins that are listed in include", async () => {
    const linked = join(root, "linked");
    const wanted = join(root, "wanted");
    const other = join(root, "other-installed");
    await plugin(linked, "linked-one");
    await plugin(wanted, "wanted-one");
    await plugin(other, "not-wanted");
    const home = await installed({ key: "wanted-one@market", dir: wanted }, { key: "not-wanted@market", dir: other });
    const d = await discoverPlugins({ plugins: { paths: [linked], include: ["wanted-one@market"] } }, { home });
    expect(d.plugins.map((p) => p.name).sort()).toEqual(["linked-one", "wanted-one"]);
    expect(d.problems).toEqual([]);
  });

  it("says so when an included plugin is not installed or a linked folder is not a plugin", async () => {
    const home = await installed();
    await mkdir(join(root, "notaplugin"), { recursive: true });
    const d = await discoverPlugins({ plugins: { paths: [join(root, "notaplugin")], include: ["ghost@market"] } }, { home });
    expect(d.plugins).toEqual([]);
    expect(d.problems.map((p) => p.message).join("\n")).toMatch(/ghost@market is not installed/);
    expect(d.problems.map((p) => p.message).join("\n")).toMatch(/not a plugin/);
  });

  it("loads nothing by default", async () => {
    const d = await discoverPlugins({ plugins: { paths: [], include: [] } }, { home: join(root, "nohome") });
    expect(d).toEqual({ plugins: [], problems: [] });
  });
});

describe("pluginSkillRoots", () => {
  it("offers each plugin's skills folder as a third-party root named after the plugin", async () => {
    const dir = join(root, "p3");
    await plugin(dir);
    const roots = pluginSkillRoots([(await loadPlugin(dir))!]);
    expect(roots).toEqual([{ path: join(dir, "skills"), label: "plugin:acme-seo", trust: "third_party" }]);
    await mkdir(join(root, "noskills", ".claude-plugin"), { recursive: true });
    await writeFile(join(root, "noskills", ".claude-plugin", "plugin.json"), "{}");
    expect(pluginSkillRoots([(await loadPlugin(join(root, "noskills")))!])).toEqual([]);
  });
});
