import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Command } from "commander";
import { Ledger } from "../audit/ledger.js";
import { loadCompetitors } from "../shadow/competitors.js";
import { parseOurOffer } from "../shadow/ours.js";
import { analyze, renderShadow } from "../shadow/report.js";
import { loadWorkspace } from "../workspace/load.js";
import { cliActor, guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

export function registerShadowCommands(program: Command): void {
  program
    .command("shadow-scout")
    .description("read competitor page snapshots and ad-library exports from data/imports/competitors/, extract each offer's architecture, and compare it with yours")
    .option("--json", "machine-readable, including each competitor's findings wrapped in <untrusted_data> blocks for a model")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const { dropzoneDir } = await loadWorkspace(dir);
        const folder = join(dropzoneDir, "competitors");
        const label = relative(dir, folder).split("\\").join("/");
        const { competitors, skipped } = await loadCompetitors(folder);
        const offerText = await readFile(join(dir, "context", "offer-matrix.md"), "utf8").catch(() => "");
        const report = analyze(competitors, skipped, parseOurOffer(offerText), label);
        await new Ledger(join(dir, LEDGER_FILE)).append({
          actor: cliActor(),
          event: "shadow_scout.completed",
          payload: {
            folder: label,
            competitors: report.competitors.map((c) => c.file),
            skipped: skipped.length,
            instruction_like_files: report.competitors.filter((c) => c.offer.instruction_like.length > 0).length,
            gaps: report.gaps.filter((g) => g.kind === "gap").map((g) => `${g.dimension}:${g.severity}`),
          },
        });
        process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : renderShadow(report)}\n`);
        return report.competitors.length === 0 ? 1 : 0;
      }),
    );
}
