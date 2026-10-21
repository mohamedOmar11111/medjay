// mdj skills ...: see which skills Medjay can find and where each came from; mdj skill link/unlink:
// point Medjay at another folder of skills (for example the Growth Architect HQ repo) without copying.
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Option, type Command } from "commander";
import { parseDocument } from "yaml";
import { Ledger } from "../audit/ledger.js";
import { defaultRoots, discoverSkills, type Discovery, type SkillEntry, type SkillRoot } from "../skills/discover.js";
import { loadWorkspace } from "../workspace/load.js";
import { cliActor, guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

interface LinkedPath {
  path: string;
  trust: "owner" | "untrusted";
  name?: string;
}

const out = (text: string) => process.stdout.write(`${text}\n`);
const expandHome = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path);
const same = (a: string, b: string) => resolve(expandHome(a)).toLowerCase() === resolve(expandHome(b)).toLowerCase();

async function open(workspaceOption: string | undefined): Promise<{ dir: string; roots: SkillRoot[]; discovery: Discovery }> {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config } = await loadWorkspace(dir);
  const roots = defaultRoots(config, { workspaceDir: dir, home: homedir() });
  return { dir, roots, discovery: await discoverSkills(roots) };
}

function toolLines(s: SkillEntry): string[] {
  const t = s.translation;
  return [
    ...t.mapped.map((m) => `  ${m.from} -> ${m.to}`),
    ...t.unavailable.map((u) => `  ${u.from} -> ${u.to} (not available yet: ${u.reason})`),
    ...(t.stripped.length > 0 ? [`  stripped: ${t.stripped.join(", ")} (shell commands are never available)`] : []),
    ...(t.unknown.length > 0 ? [`  unknown: ${t.unknown.join(", ")}`] : []),
  ];
}

