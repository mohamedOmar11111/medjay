// The export executor: turns approved actions into files a human imports into the ad platform.
// It never calls a platform. Google Ads actions go into an Editor CSV, other platforms into a
// manual-steps document, patches are copied (never applied), and a manifest records everything.
//
// FORMAT NOTE: the Google Ads Editor headers below follow Editor's documented behavior (headers
// matched by name, blank cell = leave unchanged, negative match types written as "Negative
// Broad/Phrase/Exact") and third-party examples. They have NOT been validated against a real
// Editor import. Editor shows every proposed change for review before anything is posted, so
// try the file in a test account first.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonPretty } from "../audit/canonical.js";
import { toMinorUnits } from "./currency.js";
import type { ActionStatus } from "./repo.js";
import type { CompiledAction, Plan } from "./types.js";

export const EDITOR_HEADERS = ["Campaign", "Ad Group", "Keyword", "Criterion Type", "Campaign Status", "Budget"] as const;

export interface ActionOutcome {
  action_id: string;
  status: ActionStatus;
  detail?: string;
  artifact?: string;
}

const UNSAFE_NAME = /^[=+\-@\t\r]|[\u0000-\u001f\u007f]/;

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const isGoogle = (a: CompiledAction): a is Extract<CompiledAction, { target: { platform: string } }> =>
  "target" in a && a.target.platform === "google_ads" && a.executor === "export";

function campaignNameProblem(action: Extract<CompiledAction, { target: { name?: string } }>): string | undefined {
  const name = action.target.name;
  if (!name) return "campaign name required for Google Ads Editor export (the target has no name)";
  if (UNSAFE_NAME.test(name)) return "campaign name is unsafe for a spreadsheet (starts with = + - @ or has control characters); rename it or edit by hand";
  return undefined;
}

const isMetaMutation = (a: CompiledAction): a is Extract<CompiledAction, { type: "budget_change" | "status_change" }> =>
  (a.type === "budget_change" || a.type === "status_change") && a.target.platform === "meta" && ["campaign", "adset"].includes(a.target.kind) && a.executor === "export";

export interface MetaRequest {
  action_id: string;
  method: "POST";
  /** The object to change; the Graph API version is chosen by whoever sends the request. */
  path: string;
  params: Record<string, string>;
  /** What the object should look like right now; stop if it does not. */
  expect_before: Record<string, string>;
}

/** Meta has no bulk file import, so the export is the exact requests a person or a connector would send. Nothing is sent. */
export function buildMetaMutations(actions: CompiledAction[]): { requests: MetaRequest[]; written: string[]; problems: Map<string, string> } {
  const requests: MetaRequest[] = [];
  const problems = new Map<string, string>();
  for (const action of actions.filter(isMetaMutation)) {
    const path = `/${action.target.id}`;
    if (action.type === "budget_change") {
      const to = toMinorUnits(action.to, action.currency);
      const from = toMinorUnits(action.from, action.currency);
      if (to === null || from === null) {
        problems.set(action.id, `${action.currency} cannot hold a budget of ${action.to} (or ${action.from}) in whole minor units`);
        continue;
      }
      requests.push({ action_id: action.id, method: "POST", path, params: { daily_budget: String(to) }, expect_before: { daily_budget: String(from) } });
    } else {
      const word = (s: "ENABLED" | "PAUSED") => (s === "ENABLED" ? "ACTIVE" : "PAUSED");
      requests.push({ action_id: action.id, method: "POST", path, params: { status: word(action.to) }, expect_before: { status: word(action.from) } });
    }
  }
  return { requests, written: requests.map((r) => r.action_id), problems };
}

const needsConnector = (a: CompiledAction): boolean => a.executor === "mcp";

const statusWord = (s: "ENABLED" | "PAUSED") => (s === "ENABLED" ? "Enabled" : "Paused");
const matchWord = (m: "BROAD" | "PHRASE" | "EXACT") => `Negative ${m[0]}${m.slice(1).toLowerCase()}`;

