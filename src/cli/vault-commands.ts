import { join } from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { Ledger } from "../audit/ledger.js";
import { looksLikeInstruction } from "../ingest/values.js";
import { Store } from "../store/db.js";
import { loadTactics, saveTactic, TACTICS_DIR } from "../tactics/files.js";
import { FUNNEL_STAGES } from "../tactics/schema.js";
import { brandWords } from "../vault/context.js";
import { buildPromotion, importPrior, PromotionError } from "../vault/record.js";
import { defaultVaultDir, listVault, readRecord, searchVault, writeRecord } from "../vault/store.js";
import { loadWorkspace } from "../workspace/load.js";
import { cliActor, guarded, LEDGER_FILE, STORE_FILE, workspaceDirOrThrow } from "./util.js";

const out = (text: string) => process.stdout.write(`${text}\n`);
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** Campaign and ad set names from the ingested data: the words a promoted tactic must not contain. */
function campaignNames(dir: string): string[] {
  const store = Store.open(join(dir, STORE_FILE));
  try {
    const db = store.database();
    const rows = [
      ...(db.prepare("SELECT DISTINCT campaign AS n FROM fact_daily UNION SELECT DISTINCT adset FROM fact_daily UNION SELECT DISTINCT campaign FROM leads UNION SELECT DISTINCT adset FROM leads UNION SELECT DISTINCT campaign FROM web_sessions").all() as { n: string }[]),
    ];
    // a cell that is really an instruction (or an essay) is data to distrust, not a name to protect:
    // its ordinary words ("pause", "deal") would otherwise block every promotion
    return rows.map((r) => r.n).filter((n) => n && n.length <= 80 && !looksLikeInstruction(n));
  } finally {
    store.close();
  }
}

