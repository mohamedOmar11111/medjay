// Reads plugins (Claude-style folders with .claude-plugin/plugin.json) for what Medjay can use: their
// skills, slash-command texts, agent personas and MCP server definitions. It never runs anything a
// plugin ships: hooks, scripts and binaries are only counted so a person can see what was skipped. MCP
// definitions are recorded by name and kind, with the NAMES of their credentials but never the values.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseSkill } from "../skills/parse.js";
import { defaultRoots, type SkillRoot } from "../skills/discover.js";

export interface McpDefinition {
  name: string;
  transport: string;
  /** Host for a URL, the program for a local command. */
  target: string;
  status: string;
  /** Header and environment variable names the server expects; the values are never read into Medjay. */
  credential_keys: string[];
}

export interface PluginInfo {
  name: string;
  version?: string;
  description?: string;
  root: string;
  skills: { dir: string; count: number };
  commands: { name: string; description: string }[];
  agents: { name: string; description: string }[];
  mcp: McpDefinition[];
  /** What the plugin ships that Medjay does not run. */
  ignored: { hooks: number; scripts: number; bin: number };
}

const MAX_MANIFEST_BYTES = 64_000;
const MAX_FILES_COUNTED = 500;
const MCP_PENDING = "not connected: the read-only MCP client is not built yet";

