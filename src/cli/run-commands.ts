import type { Command } from "commander";
import { Option } from "commander";
import { SLOT_NAMES, USAGE_SURFACES, type SlotName, type UsageSurface } from "../constants.js";
import { NO_MODEL, openRun } from "../runtime/loop/open.js";
import { RunRepo, RUN_STATUSES, type RunHeader, type RunStatus, type StepRecord } from "../runtime/loop/repo.js";
import { resumeRun } from "../runtime/loop/resume.js";
import { startRun, type RunResult } from "../runtime/loop/run.js";
import { cliActor, guarded, workspaceDirOrThrow } from "./util.js";

const EXIT: Record<RunStatus, number> = {
  completed: 0,
  needs_human: 2,
  max_steps_reached: 3,
  max_tokens_reached: 3,
  max_cost_reached: 3,
  aborted: 130,
  failed: 1,
  running: 1,
};

/** Ctrl+C aborts the run cleanly: it is saved as resumable instead of being lost. */
function abortOnInterrupt(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const handler = () => controller.abort();
  process.once("SIGINT", handler);
  return { signal: controller.signal, dispose: () => process.off("SIGINT", handler) };
}

const usd = (n: number, known: boolean) => `$${n.toFixed(4)}${known ? "" : " (some prices unknown)"}`;

function printResult(result: RunResult): void {
  const out = process.stdout;
  if (result.finalText) out.write(`\n${result.finalText}\n`);
  out.write(`\nrun ${result.runId}: ${result.status} after ${result.steps} step(s), ${result.tokens.input + result.tokens.output} tokens, ${usd(result.costUsd, result.costKnown)}\n`);
  if (result.proposals.length > 0) out.write(`${result.proposals.length} proposal(s) ready: \`mdj runs proposals ${result.runId}\`\n`);
  if (result.status === "needs_human" && result.pending) {
    out.write(`waiting for a human: ${result.pending.tool} (${result.pending.callId}). Allow it in shield.policy.yaml, or: mdj resume ${result.runId} --approve-tool ${result.pending.callId}\n`);
  } else if (result.status === "aborted" || result.status === "failed") {
    out.write(`${result.error ? `${result.error.kind}: ${result.error.message}\n` : ""}continue with: mdj resume ${result.runId}\n`);
  } else if (result.status.startsWith("max_")) {
    out.write("run stopped at a cap in shield.policy.yaml (runtime_limits); it was not lost, see `mdj runs show`\n");
  }
}

function printHeader(run: RunHeader): string {
  const when = run.updated_at.replace("T", " ").slice(0, 19);
  return `${run.run_id}  ${run.status.padEnd(18)} ${String(run.steps_done).padStart(2)} steps  ${String(run.input_tokens + run.output_tokens).padStart(8)} tok  ${usd(run.cost_usd, run.cost_known).padEnd(10)} ${run.surface.padEnd(18)} ${when}  ${run.task.slice(0, 50).replace(/\s+/g, " ")}`;
}

function printStep(step: StepRecord): string {
  const calls = step.tool_calls.map((c) => {
    const r = step.tool_results.find((x) => x.call_id === c.call_id);
    const state = !r ? "not run" : r.status === "done" ? (r.ok ? "ok" : `failed: ${r.error?.kind}`) : r.status;
    return `    ${c.call_id} ${c.name} ${JSON.stringify(c.input)} -> ${state}`;
  });
  const text = step.assistant_text.trim().replace(/\s+/g, " ").slice(0, 160);
  return [`  step ${step.step_index} [${step.phase}] ${step.model.provider}/${step.model.model} ${step.usage.inputTokens}+${step.usage.outputTokens} tok${step.nudge ? " (wrap-up nudge)" : ""}`, ...(text ? [`    says: ${text}`] : []), ...calls].join("\n");
}

