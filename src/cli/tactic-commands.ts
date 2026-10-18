import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { Ledger } from "../audit/ledger.js";
import { INDEX_FILE, loadTactics, renderIndex, saveTactic, TACTICS_DIR, type TacticFile } from "../tactics/files.js";
import { TACTIC_STATES, TacticSchema, type Tactic, type TacticState } from "../tactics/schema.js";
import { conclude, hypothesize, retire } from "../tactics/state.js";
import { cliActor, guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

const num = (name: string) => (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
const out = (text: string) => process.stdout.write(`${text}\n`);

async function find(dir: string, id: string): Promise<TacticFile> {
  const { tactics, problems } = await loadTactics(dir);
  const hit = tactics.find((t) => t.tactic.id === id);
  if (!hit) {
    const broken = problems.find((p) => p.file === `${id}.md`);
    throw new Error(broken ? `${broken.file} cannot be read: ${broken.message}` : `no tactic ${id}; see \`mdj tactic list\``);
  }
  return hit;
}

function summary(t: Tactic): string {
  const lines = [`${t.id}  [${t.state}]  ${t.title}`, `  source: ${t.source.kind}, ${t.source.ref} (${t.source.date})`];
  if (t.tags.markets.length) lines.push(`  markets: ${t.tags.markets.join(", ")}   verticals: ${t.tags.verticals.join(", ") || "-"}`);
  if (t.experiment) {
    const e = t.experiment;
    lines.push(`  experiment ${e.id}: ${e.hypothesis}`, `    metric ${e.metric}, baseline ${e.baseline.value} (${e.baseline.range}, ${e.baseline.snapshot_id})`, `    design ${e.design.type}: at least ${e.design.min_sample} samples over ${e.design.duration_days} days, minimum effect ${(e.design.min_effect * 100).toFixed(0)}%`);
    if (e.interim.length) lines.push(`    ${e.interim.length} interim reading(s), not counted as proof`);
  }
  if (t.result) {
    const r = t.result;
    lines.push(`  result: effect ${(r.effect * 100).toFixed(1)}%, confidence ${r.confidence} (${r.method}), n=${r.sample_size}, ${r.date_range}, ${r.outcome_source}${r.grading === "proxy" ? " [proxy grading]" : ""}`);
    if (r.caveats.length) lines.push(`    caveats: ${r.caveats.join("; ")}`);
  }
  if (t.retired) lines.push(`  retired ${t.retired.date}: ${t.retired.reason}`);
  return lines.join("\n");
}

export function registerTacticCommands(program: Command): void {
  const tactic = program.command("tactic").description("the Tested-Tactics Log: unverified, hypothesized (bound to an experiment), validated or invalidated");
  const ws = (c: Command) => c.option("--workspace <dir>", "workspace folder");

  ws(tactic.command("list").description("list tactics by state").addOption(new Option("--state <state>", "only this state").choices(TACTIC_STATES))).action((opts: { state?: TacticState; workspace?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const { tactics, problems } = await loadTactics(dir);
      const rows = tactics.filter((t) => !opts.state || t.tactic.state === opts.state);
      out(rows.length ? rows.map((t) => `${t.tactic.id.padEnd(22)} ${t.tactic.state.padEnd(13)} ${t.tactic.title}`).join("\n") : "no tactics yet");
      for (const p of problems) process.stderr.write(`warning: ${p.file}: ${p.message}\n`);
      return problems.length ? 1 : 0;
    }),
  );

  ws(tactic.command("show <id>").description("one tactic with its experiment and result")).action((id: string, opts: { workspace?: string }) =>
    guarded(async () => {
      out(summary((await find(await workspaceDirOrThrow(opts.workspace), id)).tactic));
    }),
  );

  ws(
    tactic
      .command("new")
      .description("add an unverified tactic from a source")
      .requiredOption("--id <id>", "e.g. TACTIC-MENA-019")
      .requiredOption("--title <text>", "what the tactic is")
      .addOption(new Option("--source-kind <kind>", "where it came from").choices(["vendor", "practitioner", "own_test"]).makeOptionMandatory())
      .requiredOption("--source-ref <text>", "a URL, an author or an experiment id")
      .requiredOption("--source-date <date>", "YYYY-MM-DD")
      .option("--pillar <n>", "growth pillar number (repeatable)", (v, p: number[] = []) => [...p, Number(v)])
      .option("--market <code>", "market tag, e.g. KSA (repeatable)", collect)
      .option("--vertical <name>", "vertical tag, e.g. travel (repeatable)", collect)
      .option("--playbook <text>", "short playbook text for the file body"),
  ).action((opts: { id: string; title: string; sourceKind: "vendor" | "practitioner" | "own_test"; sourceRef: string; sourceDate: string; pillar?: number[]; market?: string[]; vertical?: string[]; playbook?: string; workspace?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      if (await stat(join(dir, TACTICS_DIR, `${opts.id}.md`)).then(() => true, () => false)) throw new Error(`tactic ${opts.id} already exists`);
      const t = TacticSchema.parse({
        id: opts.id,
        title: opts.title,
        source: { kind: opts.sourceKind, ref: opts.sourceRef, date: opts.sourceDate },
        state: "unverified",
        pillars: opts.pillar ?? [],
        tags: { markets: opts.market ?? [], verticals: opts.vertical ?? [] },
      });
      await saveTactic(dir, t, opts.playbook ? `# ${t.title}\n\n${opts.playbook}\n` : `# ${t.title}\n`);
      await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "tactic.created", payload: { id: t.id, source: t.source.kind } });
      out(`added ${t.id} as unverified. next: mdj tactic hypothesize ${t.id} --experiment <id> ...`);
    }),
  );

  ws(
    tactic
      .command("hypothesize <id>")
      .description("pre-register an experiment for an unverified tactic (needs a metric, a baseline and a design with a minimum sample, duration and effect)")
      .requiredOption("--experiment <id>", "experiment id, e.g. EXP-088")
      .requiredOption("--hypothesis <text>", "what you expect and by how much")
      .requiredOption("--metric <name>", "the metric the result is graded on")
      .requiredOption("--baseline-value <n>", "the metric's value before the test", num("--baseline-value"))
      .requiredOption("--baseline-range <a..b>", "dates the baseline covers, YYYY-MM-DD..YYYY-MM-DD")
      .requiredOption("--baseline-snapshot <id>", "a label for the baseline snapshot, e.g. snap_88")
      .addOption(new Option("--design <type>", "test design").choices(["before_after", "holdout", "ab"]).makeOptionMandatory())
      .requiredOption("--min-sample <n>", "minimum samples before a verdict", num("--min-sample"))
      .requiredOption("--duration-days <n>", "minimum days before a verdict", num("--duration-days"))
      .requiredOption("--min-effect <x>", "smallest relative effect worth acting on, e.g. 0.15", num("--min-effect")),
  ).action((id: string, opts: { experiment: string; hypothesis: string; metric: string; baselineValue: number; baselineRange: string; baselineSnapshot: string; design: "before_after" | "holdout" | "ab"; minSample: number; durationDays: number; minEffect: number; workspace?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const { tactic: before, body } = await find(dir, id);
      const after = hypothesize(before, {
        id: opts.experiment,
        hypothesis: opts.hypothesis,
        metric: opts.metric,
        baseline: { value: opts.baselineValue, range: opts.baselineRange, snapshot_id: opts.baselineSnapshot },
        design: { type: opts.design, min_sample: opts.minSample, duration_days: opts.durationDays, min_effect: opts.minEffect },
      });
      await saveTactic(dir, after, body);
      await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "tactic.hypothesized", payload: { id, experiment: opts.experiment, metric: opts.metric, design: after.experiment!.design } });
      out(`${id} is hypothesized and bound to ${opts.experiment}. A verdict needs ${opts.minSample} samples over ${opts.durationDays} days. next: mdj tactic conclude ${id} ...`);
    }),
  );

  ws(
    tactic
      .command("conclude <id>")
      .description("record a test result; the tactic is validated or invalidated only if the test was big and long enough and the confidence is decisive")
      .requiredOption("--confidence <p>", "probability the true effect is at least the minimum effect (0 to 1)", num("--confidence"))
      .addOption(new Option("--method <m>", "how the confidence was computed").choices(["bayesian", "frequentist"]).makeOptionMandatory())
      .requiredOption("--sample-size <n>", "samples in the test", num("--sample-size"))
      .requiredOption("--date-range <a..b>", "dates the test ran, YYYY-MM-DD..YYYY-MM-DD")
      .requiredOption("--effect <x>", "observed relative effect, e.g. 0.31 for +31%", num("--effect"))
      .addOption(new Option("--outcome-source <s>", "where the outcome was measured").choices(["crm", "ga4", "platform_proxy"]).makeOptionMandatory())
      .option("--caveat <text>", "a caveat to keep with the result (repeatable)", collect),
  ).action((id: string, opts: { confidence: number; method: "bayesian" | "frequentist"; sampleSize: number; dateRange: string; effect: number; outcomeSource: "crm" | "ga4" | "platform_proxy"; caveat?: string[]; workspace?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const { tactic: before, body } = await find(dir, id);
      const verdict = conclude(before, {
        confidence: opts.confidence,
        method: opts.method,
        sample_size: opts.sampleSize,
        date_range: opts.dateRange,
        effect: opts.effect,
        outcome_source: opts.outcomeSource,
        grading: opts.outcomeSource === "platform_proxy" ? "proxy" : "outcome",
        caveats: opts.caveat ?? [],
      });
      await saveTactic(dir, verdict.tactic, body);
      await new Ledger(join(dir, LEDGER_FILE)).append({
        actor: cliActor(),
        event: "tactic.concluded",
        payload: { id, outcome: verdict.outcome, confidence: opts.confidence, sample_size: opts.sampleSize, effect: opts.effect, outcome_source: opts.outcomeSource },
      });
      if ("reason" in verdict) {
        out(`${id} stays hypothesized (${verdict.outcome}): ${verdict.reason}`);
        return 2;
      }
      out(`${id} is ${verdict.outcome} (confidence ${opts.confidence}, effect ${(opts.effect * 100).toFixed(1)}%, n=${opts.sampleSize}).`);
    }),
  );

  ws(tactic.command("retire <id>").description("retire a validated tactic (contradicting evidence or out of season)").requiredOption("--reason <text>", "why")).action((id: string, opts: { reason: string; workspace?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const { tactic: before, body } = await find(dir, id);
      const after = retire(before, opts.reason, new Date().toISOString().slice(0, 10));
      await saveTactic(dir, after, body);
      await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "tactic.retired", payload: { id, reason: opts.reason } });
      out(`${id} retired.`);
    }),
  );

  ws(tactic.command("index").description(`write tactics/${INDEX_FILE}, the generated overview`)).action((opts: { workspace?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const { tactics, problems } = await loadTactics(dir);
      await writeFile(join(dir, TACTICS_DIR, INDEX_FILE), renderIndex(tactics.map((t) => t.tactic)), "utf8");
      out(`wrote tactics/${INDEX_FILE} (${tactics.length} tactic(s)${problems.length ? `, ${problems.length} unreadable` : ""})`);
      return problems.length ? 1 : 0;
    }),
  );
}

