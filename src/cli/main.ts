import { stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Argument, Command, Option } from "commander";
import { Ledger, verifyLedger } from "../audit/ledger.js";
import { runDoctor } from "../doctor/checks.js";
import { ModelCatalog } from "../models/catalog.js";
import { CredentialResolver, KeyringStore, defaultRef, type CredentialRef } from "../models/credentials.js";
import { PROVIDERS, SLOT_NAMES, resolveSlot, type Provider } from "../models/slots.js";
import { BUSINESS_TYPES, type BusinessType } from "../pillars/catalog.js";
import { Store } from "../store/db.js";
import { VERSION } from "../version.js";
import { initWorkspace } from "../workspace/init.js";
import { findWorkspace, loadWorkspace } from "../workspace/load.js";
import { migrateWorkspaceFile } from "../workspace/migrate.js";
import { formatDoctor } from "./format.js";
import { registerAnalysisCommands } from "./analysis-commands.js";
import { registerBridgeCommands } from "./bridge-commands.js";
import { registerDemoCommands } from "./demo-commands.js";
import { registerMediaCommands } from "./media-commands.js";
import { registerPlanCommands } from "./plan-commands.js";
import { registerShieldCommands } from "./shield-commands.js";
import { registerShadowCommands } from "./shadow-commands.js";
import { registerStyleCommands } from "./style-commands.js";
import { registerRunCommands } from "./run-commands.js";
import { registerSkillsCommands } from "./skills-commands.js";
import { registerTacticCommands } from "./tactic-commands.js";
import { registerVaultCommands } from "./vault-commands.js";
import { registerToolCommands } from "./tool-commands.js";
import { guarded, LEDGER_FILE, STORE_FILE, workspaceDirOrThrow } from "./util.js";
import { readSecret } from "./secret-input.js";

const KEY_PROVIDERS = PROVIDERS.filter((p) => p !== "ollama");
/** "7d" or an ISO date to an ISO timestamp. */
function parseSince(value: string): string {
  const days = /^(\d+)d$/.exec(value);
  if (days) return new Date(Date.now() - Number(days[1]) * 86_400_000).toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`cannot read --since "${value}"; use 7d or an ISO date`);
  return date.toISOString();
}

