// mdj plugins ...: see what linked or included plugins offer, and what Medjay does NOT run from them.
// Skills, command texts, agent personas and MCP definitions are read; hooks, scripts and binaries never
// are. Credential values in an MCP definition are not read into Medjay at all.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { Ledger } from "../audit/ledger.js";
import { discoverPlugins, loadPlugin, type PluginInfo } from "../plugins/plugins.js";
import { loadWorkspace } from "../workspace/load.js";
import { editList } from "./skills-commands.js";
import { cliActor, guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

const out = (text: string) => process.stdout.write(`${text}\n`);
const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path);
const same = (a: string, b: string) => resolve(expandHome(a)).toLowerCase() === resolve(expandHome(b)).toLowerCase();

async function open(workspaceOption: string | undefined) {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config } = await loadWorkspace(dir);
  return { dir, config, discovery: await discoverPlugins(config) };
}

const ignoredLine = (p: PluginInfo) => `hooks ${p.ignored.hooks}, scripts ${p.ignored.scripts}, bin ${p.ignored.bin}`;

export function registerPluginsCommands(program: Command): void {
  const plugins = program.command("plugins").description("plugins Medjay can read skills, commands, agents and MCP definitions from (it never runs their hooks or scripts)");

  plugins
    .command("list")
    .description("linked and included plugins")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const { discovery } = await open(opts.workspace);
        if (opts.json) return void out(JSON.stringify(discovery, null, 2));
        if (discovery.plugins.length === 0) out("No plugins. Link a folder with: mdj plugins link <path>, or turn on an installed one with: mdj plugins include <name@marketplace>");
        else {
          out(`${"NAME".padEnd(28)}${"VERSION".padEnd(10)}${"SKILLS".padEnd(8)}${"CMDS".padEnd(6)}${"AGENTS".padEnd(8)}${"MCP".padEnd(5)}NOT RUN`);
          for (const p of discovery.plugins) out(`${p.name.slice(0, 26).padEnd(28)}${(p.version ?? "-").slice(0, 8).padEnd(10)}${String(p.skills.count).padEnd(8)}${String(p.commands.length).padEnd(6)}${String(p.agents.length).padEnd(8)}${String(p.mcp.length).padEnd(5)}${ignoredLine(p)}`);
        }
        for (const problem of discovery.problems) out(`problem: ${problem.message}`);
      }),
    );

  plugins
    .command("show <name>")
    .description("one plugin: what Medjay reads from it and what it skips")
    .option("--workspace <dir>", "workspace folder")
    .action((name: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const { discovery } = await open(opts.workspace);
        const p = discovery.plugins.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!p) throw new Error(`no plugin named "${name}"; mdj plugins list shows what is linked or included`);
        const lines = [`name: ${p.name}`, `version: ${p.version ?? "-"}`, `folder: ${p.root}`, ...(p.description ? [`description: ${p.description}`] : []), `skills: ${p.skills.count}${p.skills.count > 0 ? ` (read from ${p.skills.dir}; shown in mdj skills list as plugin:${p.name})` : ""}`, `commands: ${p.commands.length > 0 ? p.commands.map((c) => c.name).join(", ") : "none"}`, `agents: ${p.agents.length > 0 ? p.agents.map((a) => a.name).join(", ") : "none"}`, `mcp servers: ${p.mcp.length === 0 ? "none" : ""}`];
        for (const m of p.mcp) lines.push(`  ${m.name}  ${m.transport}  ${m.target}  credentials expected: ${m.credential_keys.length > 0 ? m.credential_keys.join(", ") : "none"}  [${m.status}]`);
        lines.push(`ignored: ${ignoredLine(p)} (Medjay never runs a plugin's hooks, scripts or binaries)`);
        out(lines.join("\n"));
      }),
    );

  plugins
    .command("link <path>")
    .description("read a plugin folder (it must contain .claude-plugin/plugin.json)")
    .option("--workspace <dir>", "workspace folder")
    .action((path: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const target = resolve(expandHome(path));
        if (!(await stat(target).then((s) => s.isDirectory(), () => false))) throw new Error(`${target} is not a folder`);
        const plugin = await loadPlugin(target);
        if (!plugin) throw new Error(`${target} is not a plugin (no .claude-plugin/plugin.json)`);
        await editList<string>(dir, ["plugins", "paths"], (current) => {
          if (current.some((c) => same(c, target))) throw new Error(`${target} is already linked`);
          return [...current, target];
        });
        await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "plugins.linked", payload: { path: target, name: plugin.name } });
        out(`linked ${plugin.name}: ${plugin.skills.count} skill(s), ${plugin.commands.length} command(s), ${plugin.agents.length} agent(s), ${plugin.mcp.length} MCP definition(s); not run: ${ignoredLine(plugin)}`);
      }),
    );

  plugins
    .command("unlink <path>")
    .description("stop reading a linked plugin folder (nothing is deleted)")
    .option("--workspace <dir>", "workspace folder")
    .action((path: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        await editList<string>(dir, ["plugins", "paths"], (current) => {
          const next = current.filter((c) => !same(c, path));
          if (next.length === current.length) throw new Error(`${resolve(expandHome(path))} is not linked`);
          return next;
        });
        await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "plugins.unlinked", payload: { path: resolve(expandHome(path)) } });
        out("unlinked");
      }),
    );

  plugins
    .command("include <nameAtMarketplace>")
    .description("turn on an installed plugin (name@marketplace, as listed in ~/.claude/plugins/installed_plugins.json)")
    .option("--workspace <dir>", "workspace folder")
    .action((key: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const { config } = await loadWorkspace(dir);
        const check = await discoverPlugins({ plugins: { paths: [], include: [key] } });
        if (check.plugins.length === 0) throw new Error(check.problems[0]?.message ?? `${key} is not installed`);
        await editList<string>(dir, ["plugins", "include"], (current) => {
          if (current.includes(key) || config.plugins.include.includes(key)) throw new Error(`${key} is already included`);
          return [...current, key];
        });
        await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "plugins.included", payload: { plugin: key } });
        out(`included ${key} (${check.plugins[0]?.skills.count ?? 0} skill(s))`);
      }),
    );

  plugins
    .command("exclude <nameAtMarketplace>")
    .description("turn an included plugin off again")
    .option("--workspace <dir>", "workspace folder")
    .action((key: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        await editList<string>(dir, ["plugins", "include"], (current) => {
          const next = current.filter((c) => c !== key);
          if (next.length === current.length) throw new Error(`${key} is not included`);
          return next;
        });
        await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "plugins.excluded", payload: { plugin: key } });
        out(`excluded ${key}`);
      }),
    );
}
