import { join, resolve } from "node:path";
import type { Command } from "commander";
import { Ledger } from "../audit/ledger.js";
import { ToolRegistry } from "../runtime/registry.js";
import { RunScope } from "../runtime/scope.js";
import { createBuiltinTools } from "../runtime/tools/index.js";
import { loadPolicy } from "../shield/policy.js";
import { loadStyleContext } from "../style/context.js";
import type { Pack } from "../style/slop.js";
import { loadWorkspace } from "../workspace/load.js";
import { guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

async function openRegistry(workspaceOption: string | undefined) {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config, dropzoneDir } = await loadWorkspace(dir);
  const policy = await loadPolicy(dir);
  const context = await loadStyleContext(dir);
  const languages = [config.localization.languages.primary, config.localization.languages.secondary].filter((l): l is string => Boolean(l));
  const packs: Pack[] = config.style.slop.packs ?? ["protocol", "extended", ...(languages.includes("ar") ? (["ar"] as const) : [])];
  const registry = new ToolRegistry({ policy, ledger: new Ledger(join(dir, LEDGER_FILE)) });
  for (const tool of createBuiltinTools({
    policy,
    style: { packs, extraBanned: [...config.style.slop.extra_banned, ...context.forbiddenPhrases], allow: config.style.slop.allow, claims: context.claims, failOn: config.style.slop.fail_on },
  })) {
    registry.register(tool);
  }
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: config.workspace.id, dropzoneDir, client: config.workspace.id });
  return { registry, scope };
}

export function registerToolCommands(program: Command): void {
  const tool = program.command("tool").description("the tools an agent run can use (read, draft, propose; never write)");

  tool
    .command("list")
    .description("list tools with their class and input schema")
    .option("--workspace <dir>", "workspace folder")
    .option("--json", "include the JSON schema")
    .action((opts: { workspace?: string; json?: boolean }) =>
      guarded(async () => {
        const { registry } = await openRegistry(opts.workspace);
        for (const spec of registry.specs()) {
          process.stdout.write(opts.json ? `${JSON.stringify(spec)}\n` : `${spec.name.padEnd(22)} ${spec.class.padEnd(8)} ${spec.description.split(". ")[0]}\n`);
        }
      }),
    );

  tool
    .command("call <name>")
    .description("run one tool through the same permission pipeline an agent uses (logged to the ledger)")
    .requiredOption("--input <json>", "tool input as JSON, e.g. '{\"path\":\"context/brand-voice.md\"}'")
    .option("--workspace <dir>", "workspace folder")
    .action((name: string, opts: { input: string; workspace?: string }) =>
      guarded(async () => {
        let input: unknown;
        try {
          input = JSON.parse(opts.input);
        } catch {
          throw new Error("--input must be valid JSON");
        }
        const { registry, scope } = await openRegistry(opts.workspace ? resolve(opts.workspace) : undefined);
        const outcome = await registry.invoke({ name, input }, { runId: `manual_${Date.now()}`, step: 1, scope });
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        return outcome.ok ? 0 : 1;
      }),
    );
}
