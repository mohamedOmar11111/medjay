import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { Option } from "commander";
import { bindingProblem, SimulationRepo, refOf, type BudgetMove } from "../analysis/sim-repo.js";
import { approvePlan, holdPlan, rejectPlan } from "../plan/approve.js";
import type { CompileInput } from "../plan/compile.js";
import { readPlanFile } from "../plan/files.js";
import { proposePlan } from "../plan/propose.js";
import { renderPlan } from "../plan/render.js";
import type { PlanState } from "../plan/repo.js";
import { strikePlan } from "../plan/strike.js";
import { validateExport } from "../plan/validate.js";
import { parseObserved } from "../plan/observed.js";
import { rollbackPlan } from "../plan/rollback.js";
import { sha256, verifyPlan } from "../plan/verify.js";
import { Store } from "../store/db.js";
import { cliActor, guarded, openPlanContext, STORE_FILE } from "./util.js";
import { join } from "node:path";

const planNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a plan number`);
  return n;
};

interface ProposalFile {
  client?: string;
  origin?: CompileInput["origin"];
  proposals: CompileInput["proposals"];
  /** Only { id } of a stored simulation (`mdj simulate --plan`); numbers typed into a file are not accepted. */
  simulation?: { id: string };
  expires_in_hours?: number;
}

/** Look the simulation up in the store and check it was run for exactly these budget moves. */
async function resolveSimulation(dir: string, cited: unknown, proposals: CompileInput["proposals"]): Promise<CompileInput["simulation"]> {
  const keys = typeof cited === "object" && cited !== null ? Object.keys(cited) : [];
  const id = (cited as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || keys.length !== 1) {
    throw new Error('"simulation" must be exactly { "id": "sim_..." }, the id printed by `mdj simulate --plan`; typed-in numbers are not accepted');
  }
  const store = Store.open(join(dir, STORE_FILE));
  try {
    const record = new SimulationRepo(store).require(id);
    const moves = proposals.flatMap((p): BudgetMove[] => (p.type === "budget_change" ? [{ from: p.from, to: p.to, currency: p.currency }] : []));
    const problem = bindingProblem(record, moves);
    if (problem) throw new Error(problem);
    return refOf(record);
  } finally {
    store.close();
  }
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
          const simulation = file.simulation === undefined ? undefined : await resolveSimulation(ctx.deps.dir, file.simulation, file.proposals);
          const { row, plan: compiled } = await proposePlan(ctx.deps, {
            workspace: ctx.workspaceId,
            ...(client ? { client } : {}),
            origin: file.origin ?? { job: "manual", finding_ids: [] },
            proposals: file.proposals,
            ...(simulation ? { simulation } : {}),
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
    .command("verify <number>")
    .description("compare what the platform now shows with what a struck plan said it should (from a file you export after importing)")
    .requiredOption("--observed <file>", "a JSON list of observations, or a Google Ads Editor export (.csv)")
    .addOption(new Option("--format <format>", "observed file format (default: from the extension)").choices(["json", "google-editor-csv"]))
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { observed: string; format?: "json" | "google-editor-csv"; workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          const n = planNumber(number);
          const text = await readFile(opts.observed, "utf8");
          const observations = parseObserved(text, opts.format ?? (opts.observed.toLowerCase().endsWith(".csv") ? "google-editor-csv" : "json"));
          const { row, report } = await verifyPlan(ctx.deps, n, observations, { actor: cliActor(), observedSha256: sha256(text) });
          process.stdout.write(`plan #${n}: ${report.all_verified ? "VERIFIED" : "NOT VERIFIED"} (${row.state})\n`);
          for (const r of report.results) {
            const word = { verified: "ok", mismatch: "MISMATCH", not_observed: "NOT SEEN", manual: "manual" }[r.status];
            process.stdout.write(`  ${r.action_id}  ${r.type.padEnd(24)} ${word}${r.detail ? `  ${r.detail}` : ""}\n`);
          }
          if (!report.all_verified) process.stdout.write(`If the platform is wrong, fix it by hand or roll the plan back: mdj rollback ${n}\n`);
          return report.all_verified ? 0 : 1;
        } finally {
          ctx.close();
        }
      }),
    );

  program
    .command("rollback <number>")
    .description("compile a new plan that undoes a struck plan (exact inverses); it still needs approval and a strike")
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          const n = planNumber(number);
          const { row, plan: compiled, skipped } = await rollbackPlan(ctx.deps, n, { actor: cliActor() });
          process.stdout.write(`${renderPlan(compiled, { number: row.number, state: row.state })}\n`);
          for (const s of skipped) process.stdout.write(`not undone: ${s.action_id}: ${s.reason}\n`);
          process.stdout.write(`\nnext: mdj approve ${row.number}, then mdj strike ${row.number}. Plan #${n} is marked rolled back once that strike succeeds.\n`);
        } finally {
          ctx.close();
        }
      }),
    );

  program
    .command("validate-export <number>")
    .description("check a plan's export files: well formed, and still exactly what the approved plan produces")
    .option("--workspace <dir>", "workspace folder")
    .action((number: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          const n = planNumber(number);
          const plan = await readPlanFile(ctx.deps.dir, ctx.deps.repo.require(n));
          const v = await validateExport({ dir: ctx.deps.dir, plan, ...(ctx.deps.drafts ? { drafts: ctx.deps.drafts } : {}) });
          process.stdout.write(`plan #${n}: export ${v.ok ? "VALID" : "INVALID"} (checked ${v.checked.join(", ") || "nothing"})\n`);
          for (const i of v.issues) process.stdout.write(`  ${i.file}${i.row ? ` row ${i.row}` : ""}: ${i.message}\n`);
          if (v.ok) process.stdout.write("Medjay checks its own reading of the formats; try the Editor file in a test account before using it on a live one.\n");
          return v.ok ? 0 : 1;
        } finally {
          ctx.close();
        }
      }),
    );

  program
    .command("strike <number>")
    .description("execute an approved plan through the Shield (writes export files; there are no live connectors yet)")
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
