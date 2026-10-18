import { join } from "node:path";
import type { Command } from "commander";
import { runFlagship } from "../demo/flagship.js";
import { guarded } from "./util.js";

// fixtures/ sits at the repository root, two levels above src/cli and dist/cli.
const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "etlaala-ksa");

function clockFor(asOf: string): () => Date {
  if (asOf === "now") return () => new Date();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? new Date(`${asOf}T07:00:00.000Z`) : new Date(asOf);
  if (Number.isNaN(date.getTime())) throw new Error(`cannot read --as-of "${asOf}"; use a date like 2026-10-17, or "now"`);
  return () => date;
}

export function registerDemoCommands(program: Command): void {
  program
    .command("demo")
    .description("run the flagship loop on the synthetic etlaala-ksa workspace: scout, diagnose, tactic, plan, simulation gate, approval gate, export, ledger")
    .option("--dir <dir>", "create the demo workspace here (default: a new temp folder)")
    .option("--auto-approve", "approve and strike the first plan without stopping (logged as channel \"demo\")")
    .option("--as-of <date>", "the demo's clock: a date such as 2026-10-17, or \"now\" for the real clock (default: the morning after the fixture's last day, so the data never looks stale)")
    .option("--json", "print the final report as JSON instead of the walkthrough")
    .action((opts: { dir?: string; autoApprove?: boolean; asOf?: string; json?: boolean }) =>
      guarded(async () => {
        const report = await runFlagship({
          fixtureDir: FIXTURE,
          autoApprove: Boolean(opts.autoApprove),
          ...(opts.asOf === undefined ? {} : { now: clockFor(opts.asOf) }),
          ...(opts.dir ? { dir: opts.dir } : {}),
          say: opts.json ? () => undefined : (line) => process.stdout.write(`${line}\n`),
        });
        if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }),
    );
}
