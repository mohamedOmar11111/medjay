import type { Command } from "commander";
import { policyActions } from "../plan/compile.js";
import { readPlanFile } from "../plan/files.js";
import { checkPolicy } from "../shield/evaluate.js";
import { hashE164, loadPolicy } from "../shield/policy.js";
import { guarded, openPlanContext, workspaceDirOrThrow } from "./util.js";

export function registerShieldCommands(program: Command): void {
  const shield = program.command("shield").description("the guardrails: policy, approvers, limits");

  shield
    .command("check [plan]")
    .description("validate shield.policy.yaml; with a plan number, check that plan against the CURRENT policy")
    .option("--workspace <dir>", "workspace folder")
    .action((planArg: string | undefined, opts: { workspace?: string }) =>
      guarded(async () => {
        if (planArg === undefined) {
          const dir = await workspaceDirOrThrow(opts.workspace);
          const policy = await loadPolicy(dir);
          const cap = policy.limits.max_total_spend_cap;
          process.stdout.write(
            [
              "shield.policy.yaml is valid",
              `  budget increase limit: ${policy.limits.max_daily_budget_increase_pct}%   decrease limit: ${policy.limits.max_daily_budget_decrease_pct}%`,
              `  spend cap: ${cap ? `${cap.amount} ${cap.currency} per ${cap.period}` : "none"}`,
              `  forbidden actions: ${policy.forbidden_actions.length}   rules: ${policy.rules.length}   approvers: ${policy.whatsapp.approvers.length}`,
              `  circuit breakers: ${policy.circuit_breakers.rules.length} rules, ${policy.circuit_breakers.grant ? "grant present" : "no standing grant (breakers inactive)"}`,
              "",
            ].join("\n"),
          );
          return;
        }
        const ctx = await openPlanContext(opts.workspace, false);
        try {
          const n = Number(planArg);
          if (!Number.isInteger(n) || n < 1) throw new Error(`"${planArg}" is not a plan number`);
          const row = ctx.deps.repo.require(n);
          const plan = await readPlanFile(ctx.deps.dir, row);
          const result = checkPolicy(ctx.deps.policy, { ...(plan.client ? { client: plan.client } : {}), actions: policyActions(plan.actions) });
          process.stdout.write(`plan #${n} against the current policy: ${result.status === "pass" ? "PASS" : "FAIL"}${result.two_step_required ? " (two-step approval required)" : ""}\n`);
          for (const c of result.checks.filter((x) => x.ok !== true)) {
            process.stdout.write(`  ${c.ok === false ? "FAIL" : "unknown"}  ${c.rule}${c.action_id ? ` ${c.action_id}` : ""}: ${c.note ?? `limit ${c.limit}, actual ${c.actual}`}\n`);
          }
          return result.status === "pass" ? 0 : 1;
        } finally {
          ctx.close();
        }
      }),
    );

  shield
    .command("hash-number <e164>")
    .description("SHA-256 of an E.164 number for the approvers list (the number itself never goes in a file)")
    .action((e164: string) =>
      guarded(async () => {
        process.stdout.write(`${hashE164(e164)}\n`);
      }),
    );
}
