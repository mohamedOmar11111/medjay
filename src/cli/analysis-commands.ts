import { join } from "node:path";
import type { Command } from "commander";
import { diagnose } from "../analysis/diagnose.js";
import { renderDiagnosis, renderIngest, renderSimulation, renderSnapshot } from "../analysis/render.js";
import { scout, type Snapshot } from "../analysis/scout.js";
import { loadUnitEconomics, simulate, type UnitEconomics } from "../analysis/simulate.js";
import { simulatePlan } from "../plan/simulate-plan.js";
import { Ledger } from "../audit/ledger.js";
import { ingestDropzone, type IngestReport } from "../ingest/ingest.js";
import { loadMappings } from "../ingest/mapping.js";
import { Store } from "../store/db.js";
import { loadWorkspace } from "../workspace/load.js";
import { cliActor, guarded, LEDGER_FILE, openPlanContext, STORE_FILE, workspaceDirOrThrow } from "./util.js";

export interface Opened {
  dir: string;
  store: Store;
  ledger: Ledger;
  currency: string;
  timezone: string;
  freshnessSlaHours: number;
  ingest: () => Promise<IngestReport>;
  snapshot: (days: number) => Snapshot;
  close: () => void;
}

export async function openAnalysis(workspaceOption: string | undefined): Promise<Opened> {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config, dropzoneDir } = await loadWorkspace(dir);
  const mappings = await loadMappings(dir);
  const store = Store.open(join(dir, STORE_FILE));
  const ledger = new Ledger(join(dir, LEDGER_FILE));
  const currency = config.workspace.base_currency;
  const timezone = config.workspace.timezone;
  const freshnessSlaHours = config.ingestion.freshness_sla_hours;
  return {
    dir,
    store,
    ledger,
    currency,
    timezone,
    freshnessSlaHours,
    ingest: () => ingestDropzone({ dropzoneDir, workspaceId: config.workspace.id, mappings, store, ledger, now: () => new Date(), actor: cliActor() }),
    snapshot: (days) => scout({ store, mappings, baseCurrency: currency, timezone, now: new Date(), days, freshnessSlaHours }),
    close: () => store.close(),
  };
}

const parseDays = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("--days must be a whole number from 1 to 365");
  return n;
};
const parseNumber = (name: string) => (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

const out = (text: string) => process.stdout.write(`${text}\n`);

export function registerAnalysisCommands(program: Command): void {
  program
    .command("scout")
    .description("read the dropzone, normalize it, and show a cross-channel snapshot calibrated against CRM truth")
    .option("--days <n>", "window ending at the newest ad data", parseDays, 7)
    .option("--no-ingest", "use what is already stored; do not re-read the dropzone")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { days: number; ingest: boolean; json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const w = await openAnalysis(opts.workspace);
        try {
          const report = opts.ingest ? await w.ingest() : undefined;
          const snapshot = w.snapshot(opts.days);
          if (opts.json) out(JSON.stringify({ ingest: report ?? null, snapshot }, null, 2));
          else out([...(report ? [renderIngest(report), ""] : []), renderSnapshot(snapshot)].join("\n"));
          return report?.files.some((f) => f.status === "rejected") ? 1 : 0;
        } finally {
          w.close();
        }
      }),
    );

  program
    .command("diagnose")
    .description("find the top anomalies (wasted spend, over-attribution, funnel drop-off) with source and date for each")
    .option("--days <n>", "window ending at the newest ad data", parseDays, 7)
    .option("--no-ingest", "use what is already stored; do not re-read the dropzone")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { days: number; ingest: boolean; json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const w = await openAnalysis(opts.workspace);
        try {
          const report = opts.ingest ? await w.ingest() : undefined;
          const diagnosis = diagnose(w.snapshot(opts.days));
          await w.ledger.append({
            actor: cliActor(),
            event: "diagnose.completed",
            payload: { period: diagnosis.period, findings: diagnosis.findings.map((f) => ({ id: f.id, severity: f.severity })), top: diagnosis.top },
          });
          if (opts.json) out(JSON.stringify(diagnosis, null, 2));
          else out([...(report?.files.some((f) => f.status === "rejected") ? [renderIngest(report), ""] : []), renderDiagnosis(diagnosis)].join("\n"));
        } finally {
          w.close();
        }
      }),
    );

  program
    .command("simulate")
    .description("funnel math from context/unit-economics.md: scenarios, seeded Monte Carlo, break-even, sensitivity; --plan <n> gates a budget increase")
    .option("--plan <number>", "simulate the budget increase in this proposed plan and attach the result (a passing simulation is needed to approve a scale plan)", planNumber)
    .option("--no-attach", "with --plan: report only, do not create the revised plan")
    .option("--spend <amount>", "spend to simulate (default: the scout window's total spend)", parseNumber("--spend"))
    .option("--scale-pct <pct>", "also test scaling spend by this percent, e.g. 50", parseNumber("--scale-pct"))
    .option("--elasticity <x>", "how fast CPC rises with spend (an assumption), 0 to 2", parseNumber("--elasticity"))
    .option("--seed <n>", "Monte Carlo seed (default 42; with --plan, derived from the plan hash)", parseNumber("--seed"))
    .option("--draws <n>", "Monte Carlo draws (default 10000)", parseNumber("--draws"))
    .option("--horizon-days <n>", "with --plan: days the daily budgets run for", parseDays, 7)
    .option("--days <n>", "scout window used for the default spend and the comparison", parseDays, 7)
    .option("--no-ingest", "use what is already stored; do not re-read the dropzone")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: SimulateOptions) =>
      guarded(async () => {
        const w = await openAnalysis(opts.workspace);
        try {
          if (opts.ingest) await w.ingest();
          const snapshot = w.snapshot(opts.days);
          const economics = await loadUnitEconomics(w.dir);
          if (economics.problems.length === 0 && economics.currency !== w.currency) {
            throw new Error(`context/unit-economics.md is in ${economics.currency} but the workspace base currency is ${w.currency}; Medjay never converts silently`);
          }
          const observed = snapshot.status === "ok" ? { cost_per_deal: snapshot.totals.cost_per_deal, blended_mer: snapshot.totals.blended_mer } : undefined;
          if (opts.plan !== undefined) return await simulateForPlan(w, opts, economics, observed);

          const spend = opts.spend ?? (snapshot.status === "ok" ? snapshot.totals.spend : undefined);
          if (spend === undefined) throw new Error("no spend to simulate: pass --spend or ingest ad data first");
          const result = simulate(economics, {
            spend,
            ...(opts.scalePct === undefined ? {} : { scalePct: opts.scalePct }),
            ...(opts.elasticity === undefined ? {} : { elasticity: opts.elasticity }),
            ...(opts.seed === undefined ? {} : { seed: opts.seed }),
            ...(opts.draws === undefined ? {} : { draws: opts.draws }),
            observed,
          });
          await w.ledger.append({
            actor: cliActor(),
            event: "simulation.completed",
            payload: {
              status: result.status,
              spend,
              ...(opts.scalePct === undefined ? {} : { scale_pct: opts.scalePct }),
              ...(result.status === "ok"
                ? { base_contribution: result.scenarios[1]?.outcome.contribution, seed: result.monte_carlo.seed, p50: result.monte_carlo.p50, p_positive: result.monte_carlo.p_positive }
                : { problems: result.problems.map((p) => p.input) }),
            },
          });
          out(opts.json ? JSON.stringify(result, null, 2) : renderSimulation(result, w.currency));
          return result.status === "ok" ? 0 : 1;
        } finally {
          w.close();
        }
      }),
    );
}

