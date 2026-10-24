// mdj draft ...: look at, compare and roll back what the agent (or you) saved in the drafts store.
// Nothing here sends or publishes anything; a revert only saves an earlier text as a new version.
import { join } from "node:path";
import type { Command } from "commander";
import { Ledger } from "../audit/ledger.js";
import { createDraftChecker } from "../drafts/checker.js";
import { DraftError, DraftStore } from "../drafts/store.js";
import { cliActor, guarded, LEDGER_FILE, workspaceDirOrThrow } from "./util.js";

const out = (text: string) => process.stdout.write(`${text}\n`);

function parseRef(ref: string): { workflow: string; slug: string } {
  const parts = ref.split("/");
  if (parts.length !== 2 || parts.some((p) => p === "")) throw new DraftError(`write a draft as workflow/slug, for example email/umrah-follow-up (got "${ref.slice(0, 60)}")`);
  return { workflow: parts[0] as string, slug: parts[1] as string };
}

async function openStore(workspaceOption: string | undefined): Promise<DraftStore> {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const ledger = new Ledger(join(dir, LEDGER_FILE));
  return new DraftStore(dir, {
    checker: await createDraftChecker(dir),
    audit: async ({ event, author, ...payload }) => {
      await ledger.append({ actor: String(author), event: String(event), payload });
    },
  });
}

const versionOption = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error("a version is a whole number from 1");
  return n;
};

export function registerDraftCommands(program: Command): void {
  const draft = program.command("draft").description("drafts saved by the agent or you: versions, changes, rollback (nothing here sends anything)");

  draft
    .command("list")
    .description("every draft with its latest version and copy-check status")
    .option("--workflow <name>", "only this workflow")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workflow?: string; json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const list = await (await openStore(opts.workspace)).list(opts.workflow);
        if (opts.json) return void out(JSON.stringify(list, null, 2));
        if (list.length === 0) return void out("No drafts yet. The agent saves them with draft_save, into <workspace>/drafts/.");
        out(`${"DRAFT".padEnd(34)}${"LATEST".padEnd(8)}${"VERS".padEnd(6)}${"KIND".padEnd(14)}${"COPY CHECK".padEnd(16)}UPDATED`);
        for (const d of list) out(`${`${d.workflow}/${d.slug}`.slice(0, 32).padEnd(34)}${`v${d.latest}`.padEnd(8)}${String(d.versions).padEnd(6)}${d.kind.padEnd(14)}${d.check.padEnd(16)}${d.updated_at.slice(0, 16).replace("T", " ")}`);
      }),
    );

  draft
    .command("show <draft> [version]")
    .description("a draft (workflow/slug): the latest version, or a given one, with its hash and copy-check result")
    .option("--json", "machine-readable")
    .option("--workspace <dir>", "workspace folder")
    .action((ref: string, version: string | undefined, opts: { json?: boolean; workspace?: string }) =>
      guarded(async () => {
        const { workflow, slug } = parseRef(ref);
        const r = await (await openStore(opts.workspace)).read(workflow, slug, version === undefined ? undefined : versionOption(version));
        if (opts.json) return void out(JSON.stringify({ ...r.meta, intact: r.intact, text: r.text }, null, 2));
        const c = r.meta.check;
        out([`draft: ${workflow}/${slug}`, `version: ${r.meta.version}${r.meta.reverted_from ? ` (reverted from v${r.meta.reverted_from})` : ""}`, `kind: ${r.meta.kind}`, `author: ${r.meta.author}`, `saved: ${r.meta.created_at}`, `sha256: ${r.meta.sha256}${r.intact ? "" : "   CHANGED OUTSIDE MEDJAY"}`, `copy check: ${c.status}${c.errors + c.warnings > 0 ? ` (${c.errors} error(s), ${c.warnings} warning(s); rules: ${c.rules.join(", ")})` : ""}`, "", r.text].join("\n"));
      }),
    );

  draft
    .command("diff <draft> <from> <to>")
    .description("what changed between two versions")
    .option("--workspace <dir>", "workspace folder")
    .action((ref: string, from: string, to: string, opts: { workspace?: string }) =>
      guarded(async () => {
        const { workflow, slug } = parseRef(ref);
        const d = await (await openStore(opts.workspace)).diff(workflow, slug, versionOption(from), versionOption(to));
        out(`${workflow}/${slug} v${from} to v${to}: +${d.added} -${d.removed} lines\n${d.text === "" ? "(no difference)" : d.text}`);
      }),
    );

  draft
    .command("revert <draft>")
    .description("save an earlier version's text as a new version (history is kept)")
    .requiredOption("--to <n>", "the version to go back to", versionOption)
    .option("--workspace <dir>", "workspace folder")
    .action((ref: string, opts: { to: number; workspace?: string }) =>
      guarded(async () => {
        const { workflow, slug } = parseRef(ref);
        const meta = await (await openStore(opts.workspace)).revert(workflow, slug, opts.to, cliActor());
        out(`saved v${meta.version} (reverted from v${opts.to}) · sha256 ${meta.sha256.slice(0, 12)} · copy check: ${meta.check.status}`);
      }),
    );

  draft
    .command("verify")
    .description("find versions whose text no longer matches the hash saved with them")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const problems = await (await openStore(opts.workspace)).verify();
        if (problems.length === 0) return void out("all saved versions match their SHA-256");
        for (const p of problems) out(`${p.workflow}/${p.slug} v${p.version}: ${p.problem}`);
        return 1;
      }),
    );
}