async function readJson(file: string): Promise<unknown | null> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  if (info.size > MAX_MANIFEST_BYTES) throw new Error(`${file} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as unknown;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function markdownIn(dir: string): Promise<{ name: string; description: string }[]> {
  const out: { name: string; description: string }[] = [];
  for (const file of (await entries(dir)).filter((f) => f.toLowerCase().endsWith(".md")).slice(0, MAX_FILES_COUNTED)) {
    try {
      const fallback = file.slice(0, -3);
      const parsed = parseSkill((await readFile(join(dir, file), "utf8")).slice(0, 20_000), fallback);
      out.push({ name: parsed.name === fallback ? fallback : parsed.name, description: parsed.description });
    } catch {
      /* an unreadable file is skipped */
    }
  }
  return out;
}

async function countSkills(dir: string): Promise<number> {
  let n = 0;
  for (const folder of await entries(dir)) {
    const ok = await stat(join(dir, folder, "SKILL.md")).then((s) => s.isFile(), () => false);
    if (ok) n += 1;
  }
  return n;
}

function hookCount(value: unknown): number {
  const hooks = isRecord(value) && isRecord(value.hooks) ? value.hooks : isRecord(value) ? value : {};
  return Object.values(hooks).reduce<number>((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
}

function mcpDefinitions(...sources: unknown[]): McpDefinition[] {
  const out: McpDefinition[] = [];
  for (const source of sources) {
    const servers = isRecord(source) ? (isRecord(source.mcpServers) ? source.mcpServers : source) : {};
    for (const [name, raw] of Object.entries(servers)) {
      if (!isRecord(raw) || out.some((d) => d.name === name)) continue;
      const url = str(raw.url);
      const command = str(raw.command);
      const transport = str(raw.type) ?? (command ? "stdio" : "http");
      let target = command ? basename(command) : "";
      if (url) {
        try {
          target = new URL(url).hostname;
        } catch {
          target = "invalid url";
        }
      }
      const keys = [...Object.keys(isRecord(raw.headers) ? raw.headers : {}), ...Object.keys(isRecord(raw.env) ? raw.env : {})].sort();
      out.push({ name, transport, target, status: MCP_PENDING, credential_keys: keys });
    }
  }
  return out;
}

/** The plugin in a folder, or null when the folder has no plugin manifest. Throws when the manifest cannot be read. */
export async function loadPlugin(dir: string): Promise<PluginInfo | null> {
  const root = resolve(dir);
  const manifest = await readJson(join(root, ".claude-plugin", "plugin.json"));
  if (manifest === null) return null;
  const m = isRecord(manifest) ? manifest : {};
  const skillsDir = join(root, "skills");
  const hooksFile = await readJson(join(root, "hooks", "hooks.json")).catch(() => null);
  const mcpFile = await readJson(join(root, ".mcp.json")).catch(() => null);
  return {
    name: str(m.name) ?? basename(root),
    ...(str(m.version) ? { version: str(m.version) as string } : {}),
    ...(str(m.description) ? { description: str(m.description) as string } : {}),
    root,
    skills: { dir: skillsDir, count: await countSkills(skillsDir) },
    commands: await markdownIn(join(root, "commands")),
    agents: await markdownIn(join(root, "agents")),
    mcp: mcpDefinitions(mcpFile, m.mcpServers === undefined ? undefined : { mcpServers: m.mcpServers }),
    ignored: {
      hooks: hookCount(hooksFile) + (isRecord(m.hooks) ? hookCount(m) : 0),
      scripts: (await entries(join(root, "scripts"))).length,
      bin: (await entries(join(root, "bin"))).length,
    },
  };
}

export interface PluginConfig {
  plugins: { paths: readonly string[]; include: readonly string[] };
}

export interface PluginDiscovery {
  plugins: PluginInfo[];
  problems: { plugin: string; message: string }[];
}

const expandHome = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? join(home, path.slice(2)) : path);

/** The plugins the owner linked by folder, plus the installed ones named in `include`. Nothing else is read. */
export async function discoverPlugins(config: PluginConfig, options: { home?: string } = {}): Promise<PluginDiscovery> {
  const home = options.home ?? homedir();
  const plugins: PluginInfo[] = [];
  const problems: PluginDiscovery["problems"] = [];
  const add = (p: PluginInfo) => {
    if (!plugins.some((x) => x.root === p.root)) plugins.push(p);
  };

  for (const path of config.plugins.paths) {
    const dir = resolve(expandHome(path, home));
    try {
      const p = await loadPlugin(dir);
      if (p) add(p);
      else problems.push({ plugin: path, message: `${dir} is not a plugin (no .claude-plugin/plugin.json)` });
    } catch (error) {
      problems.push({ plugin: path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (config.plugins.include.length > 0) {
    let registry: Record<string, unknown> = {};
    try {
      const raw = await readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
      if (isRecord(raw) && isRecord(raw.plugins)) registry = raw.plugins;
    } catch (error) {
      problems.push({ plugin: "installed_plugins.json", message: error instanceof Error ? error.message : String(error) });
    }
    for (const key of config.plugins.include) {
      const installs = Array.isArray(registry[key]) ? (registry[key] as unknown[]).filter(isRecord) : [];
      const chosen = installs.find((i) => i.scope === "user" && str(i.installPath)) ?? installs.find((i) => str(i.installPath));
      if (!chosen) {
        problems.push({ plugin: key, message: `${key} is not installed (looked in ~/.claude/plugins/installed_plugins.json)` });
        continue;
      }
      try {
        const p = await loadPlugin(str(chosen.installPath) as string);
        if (p) add(p);
        else problems.push({ plugin: key, message: `${key} is installed but its folder has no .claude-plugin/plugin.json` });
      } catch (error) {
        problems.push({ plugin: key, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { plugins, problems };
}

/** Each plugin's skills folder as a third-party skill root, so its skills are found like any others. */
export function pluginSkillRoots(plugins: readonly PluginInfo[]): SkillRoot[] {
  return plugins.filter((p) => p.skills.count > 0).map((p) => ({ path: p.skills.dir, label: `plugin:${p.name}`, trust: "third_party" as const }));
}

/** Every place skills come from: the workspace, the user's folder, linked roots, then plugin skills. */
export async function skillRootsWithPlugins(
  config: PluginConfig & { skills: Parameters<typeof defaultRoots>[0]["skills"] },
  base: { workspaceDir: string; home: string },
): Promise<{ roots: SkillRoot[]; plugins: PluginDiscovery }> {
  const plugins = await discoverPlugins(config, { home: base.home });
  return { roots: [...defaultRoots(config, base), ...pluginSkillRoots(plugins.plugins)], plugins };
}