interface SimulateOptions {
  plan?: number;
  attach: boolean;
  spend?: number;
  scalePct?: number;
  elasticity?: number;
  seed?: number;
  draws?: number;
  horizonDays: number;
  days: number;
  ingest: boolean;
  json?: boolean;
  workspace?: string;
}

const planNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a plan number`);
  return n;
};

/** Simulate the budget increase a proposed plan makes; when it passes the gate, attach it as a new revision of the plan. */
async function simulateForPlan(w: Opened, opts: SimulateOptions, economics: UnitEconomics, observed: { cost_per_deal: number | null; blended_mer: number | null } | undefined): Promise<number> {
  const ctx = await openPlanContext(w.dir, false);
  try {
    const outcome = await simulatePlan(ctx.deps, w.store, {
      planNumber: opts.plan as number,
      economics,
      observed,
      horizonDays: opts.horizonDays,
      attach: opts.attach,
      actor: cliActor(),
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
      ...(opts.draws === undefined ? {} : { draws: opts.draws }),
      ...(opts.elasticity === undefined ? {} : { elasticity: opts.elasticity }),
    });
    if (outcome.kind === "not_applicable") {
      out(outcome.message);
      return outcome.needed ? 1 : 0;
    }
    if (outcome.kind === "insufficient_inputs") {
      out(opts.json ? JSON.stringify(outcome.result, null, 2) : renderSimulation(outcome.result, w.currency));
      return 1;
    }
    const { record, passes, minPositive: min, attachedAs, result } = outcome;
    const lines = [renderSimulation(result, w.currency)];
    lines.push("", `Simulation ${record.sim_id} for plan #${opts.plan}: P(above zero) ${(record.p_positive * 100).toFixed(0)}% (policy needs ${(min * 100).toFixed(0)}% and a positive P50) - ${passes ? "PASSES" : "DOES NOT PASS"}.`);
    if (!passes) lines.push("The plan was left as it is. Lower the budget increase, or update context/unit-economics.md if its inputs are out of date, then simulate again.");
    else if (!opts.attach) lines.push(`Not attached (--no-attach). Cite it in a proposals file as "simulation": { "id": "${record.sim_id}" }.`);
    else lines.push(`Plan #${opts.plan} is superseded by plan #${attachedAs}, which carries this simulation. next: mdj approve ${attachedAs}`);
    out(opts.json ? JSON.stringify({ simulation: record, passes, attached_as_plan: attachedAs, result }, null, 2) : lines.join("\n"));
    return passes ? 0 : 1;
  } finally {
    ctx.close();
  }
}
