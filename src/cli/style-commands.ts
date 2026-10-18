import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { directiveFor, type Surface } from "../style/caveman.js";
import { loadStyleContext } from "../style/context.js";
import { slopPromptRules } from "../style/prompt.js";
import { lintText, type Kind, type Pack } from "../style/slop.js";
import { findWorkspace, loadWorkspace } from "../workspace/load.js";
import { guarded } from "./util.js";

const SURFACES: Surface[] = ["internal", "whatsapp", "client_copy", "approval", "security"];

async function readInput(file: string | undefined): Promise<string> {
  if (file && file !== "-") return readFile(resolve(file), "utf8");
  if (process.stdin.isTTY) throw new Error("give a file, or pipe text on stdin");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** The workspace's style settings, or defaults outside a workspace. */
async function workspaceStyle(workspaceOption: string | undefined) {
  const dir = workspaceOption ? resolve(workspaceOption) : await findWorkspace(process.cwd());
  if (dir === null) return undefined;
  const { config } = await loadWorkspace(dir);
  const context = await loadStyleContext(dir);
  const languages = [config.localization.languages.primary, config.localization.languages.secondary].filter((l): l is string => Boolean(l));
  const packs: Pack[] = config.style.slop.packs ?? ["protocol", "extended", ...(languages.includes("ar") ? (["ar"] as const) : [])];
  return { config, context, packs, languages };
}

export function registerStyleCommands(program: Command): void {
  const slop = program.command("slop").description("anti-slop checks for customer-facing copy");
  slop
    .command("check [file]")
    .description("lint copy against the Anti-AI Writing Protocol, workspace brand voice and the claim register (file, or - for stdin)")
    .addOption(new Option("--kind <kind>", "what the text is").choices(["general", "post", "ad", "message"]).default("general"))
    .option("--workspace <dir>", "workspace folder (default: nearest parent)")
    .option("--strict", "treat warnings as failures")
    .option("--json", "machine-readable output")
    .action((file: string | undefined, opts: { kind: Kind; workspace?: string; strict?: boolean; json?: boolean }) =>
      guarded(async () => {
        const text = await readInput(file);
        const ws = await workspaceStyle(opts.workspace);
        const report = lintText(text, {
          kind: opts.kind,
          ...(ws
            ? {
                packs: ws.packs,
                extraBanned: [...ws.config.style.slop.extra_banned, ...ws.context.forbiddenPhrases],
                allow: ws.config.style.slop.allow,
                claims: ws.context.claims,
                failOn: opts.strict ? ("warn" as const) : ws.config.style.slop.fail_on,
              }
            : { failOn: opts.strict ? ("warn" as const) : ("error" as const) }),
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          for (const f of report.findings) {
            process.stdout.write(`${f.line}:${f.column}  ${f.severity.toUpperCase().padEnd(5)} ${f.rule.padEnd(22)} "${f.match}"  ${f.message}${f.suggestion ? `  -> ${f.suggestion}` : ""}\n`);
          }
          process.stdout.write(
            `${report.findings.length === 0 ? "clean" : `${report.counts.error} errors, ${report.counts.warn} warnings`} (${report.stats.words} words, ${report.stats.sentences} sentences)${ws?.context.claims ? "" : "; no claim register, numbers not checked"}\n`,
          );
        }
        return report.pass ? 0 : 1;
      }),
    );

  const style = program.command("style").description("terse (caveman) output and anti-slop settings");
  style
    .command("show")
    .description("show the effective caveman levels and the directive each surface gets")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const ws = await workspaceStyle(opts.workspace);
        const config = ws?.config.style ?? (await import("../style/config.js")).StyleConfigSchema.parse({});
        const language = ws?.config.localization.languages.primary ?? "en";
        process.stdout.write(`language: ${language}\n\n`);
        for (const surface of SURFACES) {
          const directive = directiveFor(config, surface, language);
          process.stdout.write(`${surface.padEnd(12)} ${directive === "" ? "off (plain sentences)" : directive}\n`);
        }
        process.stdout.write(`\nanti-slop prompt rules (${slopPromptRules().length} lines) are added to every customer-facing draft; \`mdj slop check\` enforces them.\n`);
      }),
    );
}