/** Build the Editor CSV from the Google actions that are safe to write; report the rest. */
export function buildEditorCsv(actions: CompiledAction[]): { csv: string | null; written: string[]; problems: Map<string, string> } {
  const problems = new Map<string, string>();
  const written: string[] = [];
  const campaigns = new Map<string, { status?: string; budget?: string }>();
  const negatives: string[][] = [];

  for (const action of actions.filter(isGoogle)) {
    const problem = campaignNameProblem(action);
    if (problem) {
      problems.set(action.id, problem);
      continue;
    }
    const name = action.target.name as string;
    if (action.type === "budget_change") {
      campaigns.set(name, { ...campaigns.get(name), budget: String(action.to) });
    } else if (action.type === "status_change") {
      campaigns.set(name, { ...campaigns.get(name), status: statusWord(action.to) });
    } else if (action.type === "add_negative_keywords") {
      for (const term of action.terms) negatives.push([name, "", term.text, matchWord(term.match), "", ""]);
    } else continue;
    written.push(action.id);
  }

  if (written.length === 0) return { csv: null, written, problems };
  const rows = [
    [...EDITOR_HEADERS],
    ...[...campaigns].map(([name, c]) => [name, "", "", "", c.status ?? "", c.budget ?? ""]),
    ...negatives,
  ];
  const csv = `﻿${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
  return { csv, written, problems };
}

function describe(action: CompiledAction): string {
  switch (action.type) {
    case "budget_change":
      return `Set the daily budget of ${action.target.platform} ${action.target.kind} "${action.target.name ?? action.target.id}" (id ${action.target.id}) from ${action.from} to ${action.to} ${action.currency}.`;
    case "status_change":
      return `Change the status of ${action.target.platform} ${action.target.kind} "${action.target.name ?? action.target.id}" (id ${action.target.id}) from ${action.from} to ${action.to}.`;
    case "add_negative_keywords":
      return `Add negative keywords to ${action.target.platform} ${action.target.kind} "${action.target.name ?? action.target.id}": ${action.terms.map((t) => `${t.text} [${t.match.toLowerCase()}]`).join(", ")}.`;
    case "code_patch":
      return `Review and apply the patch ${action.artifact} yourself (Medjay never deploys code).`;
    case "register_experiment":
      return `Experiment ${action.experiment_id} registered: ${action.hypothesis} (metric: ${action.metric}).`;
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, "utf8");
  await rename(temp, path);
}

export interface ExportRun {
  outcomes: ActionOutcome[];
  exportDir: string;
  artifacts: Record<string, string>;
}

/**
 * Write the export for `pending` actions. Already-exported actions are left alone; the Editor CSV
 * is only rewritten when a Google action is pending, so a retry never touches finished work.
 */
export async function exportPlan(options: {
  dir: string;
  plan: Plan;
  pending: ReadonlySet<string>;
  now: Date;
}): Promise<ExportRun> {
  const { dir, plan, pending } = options;
  const exportDir = join(dir, "exports", plan.plan_id);
  await mkdir(exportDir, { recursive: true });
  const outcomes = new Map<string, ActionOutcome>();
  const artifacts: Record<string, string> = {};
  const pendingActions = plan.actions.filter((a) => pending.has(a.id));

  // Google Ads Editor CSV (rewritten from every Google action, only if one is pending)
  if (pendingActions.some(isGoogle)) {
    const built = buildEditorCsv(plan.actions);
    if (built.csv !== null) {
      await writeAtomic(join(exportDir, "google-ads-editor.csv"), built.csv);
      artifacts["google-ads-editor.csv"] = sha256(built.csv);
    }
    for (const action of pendingActions.filter(isGoogle)) {
      const problem = built.problems.get(action.id);
      outcomes.set(
        action.id,
        problem
          ? { action_id: action.id, status: "failed", detail: problem }
          : { action_id: action.id, status: "exported", artifact: "google-ads-editor.csv" },
      );
    }
  }

  // Meta mutations (rewritten from every Meta action, only if one is pending)
  if (pendingActions.some(isMetaMutation)) {
    const built = buildMetaMutations(plan.actions);
    if (built.requests.length > 0) {
      const text = `${canonicalJsonPretty({
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        note: "Dry-run payloads: Medjay has not sent any of these. Send each with the Marketing API (or by hand in Ads Manager) only if the object still matches expect_before.",
        requests: built.requests,
      })}
`;
      await writeAtomic(join(exportDir, "meta-mutations.json"), text);
      artifacts["meta-mutations.json"] = sha256(text);
    }
    for (const action of pendingActions.filter(isMetaMutation)) {
      const problem = built.problems.get(action.id);
      outcomes.set(action.id, problem ? { action_id: action.id, status: "failed", detail: problem } : { action_id: action.id, status: "exported", artifact: "meta-mutations.json" });
    }
  }

  for (const action of pendingActions) {
    if (outcomes.has(action.id)) continue;
    if (action.executor === "mcp") {
      outcomes.set(action.id, { action_id: action.id, status: "failed", detail: "no live connector is configured for this action (live execution arrives in M2)" });
    } else if (action.type === "code_patch") {
      const source = join(dir, "plans", action.artifact);
      const name = action.artifact.split("/").pop() as string;
      try {
        await mkdir(join(exportDir, "patches"), { recursive: true });
        await copyFile(source, join(exportDir, "patches", name));
        artifacts[`patches/${name}`] = sha256(await readFile(source));
        outcomes.set(action.id, { action_id: action.id, status: "exported", artifact: `patches/${name}`, detail: "copied for review; never applied automatically" });
      } catch (error) {
        outcomes.set(action.id, { action_id: action.id, status: "failed", detail: `patch could not be copied: ${error instanceof Error ? error.message : String(error)}` });
      }
    } else if (action.type === "register_experiment") {
      outcomes.set(action.id, { action_id: action.id, status: "recorded", detail: "recorded in the manifest" });
    } else {
      outcomes.set(action.id, { action_id: action.id, status: "exported", artifact: "CHANGES.md" });
    }
  }

  // Manual steps for everything that is not in the Editor CSV or a patch.
  const manual = plan.actions.filter((a) => !isGoogle(a) && !isMetaMutation(a) && a.type !== "code_patch" && !needsConnector(a));
  const changes = [
    `# Changes for plan ${plan.plan_id}`,
    "",
    `Plan hash: ${plan.plan_hash}`,
    "",
    "Make these changes by hand in each platform. Before each one, confirm the current value matches the 'before' value; if it does not, stop and compile a new plan.",
    "",
    ...(manual.length === 0 ? ["(none: every action went into the Editor CSV or a patch)"] : manual.map((a) => `- [${a.id}] ${describe(a)}`)),
    "",
  ].join("\n");
  await writeAtomic(join(exportDir, "CHANGES.md"), changes);
  artifacts["CHANGES.md"] = sha256(changes);

  await writeAtomic(
    join(exportDir, "README.txt"),
    [
      `Medjay export for plan ${plan.plan_id}`,
      `Plan hash: ${plan.plan_hash}`,
      "",
      "google-ads-editor.csv: import with Google Ads Editor (Account > Import > From file). Editor lists every proposed change for review before you post.",
      "  The column headers have not been validated against a real Editor import yet; try the file in a test account first.",
      "meta-mutations.json: the exact Meta requests, as dry-run payloads (budgets in minor units). Nothing is sent by Medjay.",
      "CHANGES.md: manual steps for platforms without a file import.",
      "patches/: patches for review. Medjay never applies or deploys them.",
      "manifest.json: every action with its status.",
      "",
      "Before importing, confirm the current values match the 'before' values in the plan (preconditions in manifest.json).",
      "",
    ].join("\n"),
  );

  const merged = plan.actions.map((a) => outcomes.get(a.id) ?? { action_id: a.id, status: "exported" as const });
  await writeAtomic(
    join(exportDir, "manifest.json"),
    `${canonicalJsonPretty({
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      workspace: plan.workspace,
      generated_at: options.now.toISOString(),
      preconditions: plan.preconditions,
      actions: plan.actions.map((a) => ({ id: a.id, type: a.type, ...("target" in a ? { target: a.target } : {}), outcome: merged.find((o) => o.action_id === a.id) ?? null })),
    })}\n`,
  );

  return { outcomes: [...outcomes.values()], exportDir, artifacts };
}
