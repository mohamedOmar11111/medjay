// The flagship closed loop on one workspace:
//   scout (ingest, calibrate) -> diagnose -> match a tactic -> plan with a seeded simulation check ->
//   approval gate -> strike (export) -> validate the export -> verify the ledger
// It uses the same code paths as the individual commands. The only demo-specific parts are the
// order, the printing, and an explicit --auto-approve (logged as channel "demo") for scripted runs.
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, type Diagnosis, type Finding } from "../analysis/diagnose.js";
import { scout } from "../analysis/scout.js";
import { loadUnitEconomics } from "../analysis/simulate.js";
import { Ledger, verifyLedger } from "../audit/ledger.js";
import { approvalPrompt, pulseCard } from "../bridge/outbound.js";
import { ingestDropzone } from "../ingest/ingest.js";
import { loadMappings } from "../ingest/mapping.js";
import { approvePlan } from "../plan/approve.js";
import { readPlanFile } from "../plan/files.js";
import { proposePlan, type PlanDeps } from "../plan/propose.js";
import { PlanRepo } from "../plan/repo.js";
import { renderPlan } from "../plan/render.js";
import { simulatePlan } from "../plan/simulate-plan.js";
import { ensureSigningKey } from "../plan/signing.js";
import { strikePlan } from "../plan/strike.js";
import { validateExport } from "../plan/validate.js";
import { PolicyViolationError } from "../plan/errors.js";
import { loadPolicy } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { loadTactics, saveTactic } from "../tactics/files.js";
import { hypothesize } from "../tactics/state.js";
import { initWorkspace } from "../workspace/init.js";
import { loadWorkspace } from "../workspace/load.js";
import type { KeyStore } from "../models/credentials.js";

export interface DemoOptions {
  /** Where the fixture lives (contains ingestion.mappings.yaml, data/, context/, tactics/). */
  fixtureDir: string;
  /** Workspace to create. Default: a new temp folder. */
  dir?: string;
  autoApprove: boolean;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface DemoReport {
  dir: string;
  stoppedAt: "approval" | "done";
  blendedMer: number | null;
  platformRoas: Record<string, number | null>;
  top: string[];
  matchedTactic: string | null;
  skippedTactics: string[];
  plans: { number: number; hash: string; state: string; note: string }[];
  scalePlan: { number: number; simulation: string | null; passes: boolean; approvalRefused: boolean } | null;
  exportValid: boolean | null;
  ledger: { ok: boolean; entries: number; head: string };
}

const memoryKeystore = (): KeyStore => {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), delete: async (k) => data.delete(k) };
};

interface PlatformIds {
  meta?: { adset?: Record<string, string> };
  google_ads?: { campaign?: Record<string, string> };
}

const money = (n: number) => Math.round(n).toLocaleString("en-US");

