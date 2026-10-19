import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { Ledger } from "../audit/ledger.js";
import { loadRuleConfig } from "../media/config.js";
import { MediaRuleError, RULES, renderRule, ruleById, type RuleDef } from "../media/rules.js";
import { MAX_MEDIA_BYTES, MEDIA_DIR, runMedia, splitArgs } from "../media/run.js";
import { loadWorkspace } from "../workspace/load.js";
import { cliActor, guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

const out = (text: string) => process.stdout.write(`${text}\n`);

function explain(def: RuleDef): string {
  const params = def.params.map((p) => `  ${p.name}=${p.required ? "<required>" : "<optional>"}  ${p.note}`);
  return [
    `${def.number}. ${def.id}  [${def.platforms}]  ${def.title}`,
    "",
    def.description,
    "",
    def.file === "-" ? "Input: none (parameters only)" : `Input: ${def.file} (columns: ${def.columns.join(", ")}${def.optionalColumns.length ? `; optional: ${def.optionalColumns.join(", ")}` : ""})`,
    ...(params.length ? ["Parameters:", ...params] : []),
    "Decision:",
    ...def.decision.map((d) => `  - ${d}`),
    `Output: ${def.output}`,
    `Guardrails: ${def.guardrails}`,
  ].join("\n");
}

async function resolveInput(def: RuleDef, file: string | undefined, dropzoneDir: string): Promise<string | undefined> {
  if (def.file === "-") return undefined;
  const path = file ? (isAbsolute(file) ? file : resolve(file)) : join(dropzoneDir, MEDIA_DIR, def.file);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new MediaRuleError(`${path} not found; save the export there or pass a file (see \`mdj media explain ${def.id}\`)`);
  }
  if (size > MAX_MEDIA_BYTES) throw new MediaRuleError(`${path} is ${size} bytes; the limit is ${MAX_MEDIA_BYTES}`);
  return readFile(path, "utf8");
}

export function registerMediaCommands(program: Command): void {
  const media = program.command("media").description("read-only media-buyer rules over exported CSVs (advice only; nothing is changed in any ad account)");

  media
    .command("list")
    .description("list the 20 rules")
    .option("--json", "machine-readable")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        out(JSON.stringify(RULES.map(({ id, number, platforms, title, file }) => ({ id, number, platforms, title, file })), null, 2));
        return;
      }
      for (const r of RULES) out(`${String(r.number).padStart(2)}. ${r.id.padEnd(20)} ${r.platforms.padEnd(14)} ${r.title}`);
    });

  media
    .command("explain <rule>")
    .description("what a rule reads, decides and refuses")
    .action((rule: string) =>
      guarded(async () => {
        const def = ruleById(rule);
        if (!def) throw new MediaRuleError(`no media rule "${rule}"; see \`mdj media list\``);
        out(explain(def));
      }),
    );

  media
    .command("run <rule> [args...]")
    .description("run one rule: an optional CSV path, then key=value parameters (default file: <dropzone>/media/<name>.csv)")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((rule: string, args: string[], opts: { json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const { dropzoneDir } = await loadWorkspace(dir);
        const cfg = await loadRuleConfig(dir);
        const def = ruleById(rule);
        if (!def) throw new MediaRuleError(`no media rule "${rule}"; see \`mdj media list\``);
        const { file, params } = splitArgs(args);
        const text = await resolveInput(def, file, dropzoneDir);
        const { result } = runMedia(def.id, text, { cfg, params, now: () => new Date() });
        // Counts only: file contents never enter the ledger.
        await new Ledger(join(dir, LEDGER_FILE)).append({
          actor: cliActor(),
          event: "media_rules.run",
          payload: { rule: def.id, rows: result.rows.length, warnings: result.warnings.length, params: Object.keys(params) },
        });
        out(opts.json ? JSON.stringify(result, null, 2) : renderRule(result));
      }),
    );
}
