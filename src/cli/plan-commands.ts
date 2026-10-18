import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { approvePlan, holdPlan, rejectPlan } from "../plan/approve.js";
import type { CompileInput } from "../plan/compile.js";
import { readPlanFile } from "../plan/files.js";
import { proposePlan } from "../plan/propose.js";
import { renderPlan } from "../plan/render.js";
import type { PlanState } from "../plan/repo.js";
import { strikePlan } from "../plan/strike.js";
import { cliActor, guarded, openPlanContext } from "./util.js";

const planNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a plan number`);
  return n;
};

interface ProposalFile {
  client?: string;
  origin?: CompileInput["origin"];
  proposals: CompileInput["proposals"];
  simulation?: CompileInput["simulation"];
  expires_in_hours?: number;
}

async function readProposalFile(path: string): Promise<ProposalFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read proposals from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as ProposalFile).proposals)) {
    throw new Error(`${path} must be a JSON object with a "proposals" array`);
  }
  return raw as ProposalFile;
}

export function registerPlanCommands(program: Command): void {
  const plan = program.command("plan").description("compile and inspect plans: the only route from a proposal to a platform");

  plan
    .command("new")
    .description("compile proposals into a policy-checked plan and store it as proposed")
    .requiredOption("--from <file>", 'JSON file: { "proposals": [...], "origin"?, "simulation"?, "client"?, "expires_in_hours"? }')
    .option("--workspace <dir>", "workspace folder")
    .option("--client <name>", "client name, overriding the file")
    .action((opts: { from: string; workspace?: string; client?: string }) =>
      guarded(async () => {
        const file = await readProposalFile(opts.from);
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          const client = opts.client ?? file.client;
          const { row, plan: compiled } = await proposePlan(ctx.deps, {
            workspace: ctx.workspaceId,
            ...(client ? { client } : {}),
            origin: file.origin ?? { job: "manual", finding_ids: [] },
            proposals: file.proposals,
            ...(file.simulation ? { simulation: file.simulation } : {}),
            ...(file.expires_in_hours ? { expiresInHours: file.expires_in_hours } : {}),
          });
          process.stdout.write(`${renderPlan(compiled, { number: row.number, state: row.state })}\n\nnext: mdj approve ${row.number}\n`);
        } finally {
          ctx.close();
        }
      }),
    );

  plan
    .command("list")
    .description("list plans and their states")
    .option("--workspace <dir>", "workspace folder")
    .option("--state <state>", "only plans in this state")
    .action((opts: { workspace?: string; state?: PlanState }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          const rows = ctx.deps.repo.list(opts.state);
          if (rows.length === 0) process.stdout.write("no plans\n");
          for (const r of rows) process.stdout.write(`#${r.number}  ${r.state.padEnd(10)} ${r.plan_id}  hash ${r.plan_hash.slice(0, 12)}  expires ${r.expires_at}\n`);
        } finally {
          ctx.close();
        }
      }),
    );

  const show = (number: string, opts: { workspace?: string }) =>
    guarded(async () => {
      const ctx = await openPlanContext(opts.workspace, false);
      try {
        const n = planNumber(number);
        const row = ctx.deps.repo.require(n);
        const compiled = await readPlanFile(ctx.deps.dir, row);
        process.stdout.write(`${renderPlan(compiled, { number: row.number, state: row.state })}\n`);
        const approvals = ctx.deps.repo.approvals(n);
        for (const a of approvals) process.stdout.write(`approved by ${a.approver} via ${a.channel} at ${a.ts}\n`);
        for (const r of ctx.deps.repo.actionResults(n)) process.stdout.write(`result ${r.action_id}: ${r.status}${r.detail ? ` (${r.detail})` : ""}\n`);
      } finally {
        ctx.close();
      }
    });
  plan.command("show <number>").description("show a plan with its checks, approvals and results").option("--workspace <dir>", "workspace folder").action(show);
  program.command("diff <number>").description("show a plan's dry-run diff (same as `plan show`)").option("--workspace <dir>", "workspace folder").action(show);

  program
    .command("approve <number>")
    .description("sign off a plan (CLI approval; high-risk plans need a second confirmation)")
    .option("--code <code>", "confirmation code from the first approve call")
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { code?: string; workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, true);
        try {
          const n = planNumber(number);
          const result = await approvePlan(ctx.deps, n, { approver: cliActor(), channel: "cli", ...(opts.code ? { confirmationCode: opts.code } : {}) });
          if (result.status === "confirmation_required") {
            process.stdout.write(
              `plan #${n} needs a second confirmation (high daily change or irreversible action).\nconfirmation code: ${result.code}  (valid until ${result.expiresAt})\nre-run: mdj approve ${n} --code ${result.code}\n`,
            );
            return;
          }
          process.stdout.write(`plan #${n} approved (hash ${result.row.plan_hash.slice(0, 12)}). next: mdj strike ${n}\n`);
        } finally {
          ctx.close();
        }
      }),
    );

  program
    .command("hold <number>")
    .description("keep a plan as a draft: nothing executes, and it can still be approved later")
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          await holdPlan(ctx.deps, planNumber(number), { actor: cliActor() });
          process.stdout.write(`plan #${number} held\n`);
        } finally {
          ctx.close();
        }
      }),
    );

  program
    .command("reject <number>")
    .description("reject a plan for good")
    .option("--reason <text>", "why")
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { reason?: string; workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          await rejectPlan(ctx.deps, planNumber(number), { actor: cliActor(), ...(opts.reason ? { reason: opts.reason } : {}) });
          process.stdout.write(`plan #${number} rejected\n`);
        } finally {
          ctx.close();
        }
      }),
    );

  program
    .command("strike <number>")
    .description("execute an approved plan through the Shield (export files in M1; live connectors in M2)")
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, true);
        try {
          const result = await strikePlan(ctx.deps, planNumber(number), { actor: cliActor() });
          process.stdout.write(`plan #${number}: ${result.state}\n`);
          for (const r of result.results) process.stdout.write(`  ${r.action_id}  ${r.status}${r.artifact ? `  -> ${r.artifact}` : ""}${r.detail ? `  (${r.detail})` : ""}\n`);
          process.stdout.write(`files: ${result.exportDir}\n`);
          return result.state === "exported" ? 0 : 1;
        } finally {
          ctx.close();
        }
      }),
    );
}