export async function runFlagship(options: DemoOptions): Promise<DemoReport> {
  const say = options.say ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "medjay-demo-")));
  const heading = (n: number, title: string) => say(`\n== ${n}. ${title} ==`);

  // ---- setup
  await mkdir(dir, { recursive: true });
  await initWorkspace({ dir, id: "etlaala-ksa", businessType: "agency", timezone: "Asia/Riyadh", baseCurrency: "SAR", primaryLanguage: "en" });
  await cp(options.fixtureDir, dir, { recursive: true, force: true });
  const { config, dropzoneDir } = await loadWorkspace(dir);
  const store = Store.open(join(dir, ".medjay", "experiments.db"));
  const ledgerFile = join(dir, ".medjay", "audit-log.jsonl");
  const ledger = new Ledger(ledgerFile, { now });
  const policy = await loadPolicy(dir);
  const signing = await ensureSigningKey({ dir, workspaceId: "etlaala-ksa", keystore: memoryKeystore(), env: {} });
  const plans: PlanDeps = { dir, repo: new PlanRepo(store), ledger, policy, signing, now };
  const ids = JSON.parse(await readFile(join(dir, "context", "platform-ids.json"), "utf8")) as PlatformIds;

  try {
    say(`Workspace ${dir}\n(synthetic etlaala-ksa data; the signing key for this demo is in memory and discarded when it ends)`);

    // ---- 1 scout
    heading(1, "Scout: ingest the exports and calibrate against the CRM");
    const mappings = await loadMappings(dir);
    const report = await ingestDropzone({ dropzoneDir, workspaceId: "etlaala-ksa", mappings, store, ledger, now, actor: "demo" });
    for (const f of report.files) say(`  ${f.status.padEnd(9)} ${f.file}: ${f.rows} rows${f.issues.length ? `, ${f.issues.length} issue(s)` : ""}`);
    const snapshot = scout({ store, mappings, baseCurrency: config.workspace.base_currency, timezone: config.workspace.timezone, now: now(), freshnessSlaHours: config.ingestion.freshness_sla_hours });
    const roas: Record<string, number | null> = Object.fromEntries(snapshot.platforms.map((p) => [p.platform, p.platform_roas]));
    say(`  Blended MER ${snapshot.totals.blended_mer} (CRM revenue / all spend). Google reports ROAS ${roas.google ?? "n/a"}: the platform claims ${roas.google && snapshot.totals.blended_mer ? (roas.google / snapshot.totals.blended_mer).toFixed(1) : "?"}x what the business earned.`);
    say(`  Match rate ${((snapshot.match.rate ?? 0) * 100).toFixed(1)}% of ${snapshot.totals.leads} CRM leads tied to a campaign.`);

    // ---- 2 diagnose
    heading(2, "Diagnose: rank the anomalies");
    const diagnosis: Diagnosis = diagnose(snapshot);
    diagnosis.findings.slice(0, 6).forEach((f, i) => say(`  ${i + 1}. [${f.severity}] ${f.title}`));
    const bleeding = diagnosis.findings.find((f) => f.kind === "bleeding_adset");
    const injection = diagnosis.findings.find((f) => f.kind === "instruction_like_text");
    if (injection) say(`  Warning: ${injection.title}. They are treated as data; nothing acted on them.`);

    // ---- 3 tactics
    heading(3, "Tactics: match the Tested-Tactics Log");
    const { tactics } = await loadTactics(dir);
    const kinds = new Set(diagnosis.findings.map((f) => f.kind));
    const candidates = tactics.filter((t) => t.tactic.matches.some((m) => kinds.has(m as Finding["kind"])));
    const skipped = candidates.filter((t) => t.tactic.state === "invalidated").map((t) => t.tactic.id);
    for (const id of skipped) say(`  ${id} matches a finding but was invalidated by an earlier test, so it is not proposed again.`);
    let matched: string | null = null;
    let experiment: { id: string; hypothesis: string; metric: string } | null = null;
    const usable = candidates.find((t) => t.tactic.state === "unverified" || t.tactic.state === "hypothesized");
    if (usable) {
      let tactic = usable.tactic;
      if (tactic.state === "unverified") {
        const period = snapshot.period as { start: string; end: string };
        tactic = hypothesize(tactic, {
          id: `EXP-${tactic.id.replace(/^TACTIC-/, "")}`,
          hypothesis: "Pausing ad sets with no CRM deal after five active days lowers cost per deal by at least 10%",
          metric: "cost_per_deal_sar",
          baseline: { value: snapshot.totals.cost_per_deal ?? 0, range: `${period.start}..${period.end}`, snapshot_id: `scout_${period.end.replaceAll("-", "")}` },
          design: { type: "before_after", min_sample: 25, duration_days: 14, min_effect: 0.1 },
        });
        await saveTactic(dir, tactic, usable.body);
        await ledger.append({ actor: "demo", event: "tactic.hypothesized", payload: { id: tactic.id, experiment: tactic.experiment!.id, metric: tactic.experiment!.metric, design: tactic.experiment!.design } });
        say(`  ${tactic.id} (${tactic.title}) was unverified. It is now hypothesized, bound to ${tactic.experiment!.id}: it needs 25 deals over 14 days before it can be called validated.`);
      } else say(`  ${tactic.id} is already hypothesized (${tactic.experiment!.id}).`);
      matched = tactic.id;
      experiment = { id: tactic.experiment!.id, hypothesis: tactic.experiment!.hypothesis, metric: tactic.experiment!.metric };
    } else say("  No usable tactic matched; the plan will not register an experiment.");

    // ---- 4 plan
    heading(4, "Plan: compile a deterministic, policy-checked diff");
    const adsetId = bleeding ? ids.meta?.adset?.[bleeding.evidence[0] ? bleedingName(bleeding) : ""] : undefined;
    if (!bleeding || !adsetId) throw new Error("the demo needs the bleeding ad set and its platform id (context/platform-ids.json)");
    const proposals: unknown[] = [
      { type: "status_change", target: { platform: "meta", kind: "adset", id: adsetId, name: bleedingName(bleeding) }, from: "ENABLED", to: "PAUSED" },
      ...(experiment && matched ? [{ type: "register_experiment", experiment_id: experiment.id, tactic_id: matched, hypothesis: experiment.hypothesis, metric: experiment.metric }] : []),
    ];
    const first = await proposePlan(plans, { workspace: "etlaala-ksa", origin: { job: "demo", finding_ids: [bleeding.id], ...(matched ? { tactic_id: matched } : {}), ...(experiment ? { experiment_id: experiment.id } : {}) }, proposals: proposals as never });
    say(renderPlan(first.plan, { number: first.row.number, state: first.row.state }).split("\n").map((l) => `  ${l}`).join("\n"));
    const planRows: DemoReport["plans"] = [{ number: first.row.number, hash: first.plan.plan_hash, state: first.row.state, note: "pause the bleeding ad set" }];

    // a scale-up of the best ad set: it must pass a seeded simulation to be approvable
    const economics = await loadUnitEconomics(dir);
    const best = snapshot.adsets.filter((a) => a.deals >= 5 && a.cost_per_deal !== null).sort((a, b) => (a.cost_per_deal ?? 0) - (b.cost_per_deal ?? 0))[0];
    const bestId = best ? ids.meta?.adset?.[best.adset] : undefined;
    let scalePlan: DemoReport["scalePlan"] = null;
    if (best && bestId) {
      const daily = Math.round((best.spend / (snapshot.period?.days ?? 7)) * 100) / 100;
      const second = await proposePlan(plans, {
        workspace: "etlaala-ksa",
        origin: { job: "demo", finding_ids: [] },
        proposals: [{ type: "budget_change", target: { platform: "meta", kind: "adset", id: bestId, name: best.adset }, from: daily, to: Math.round(daily * 1.15 * 100) / 100, currency: "SAR" }] as never,
      });
      say(`\n  A second plan raises "${best.adset}" (lowest cost per deal, SAR ${money(best.cost_per_deal ?? 0)}) by 15%. Scaling needs a passing simulation:`);
      const sim = await simulatePlan(plans, store, { planNumber: second.row.number, economics, attach: true, actor: "demo", observed: { cost_per_deal: snapshot.totals.cost_per_deal, blended_mer: snapshot.totals.blended_mer } });
      let refused = false;
      let simId: string | null = null;
      let passes = false;
      if (sim.kind === "done") {
        simId = sim.record.sim_id;
        passes = sim.passes;
        say(`  ${sim.record.sim_id} (seed ${sim.record.seed}): P10 ${sim.record.p10}, P50 ${sim.record.p50}, P90 ${sim.record.p90}, chance above zero ${(sim.record.p_positive * 100).toFixed(0)}% (policy needs ${(sim.minPositive * 100).toFixed(0)}%) -> ${sim.passes ? "PASSES" : "DOES NOT PASS"}.`);
      }
      if (!passes) {
        try {
          await approvePlan(plans, second.row.number, { approver: "demo", channel: "demo" });
        } catch (error) {
          refused = error instanceof PolicyViolationError;
          const why = error instanceof PolicyViolationError ? error.result.checks.filter((c) => c.ok === false).map((c) => c.note ?? c.rule).join("; ") : String(error);
          say(`  Approving plan #${second.row.number} is refused by policy: ${why}`);
        }
      }
      scalePlan = { number: second.row.number, simulation: simId, passes, approvalRefused: refused };
      planRows.push({ number: second.row.number, hash: second.plan.plan_hash, state: plans.repo.require(second.row.number).state, note: passes ? "scale-up (passes the simulation gate)" : "scale-up (blocked by the simulation gate)" });
    }

    // ---- 5 approval gate
    heading(5, "Approval gate");
    const prompt = approvalPrompt({ to: "+966000000000", row: first.row, plan: first.plan, head: await ledger.head() });
    say("  What the phone would show:");
    prompt.text.split("\n").forEach((l) => say(`  | ${l}`));
    say(`  Pulse card (WhatsApp, caveman lite):`);
    pulseCard({ workspace: "etlaala-ksa", snapshot, diagnosis, pending: plans.repo.list("proposed"), head: await ledger.head() })
      .split("\n")
      .forEach((l) => say(`  | ${l}`));

    let exportValid: boolean | null = null;
    let stoppedAt: DemoReport["stoppedAt"] = "approval";
    if (!options.autoApprove) {
      say(`\n  Stopped before approval, as the Shield requires. To continue by hand:\n    mdj approve ${first.row.number} --workspace "${dir}"\n    mdj strike ${first.row.number} --workspace "${dir}"\n  (or re-run the demo with --auto-approve)`);
    } else {
      heading(6, "Approve and strike (export only)");
      say("  --auto-approve: approved on channel \"demo\" and logged as such.");
      const approved = await approvePlan(plans, first.row.number, { approver: "demo", channel: "demo" });
      if (approved.status === "confirmation_required") throw new Error("the demo plan unexpectedly needs a second confirmation");
      const struck = await strikePlan(plans, first.row.number, { actor: "demo" });
      for (const r of struck.results) say(`  ${r.action_id}  ${r.status}${r.artifact ? `  -> ${r.artifact}` : ""}`);
      say(`  Files: ${struck.exportDir}. Nothing was sent to any ad platform.`);
      const plan = await readPlanFile(dir, plans.repo.require(first.row.number));
      const v = await validateExport({ dir, plan });
      exportValid = v.ok;
      say(`  Export validation: ${v.ok ? "VALID" : "INVALID"} (${v.checked.join(", ")}).`);
      planRows[0] = { ...(planRows[0] as DemoReport["plans"][number]), state: plans.repo.require(first.row.number).state };
      stoppedAt = "done";
    }

    // ---- ledger
    heading(stoppedAt === "done" ? 7 : 6, "Ledger");
    const verified = await verifyLedger(ledgerFile);
    if (!verified.ok) throw new Error(`ledger check failed: ${verified.failure.message}`);
    say(`  mdj ledger verify: OK, ${verified.entries} entries, head ${verified.head}`);
    say("  Compare this head with the one on your phone; if they differ, the log was changed after the message was sent.");

    return {
      dir,
      stoppedAt,
      blendedMer: snapshot.totals.blended_mer,
      platformRoas: roas,
      top: diagnosis.top,
      matchedTactic: matched,
      skippedTactics: skipped,
      plans: planRows,
      scalePlan,
      exportValid,
      ledger: { ok: true, entries: verified.entries, head: verified.head },
    };
  } finally {
    store.close();
  }
}

/** The ad set name a bleeding finding is about (its id is `bleeding_adset:<platform>:<slug>`; the name is in the title). */
function bleedingName(f: Finding): string {
  return f.title.replace(/ spent .* with no deal$/, "");
}