const num = (n: number) => n.toLocaleString("en-US");

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("medjay")
    .description("Open, all-model growth agent harness: Shield (guardrails) and Sword (strike).")
    .version(VERSION);

  program
    .command("init [dir]")
    .description("create a workspace (workspace.yaml, shield policy, context files, ledger)")
    .option("--id <id>", "workspace id (default: folder name)")
    .option("--name <name>", "display name (default: the id)")
    .addOption(new Option("--business-type <type>", "business type").choices(BUSINESS_TYPES).default("agency"))
    .option("--timezone <iana>", "IANA timezone, e.g. Asia/Riyadh", "UTC")
    .option("--currency <iso>", "base currency, ISO 4217, e.g. SAR", "USD")
    .option("--language <code>", "primary language code, e.g. ar", "en")
    .option("--fast <provider/model>", "model for the fast slot")
    .option("--reasoning <provider/model>", "model for the reasoning slot")
    .option("--creative <provider/model>", "model for the creative slot")
    .action((dir: string | undefined, opts: Record<string, string | undefined>) =>
      guarded(async () => {
        const target = resolve(dir ?? ".");
        const models: Record<string, string> = {};
        for (const slot of SLOT_NAMES) {
          const ref = opts[slot];
          if (ref) models[slot] = ref;
        }
        const result = await initWorkspace({
          dir: target,
          id: opts.id ?? basename(target),
          ...(opts.name ? { name: opts.name } : {}),
          businessType: opts.businessType as BusinessType,
          ...(opts.timezone ? { timezone: opts.timezone } : {}),
          ...(opts.currency ? { baseCurrency: opts.currency } : {}),
          ...(opts.language ? { primaryLanguage: opts.language } : {}),
          models,
        });
        process.stdout.write(`created workspace at ${result.dir}\n${result.files.map((f) => `  ${f}`).join("\n")}\n\n`);
        process.stdout.write("next: `mdj auth set <ref>` to store a key, then `mdj doctor`\n");
      }),
    );

  program
    .command("migrate")
    .description("upgrade a schema 0 workspace.yaml to 1.0.0 (backs up the original, records it in the ledger)")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const result = await migrateWorkspaceFile(dir);
        process.stdout.write(`migrated workspace.yaml to schema 1.0.0; original saved as ${result.backup}\n\nreview these decisions:\n`);
        process.stdout.write(`${result.notes.map((n) => `  - ${n}`).join("\n")}\n`);
      }),
    );

  program
    .command("doctor")
    .description("pre-flight checks: keychain, credentials, endpoints and models, workspace.yaml, store, ledger")
    .option("--workspace <dir>", "workspace folder (default: nearest parent with workspace.yaml)")
    .option("--json", "machine-readable output")
    .action((opts: { workspace?: string; json?: boolean }) =>
      guarded(async () => {
        const report = await runDoctor({
          cwd: process.cwd(),
          ...(opts.workspace ? { workspaceDir: resolve(opts.workspace) } : {}),
          env: process.env,
          keystore: new KeyringStore(),
          fetchFn: fetch,
          catalog: new ModelCatalog(),
        });
        process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report)}\n`);
        return report.ok ? 0 : 1;
      }),
    );

  const ledger = program.command("ledger").description("tamper-evident audit ledger");
  ledger
    .command("verify")
    .description("recompute the hash chain of .medjay/audit-log.jsonl")
    .option("--workspace <dir>", "workspace folder")
    .option("--expect-head <hash>", "head hash recorded elsewhere; detects deletion of trailing entries")
    .option("--json", "machine-readable output")
    .action((opts: { workspace?: string; expectHead?: string; json?: boolean }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const result = await verifyLedger(join(dir, LEDGER_FILE), opts.expectHead ? { expectedHead: opts.expectHead } : {});
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok) {
          process.stdout.write(result.entries === 0 ? "ledger is empty (0 entries)\n" : `OK: ${result.entries} entries, head ${result.head}\n`);
        } else {
          const f = result.failure;
          process.stdout.write(`FAILED: ${f.kind} at line ${f.line}: ${f.message}\n${result.entries} entries verified before the failure\n`);
        }
        return result.ok ? 0 : 1;
      }),
    );
  ledger
    .command("head")
    .description("print the current head (seq and hash); record it elsewhere to detect tail deletion")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const head = await new Ledger(join(dir, LEDGER_FILE)).head();
        process.stdout.write(`${head.seq} ${head.hash}\n`);
      }),
    );

  const auth = program.command("auth").description("credentials (OS keychain, or MEDJAY_* environment variables)");
  const refArg = () => new Argument("<ref>", "keychain reference: a provider id (anthropic, google, openai, openai_compatible) or a keychain_ref from workspace.yaml");
  auth
    .command("set")
    .addArgument(refArg())
    .description("store a key in the OS keychain (hidden prompt, or pipe it on stdin)")
    .action((ref: string) =>
      guarded(async () => {
        const secret = await readSecret(`${ref} API key (input hidden): `);
        await new CredentialResolver().store(ref, secret);
        process.stdout.write(`stored "${ref}" in the OS keychain\n`);
      }),
    );
  auth
    .command("status")
    .description("show where each credential comes from (never prints the key)")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const dir = opts.workspace ? resolve(opts.workspace) : await findWorkspace(process.cwd());
        const refs = new Map<string, CredentialRef>();
        if (dir) {
          const { config } = await loadWorkspace(dir);
          for (const slot of SLOT_NAMES) {
            for (const target of resolveSlot(config.models, slot)) {
              if (target.provider === "ollama") continue;
              refs.set(target.keychainRef, { keychainRef: target.keychainRef, envFallback: target.envFallback });
            }
          }
        } else {
          for (const provider of KEY_PROVIDERS) refs.set(provider, defaultRef(provider as Provider));
        }
        const resolver = new CredentialResolver();
        for (const ref of refs.values()) {
          const s = await resolver.status(ref);
          const where = s.source === "none" ? `not set (OS keychain, or ${ref.envFallback})` : s.source;
          process.stdout.write(`${ref.keychainRef.padEnd(22)} ${where}\n`);
        }
      }),
    );
  auth
    .command("remove")
    .addArgument(refArg())
    .description("delete a key from the OS keychain")
    .action((ref: string) =>
      guarded(async () => {
        const removed = await new CredentialResolver().remove(ref);
        process.stdout.write(removed ? `removed "${ref}"\n` : `no "${ref}" entry in the keychain\n`);
      }),
    );

  const models = program.command("models").description("model slots and usage");
  models
    .command("cost")
    .description("token usage by slot, provider and model, from the machine-state store")
    .option("--workspace <dir>", "workspace folder")
    .option("--since <when>", "7d, or an ISO date", "30d")
    .option("--by-surface", "split by surface (internal narration, WhatsApp reply, client copy, diagnosis) to measure terse-output savings")
    .option("--json", "machine-readable output")
    .action((opts: { workspace?: string; since: string; json?: boolean; bySurface?: boolean }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const file = join(dir, STORE_FILE);
        if (!(await stat(file).then(() => true, () => false))) {
          process.stdout.write("no usage recorded yet\n");
          return;
        }
        const store = Store.open(file);
        try {
          const rows = store.usageSummary(parseSince(opts.since), { bySurface: opts.bySurface === true });
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          } else if (rows.length === 0) {
            process.stdout.write(`no usage since ${opts.since}\n`);
          } else {
            for (const r of rows) {
              const cost = r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(4)}`;
              process.stdout.write(
                `${r.slot.padEnd(10)} ${(r.surface ?? "").padEnd(r.surface ? 19 : 0)}${`${r.provider}/${r.model}`.padEnd(36)} calls ${num(r.calls)} (${r.failures} failed)  in ${num(r.inputTokens)}  out ${num(r.outputTokens)}  cached ${num(r.cachedTokens)}  cost ${cost}  avg ${Math.round(r.avgLatencyMs)} ms\n`,
              );
            }
          }
        } finally {
          store.close();
        }
      }),
    );

  registerPlanCommands(program);
  registerShieldCommands(program);
  registerStyleCommands(program);
  registerToolCommands(program);
  registerRunCommands(program);
  registerSkillsCommands(program);
  registerAnalysisCommands(program);
  registerVaultCommands(registerTacticCommands(program));
  registerMediaCommands(program);

  program
    .command("tui")
    .description("open the interactive terminal app (also what plain `mdj` does in a terminal)")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const { launch } = await import("../tui/launch.js");
        await launch(opts.workspace ? { workspace: opts.workspace } : {});
      }),
    );
  registerBridgeCommands(program);
  registerShadowCommands(program);
  registerDemoCommands(program);

  return program;
}

export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
