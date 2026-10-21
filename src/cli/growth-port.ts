// The CLI's side of the growth tools: runs the same analyses as `mdj scout`, `diagnose` and `simulate`
// and hands the results to the agent. The runtime cannot import the analysis layers, so this adapter
// lives here and is passed in when a run is opened.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { diagnose } from "../analysis/diagnose.js";
import { loadUnitEconomics, simulate } from "../analysis/simulate.js";
import type { GrowthPort } from "../runtime/tools/growth.js";
import { loadTactics } from "../tactics/files.js";
import { loadWorkspace } from "../workspace/load.js";
import { openAnalysis } from "./analysis-commands.js";

const CONTEXT_FILE_CAP = 20_000;

async function readCapped(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > CONTEXT_FILE_CAP ? `${text.slice(0, CONTEXT_FILE_CAP)}\n[cut: the file is longer than ${CONTEXT_FILE_CAP} characters]` : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function createGrowthPort(dir: string): GrowthPort {
  return {
    async dataId() {
      const { dropzoneDir } = await loadWorkspace(dir);
      let names: string[] = [];
      try {
        names = (await readdir(dropzoneDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
      } catch {
        /* no dropzone yet */
      }
      const parts: string[] = [];
      for (const name of names) {
        const info = await stat(join(dropzoneDir, name));
        parts.push(`${name}:${info.size}:${Math.round(info.mtimeMs)}`);
      }
      return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
    },

    async scout(days) {
      const w = await openAnalysis(dir);
      try {
        const report = await w.ingest();
        return {
          ingest: {
            files: report.files.map((f) => ({ file: f.file, status: f.status, rows: f.rows, period: f.period, problems: f.issues.filter((i) => i.severity === "error").length, warnings: f.issues.filter((i) => i.severity === "warn").length })),
            unmapped_files: report.unmapped.length,
          },
          snapshot: w.snapshot(days),
          summary: w.summary(),
        };
      } finally {
        w.close();
      }
    },

    async diagnose(days) {
      const w = await openAnalysis(dir);
      try {
        return { ...diagnose(w.snapshot(days)), summary: w.summary() };
      } finally {
        w.close();
      }
    },

    async context() {
      const { tactics, problems } = await loadTactics(dir);
      return {
        unit_economics: await readCapped(join(dir, "context", "unit-economics.md")),
        claims: await readCapped(join(dir, "context", "claims.md")),
        offers: await readCapped(join(dir, "context", "offer-matrix.md")),
        tactics: tactics.map(({ tactic }) => ({ id: tactic.id, title: tactic.title, state: tactic.state, pillars: tactic.pillars })),
        tactic_files_with_problems: problems.length,
      };
    },

    async simulate(input) {
      const w = await openAnalysis(dir);
      try {
        const economics = await loadUnitEconomics(dir);
        if (economics.problems.length === 0 && economics.currency !== w.currency) {
          return { status: "currency_mismatch", message: `context/unit-economics.md is in ${economics.currency} but the workspace base currency is ${w.currency}; Medjay never converts silently` };
        }
        const snapshot = w.snapshot(input.days ?? 7);
        const summary = w.summary();
        const spend = input.spend ?? (snapshot.status === "ok" ? snapshot.totals.spend : summary?.totals.spend);
        if (spend === undefined) return { status: "no_spend", message: "no spend to simulate: ingest ad data first or pass spend" };
        const observed = snapshot.status === "ok" ? { cost_per_deal: snapshot.totals.cost_per_deal, blended_mer: snapshot.totals.blended_mer } : undefined;
        const result = simulate(economics, {
          spend,
          ...(input.scale_pct === undefined ? {} : { scalePct: input.scale_pct }),
          ...(input.seed === undefined ? {} : { seed: input.seed }),
          ...(input.draws === undefined ? {} : { draws: input.draws }),
          observed,
        });
        const basis = input.spend !== undefined ? "given" : snapshot.status === "ok" ? `scouted window (${input.days ?? 7} days)` : summary ? `period summary (${summary.period.days} days)` : "none";
        return { ...result, spend_used: spend, spend_basis: basis };
      } finally {
        w.close();
      }
    },
  };
}
