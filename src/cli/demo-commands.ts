import { join } from "node:path";
import type { Command } from "commander";
import { runFlagship } from "../demo/flagship.js";
import { guarded } from "./util.js";

// fixtures/ sits at the repository root, two levels above src/cli and dist/cli.
const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "etlaala-ksa");

export function registerDemoCommands(program: Command): void {
  program
    .command("demo")
    .description("run the flagship loop on the synthetic etlaala-ksa workspace: scout, diagnose, tactic, plan, simulation gate, approval gate, export, ledger")
    .option("--dir <dir>", "create the demo workspace here (default: a new temp folder)")
    .option("--auto-approve", "approve and strike the first plan without stopping (logged as channel \"demo\")")
    .option("--json", "print the final report as JSON instead of the walkthrough")
    .action((opts: { dir?: string; autoApprove?: boolean; json?: boolean }) =>
      guarded(async () => {
        const report = await runFlagship({
          fixtureDir: FIXTURE,
          autoApprove: Boolean(opts.autoApprove),
          ...(opts.dir ? { dir: opts.dir } : {}),
          say: opts.json ? () => undefined : (line) => process.stdout.write(`${line}\n`),
        });
        if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }),
    );
}