/** Edit skills.paths in workspace.yaml, keeping the owner's comments, and undo it if the file stops loading. */
async function editLinkedPaths(dir: string, change: (current: LinkedPath[]) => LinkedPath[]): Promise<void> {
  const file = join(dir, "workspace.yaml");
  const original = await readFile(file, "utf8");
  const doc = parseDocument(original);
  const current = ((doc.toJS() as { skills?: { paths?: LinkedPath[] } }).skills?.paths ?? []) as LinkedPath[];
  doc.setIn(["skills", "paths"], change(current));
  await writeFile(file, doc.toString());
  try {
    await loadWorkspace(dir);
  } catch (error) {
    await writeFile(file, original);
    throw error;
  }
}

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("the skills Medjay can find, and where each one came from");

  skills
    .command("list")
    .description("every skill found, with its source and trust")
    .option("--source <label>", "only skills from this source")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { source?: string; json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const { discovery } = await open(opts.workspace);
        const list = discovery.skills.filter((s) => opts.source === undefined || s.root === opts.source).sort((a, b) => a.name.localeCompare(b.name));
        if (opts.json) {
          out(JSON.stringify(list.map((s) => ({ name: s.name, description: s.description, source: s.root, trust: s.trust, file: s.file, bytes: s.bytes, tools: s.translation, problems: s.problems })), null, 2));
          return;
        }
        if (list.length === 0) {
          out("No skills found. Put SKILL.md folders in <workspace>/skills, or point Medjay at a folder: mdj skill link <path> --trust owner");
          return;
        }
        out(`${"NAME".padEnd(44)}${"SOURCE".padEnd(18)}${"TRUST".padEnd(13)}DESCRIPTION`);
        for (const s of list) out(`${s.name.slice(0, 42).padEnd(44)}${s.root.padEnd(18)}${s.trust.padEnd(13)}${s.description.slice(0, 70)}`);
        out("", );
        out(`${list.length} skill(s).${discovery.collisions.length > 0 ? ` ${discovery.collisions.length} name(s) hidden by an earlier source: mdj skills doctor` : ""}${discovery.problems.length > 0 ? ` ${discovery.problems.length} file(s) could not be loaded: mdj skills doctor` : ""}`);
      }),
    );

  skills
    .command("show <name>")
    .description("one skill: source, size, and what became of the tools it declares")
    .option("--workspace <dir>", "workspace folder")
    .action((name: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const { discovery } = await open(opts.workspace);
        const s = discovery.skills.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!s) throw new Error(`no skill named "${name}"; mdj skills list shows what was found`);
        const tools = toolLines(s);
        out([`name: ${s.name}`, `source: ${s.root} (${s.trust})`, `file: ${s.file}`, `size: ${s.bytes} bytes`, `description: ${s.description}`, `tools:${tools.length === 0 ? " none declared" : ""}`, ...tools, ...(s.problems.length > 0 ? ["problems:", ...s.problems.map((p) => `  ${p}`)] : [])].join("\n"));
      }),
    );

  skills
    .command("doctor")
    .description("roots, hidden names, files that could not be loaded, and tools a skill asks for that Medjay will not give it")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const { roots, discovery } = await open(opts.workspace);
        const counts = new Map<string, number>();
        for (const s of discovery.skills) counts.set(s.root, (counts.get(s.root) ?? 0) + 1);
        const lines = ["roots (first wins):", ...roots.map((r) => `  ${r.label.padEnd(18)}${r.trust.padEnd(13)}${String(counts.get(r.label) ?? 0).padStart(4)} skill(s)  ${r.path}`)];
        if (discovery.collisions.length > 0) lines.push("", "hidden names:", ...discovery.collisions.map((c) => `  ${c.name}: kept ${c.kept}, hidden ${c.hidden.join(", ")}`));
        if (discovery.problems.length > 0) lines.push("", "could not be loaded:", ...discovery.problems.map((p) => `  ${p.file}: ${p.message}`));
        const odd = discovery.skills.filter((s) => s.translation.stripped.length + s.translation.unknown.length > 0 || s.problems.length > 0);
        if (odd.length > 0) lines.push("", "worth a look:", ...odd.map((s) => `  ${s.name}: ${[...s.problems, ...(s.translation.stripped.length > 0 ? [`stripped ${s.translation.stripped.join(", ")}`] : []), ...(s.translation.unknown.length > 0 ? [`unknown tools ${s.translation.unknown.join(", ")}`] : [])].join("; ")}`));
        out(lines.join("\n"));
        return discovery.problems.length > 0 ? 1 : 0;
      }),
    );

  const skill = program.command("skill").description("point Medjay at another folder of skills");

  skill
    .command("link <path>")
    .description("add a folder of skills (each in its own folder with a SKILL.md) without copying anything")
    .addOption(new Option("--trust <level>", "owner: your own words; untrusted: someone else's, handled with care").choices(["owner", "untrusted"]).default("untrusted"))
    .option("--name <id>", "a short label shown as the source")
    .option("--workspace <dir>", "workspace folder")
    .action((path: string, opts: { trust: "owner" | "untrusted"; name?: string; workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const target = resolve(expandHome(path));
        if (!(await stat(target).then((s) => s.isDirectory(), () => false))) throw new Error(`${target} is not a folder`);
        const label = opts.name ?? (basename(target) || "linked");
        await editLinkedPaths(dir, (current) => {
          if (current.some((c) => same(c.path, target))) throw new Error(`${target} is already linked`);
          return [...current, { path: target, trust: opts.trust, ...(opts.name ? { name: opts.name } : {}) }];
        });
        await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "skills.linked", payload: { path: target, trust: opts.trust, name: label } });
        out(`linked ${label} (${opts.trust}): ${target}\nmdj skills list shows what it holds.`);
      }),
    );

  skill
    .command("unlink <path>")
    .description("stop reading a linked folder (nothing is deleted)")
    .option("--workspace <dir>", "workspace folder")
    .action((path: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const target = resolve(expandHome(path));
        await editLinkedPaths(dir, (current) => {
          const next = current.filter((c) => !same(c.path, target) && c.name !== path);
          if (next.length === current.length) throw new Error(`${target} is not linked`);
          return next;
        });
        await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "skills.unlinked", payload: { path: target } });
        out(`unlinked ${target}`);
      }),
    );
}