export function registerVaultCommands(tactic: Command): void {
  const ws = (c: Command) => c.option("--workspace <dir>", "workspace folder").option("--vault <dir>", "global vault folder (default: ~/.medjay/global-vault, or MEDJAY_VAULT_DIR)");

  ws(
    tactic
      .command("promote <id>")
      .description("copy a VALIDATED tactic into the global vault as an anonymized pattern; shows what was changed and refuses if anything identifies this workspace")
      .option("--dry-run", "show the redaction diff and stop")
      .option("--yes", "confirm the promotion (needed when workspace.yaml has vault.promotion: ask)")
      .option("--allow-token <word>", "accept a flagged word you have checked is generic (repeatable; recorded in the ledger)", collect),
  ).action((id: string, opts: { dryRun?: boolean; yes?: boolean; allowToken?: string[]; workspace?: string; vault?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const { config } = await loadWorkspace(dir);
      const found = (await loadTactics(dir)).tactics.find((t) => t.tactic.id === id);
      if (!found) throw new Error(`no tactic ${id}; see \`mdj tactic list\``);
      const promotion = buildPromotion(
        found.tactic,
        found.body,
        { workspace: config.workspace.id, names: [config.workspace.name], brand: await brandWords(dir), campaigns: campaignNames(dir) },
        { allowTokens: opts.allowToken ?? [] },
      );
      out(`Redaction diff for ${id} -> ${promotion.record.global_id}`);
      for (const d of promotion.diff) {
        const clip = (t: string) => (t.length > 110 ? `${t.slice(0, 107).replace(/\s+/g, " ")}...` : t.replace(/\s+/g, " "));
        out(`  ${d.field}\n    before: ${clip(d.before)}\n    after:  ${clip(d.after)}`);
      }
      const counts = Object.entries(promotion.removed).map(([k, n]) => `${n} ${k}`);
      out(`Replaced in the text: ${counts.join(", ") || "nothing"}.`);
      out(`Left out entirely: ${promotion.dropped.join("; ")}.`);
      if (promotion.overridden.length) out(`Accepted by you despite matching this workspace: ${promotion.overridden.join(", ")}.`);

      const mode = config.vault.promotion;
      if (opts.dryRun) {
        out(`\nDry run: nothing was written. workspace.yaml has vault.promotion: ${mode}.`);
        return mode === "off" ? 1 : 0;
      }
      if (mode === "off") throw new Error("vault.promotion is off in workspace.yaml, so nothing leaves this workspace. Set it to ask or allow if your client agreement permits cross-client learning.");
      if (mode === "ask" && !opts.yes) {
        out("\nvault.promotion is ask: review the diff above, then run again with --yes to promote.");
        return 2;
      }
      const vault = opts.vault ?? defaultVaultDir();
      const written = await writeRecord(vault, promotion.record);
      await new Ledger(join(dir, LEDGER_FILE)).append({
        actor: cliActor(),
        event: "tactic.promoted",
        payload: { tactic: id, global_id: promotion.record.global_id, created: written.created, replaced: promotion.removed, overridden: promotion.overridden },
      });
      out(`\n${written.created ? "Promoted" : "Already in the vault"}: ${promotion.record.global_id} (${vault}).`);
    }),
  );

  ws(
    tactic
      .command("search")
      .description("find validated patterns in the global vault by industry, market, funnel stage and pillar")
      .option("--industry <vertical>", "vertical tag, for example travel")
      .option("--market <code>", "market tag, for example KSA")
      .addOption(new Option("--funnel-stage <stage>", "funnel stage").choices(FUNNEL_STAGES))
      .option("--pillar <n>", "growth pillar number", (v) => Number(v))
      .option("--matches <finding>", "a diagnose finding kind the tactic answers, for example bleeding_adset")
      .option("--json", "machine-readable"),
  ).action((opts: { industry?: string; market?: string; funnelStage?: string; pillar?: number; matches?: string; json?: boolean; vault?: string }) =>
    guarded(async () => {
      const vault = opts.vault ?? defaultVaultDir();
      const found = await searchVault(vault, {
        ...(opts.industry ? { industry: opts.industry } : {}),
        ...(opts.market ? { market: opts.market } : {}),
        ...(opts.funnelStage ? { funnelStage: opts.funnelStage } : {}),
        ...(opts.pillar === undefined ? {} : { pillar: opts.pillar }),
        ...(opts.matches ? { matches: opts.matches } : {}),
      });
      const { problems } = await listVault(vault);
      if (opts.json) out(JSON.stringify(found, null, 2));
      else if (found.length === 0) out(`no matching patterns in ${vault}`);
      else {
        for (const r of found) {
          out(`${r.global_id}  ${r.title}`);
          out(`    ${r.tags.verticals.join(", ") || "-"} | ${r.tags.markets.join(", ") || "-"} | ${r.funnel_stage ?? "-"} | pillars ${r.pillars.join(", ") || "-"} | effect ${r.evidence.effect_band} on ${r.evidence.metric}, sample ${r.evidence.sample_band}, confidence ${r.evidence.confidence_band}, ${r.evidence.period}${r.evidence.grading === "proxy" ? " (platform data)" : ""}`);
        }
        out(`${found.length} pattern(s). Pull one into this workspace with: mdj tactics pull <id>`);
      }
      for (const p of problems) process.stderr.write(`warning: ${p.file}: ${p.message}\n`);
      return problems.length ? 1 : 0;
    }),
  );

  ws(tactic.command("pull <global_id>").description("copy a vault pattern into this workspace as an UNVERIFIED tactic (a prior to test here, never proof)")).action((globalId: string, opts: { workspace?: string; vault?: string }) =>
    guarded(async () => {
      const dir = await workspaceDirOrThrow(opts.workspace);
      const record = await readRecord(opts.vault ?? defaultVaultDir(), globalId);
      const { tactic: pulled, body } = importPrior(record, new Date());
      const existing = (await loadTactics(dir)).tactics.find((t) => t.tactic.id === pulled.id);
      if (existing) throw new Error(`${pulled.id} is already in this workspace (${TACTICS_DIR}/${existing.file})`);
      await saveTactic(dir, pulled, body);
      await new Ledger(join(dir, LEDGER_FILE)).append({ actor: cliActor(), event: "tactic.pulled", payload: { tactic: pulled.id, global_id: globalId } });
      out(`pulled ${globalId} as ${pulled.id} (unverified, a prior). Test it here: mdj tactic hypothesize ${pulled.id} ...`);
    }),
  );
}

export { PromotionError };