export function registerRunCommands(program: Command): void {
  program
    .command("run <task>")
    .description("run the agent on a task: it reads your workspace, proposes plans, and never writes to a platform")
    .addOption(new Option("--surface <surface>", "where the answer goes (sets tone and usage tag)").choices(USAGE_SURFACES).default("diagnosis"))
    .addOption(new Option("--slot <slot>", "model slot").choices(SLOT_NAMES).default("reasoning"))
    .option("--workspace <dir>", "workspace folder")
    .action((task: string, opts: { surface: UsageSurface; slot: SlotName; workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const opened = await openRun({ dir, slot: opts.slot, actor: cliActor() });
        const interrupt = abortOnInterrupt();
        try {
          const result = await startRun(opened.deps, { task, surface: opts.surface, slot: opts.slot }, interrupt.signal);
          printResult(result);
          return EXIT[result.status];
        } finally {
          interrupt.dispose();
          opened.close();
        }
      }),
    );

  program
    .command("resume <run_id>")
    .description("continue an interrupted, failed or waiting run from its last saved step (finished steps are never re-run or re-billed)")
    .option("--approve-tool <call_id>", "approve exactly this pending call, once")
    .option("--workspace <dir>", "workspace folder")
    .action((runId: string, opts: { approveTool?: string; workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const probe = await openRun({ dir, slot: "reasoning", actor: cliActor(), driver: NO_MODEL });
        const slot = new RunRepo(probe.store).get(runId)?.slot ?? "reasoning";
        probe.close();
        const opened = await openRun({ dir, slot, actor: cliActor() });
        const interrupt = abortOnInterrupt();
        try {
          const result = await resumeRun(opened.deps, runId, opts.approveTool ? { approveTool: opts.approveTool } : {}, interrupt.signal);
          printResult(result);
          return EXIT[result.status];
        } finally {
          interrupt.dispose();
          opened.close();
        }
      }),
    );

  const runs = program.command("runs").description("saved agent runs");

  runs
    .command("list")
    .description("list runs, newest first")
    .addOption(new Option("--status <status>", "only runs in this state").choices(RUN_STATUSES))
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { status?: RunStatus; json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const opened = await openRun({ dir: await workspaceDirOrThrow(opts.workspace), slot: "reasoning", driver: NO_MODEL });
        try {
          const list = new RunRepo(opened.store).list(opts.status);
          if (opts.json) process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
          else process.stdout.write(list.length === 0 ? "no runs yet\n" : `${list.map(printHeader).join("\n")}\n`);
        } finally {
          opened.close();
        }
      }),
    );

  runs
    .command("show <run_id>")
    .description("one run: status, limits, and every saved step with its tool calls")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((runId: string, opts: { json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const opened = await openRun({ dir: await workspaceDirOrThrow(opts.workspace), slot: "reasoning", driver: NO_MODEL });
        try {
          const repo = new RunRepo(opened.store);
          const run = repo.require(runId);
          const steps = repo.steps(runId);
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({ run, steps }, null, 2)}\n`);
            return;
          }
          const out = process.stdout;
          out.write(`${printHeader(run)}\n`);
          out.write(`  limits: ${run.limits.max_steps} steps, ${run.limits.max_tokens} tokens, $${run.limits.max_cost_usd}   policy ${run.policy_hash.slice(0, 12)}\n`);
          if (run.stop_reason) out.write(`  stopped: ${run.stop_reason}${run.error ? ` (${run.error.message})` : ""}\n`);
          if (run.pending) out.write(`  waiting on: ${run.pending.tool} ${run.pending.callId}\n`);
          out.write(`${steps.map(printStep).join("\n")}\n`);
          if (run.final_text) out.write(`\n${run.final_text}\n`);
        } finally {
          opened.close();
        }
      }),
    );

  runs
    .command("proposals <run_id>")
    .description("the run's latest proposals as JSON, ready for `mdj plan new --from`")
    .option("--workspace <dir>", "workspace folder")
    .action((runId: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const opened = await openRun({ dir: await workspaceDirOrThrow(opts.workspace), slot: "reasoning", driver: NO_MODEL });
        try {
          const { collectProposals } = await import("../runtime/loop/run.js");
          const repo = new RunRepo(opened.store);
          repo.require(runId);
          process.stdout.write(`${JSON.stringify(collectProposals(repo.steps(runId)), null, 2)}\n`);
        } finally {
          opened.close();
        }
      }),
    );
}
