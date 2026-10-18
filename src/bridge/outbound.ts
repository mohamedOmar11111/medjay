// Outbound text. The pulse is a WhatsApp surface (caveman lite: tight, but full sentences). The
// approval prompt is an APPROVAL surface and is always plain (SPEC section 29). Both end with the
// ledger head hash, an external tamper witness: if the head the phone shows is not the head
// `mdj ledger verify` prints on the computer, the log was changed after this message was sent.
import type { Diagnosis } from "../analysis/diagnose.js";
import type { Snapshot } from "../analysis/scout.js";
import type { PlanRow } from "../plan/repo.js";
import type { CompiledAction, Plan } from "../plan/types.js";
import { signButton } from "./buttons.js";
import type { OutboundMessage } from "./types.js";

export interface LedgerHead {
  seq: number;
  hash: string;
}

export const SHORT = 8;
export const shortHash = (hash: string) => hash.slice(0, SHORT);
export const witness = (head: LedgerHead) => `Ledger head ${head.hash.slice(0, 12)} (entry ${head.seq}).`;

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const days = (p: Snapshot["period"]) => (p ? `${p.start} to ${p.end}` : "no data");

export function pulseCard(input: { workspace: string; snapshot: Snapshot; diagnosis: Diagnosis; pending: PlanRow[]; head: LedgerHead }): string {
  const { snapshot: s, diagnosis: d } = input;
  if (s.status === "no_data") return `${input.workspace}: no ad data yet. Put exports in data/imports/ and send SCOUT.\n${witness(input.head)}`;
  const lines = [`${input.workspace} pulse, ${days(s.period)}.`, `Spend ${s.currency} ${n0(s.totals.spend)}. Blended MER ${s.totals.blended_mer ?? "n/a"} from CRM deals.`];
  for (const p of s.platforms.filter((x) => x.platform_roas !== null)) lines.push(`${p.platform} reports ROAS ${p.platform_roas}, which the CRM does not back.`);
  const top = d.top.map((id) => d.findings.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (top.length > 0) {
    lines.push("", "Top issues:");
    top.forEach((f, i) => lines.push(`${i + 1}. ${f.title}`));
  }
  if (d.findings.some((f) => f.kind === "instruction_like_text")) lines.push("", "Warning: some data cells read like instructions to an AI. They are treated as plain data.");
  if (input.pending.length > 0) lines.push("", `Waiting for you: ${input.pending.map((p) => `#${p.number}`).join(", ")}. Send DIAGNOSE or STATUS for detail.`);
  lines.push("", witness(input.head));
  return lines.join("\n");
}

function describe(a: CompiledAction): string {
  const name = "target" in a ? (a.target.name ?? a.target.id) : "";
  const where = "target" in a ? `${a.target.platform} ${a.target.kind}` : "";
  switch (a.type) {
    case "budget_change":
      return `Daily budget of ${name} (${where}): ${a.from} to ${a.to} ${a.currency}${a.restores ? " (restores an earlier value)" : ""}`;
    case "status_change":
      return `${name} (${where}): ${a.from} to ${a.to}`;
    case "add_negative_keywords":
      return `Add ${a.terms.length} negative keyword(s) to ${name}: ${a.terms.slice(0, 3).map((t) => t.text).join(", ")}${a.terms.length > 3 ? ", ..." : ""}`;
    case "remove_negative_keywords":
      return `Remove ${a.terms.length} negative keyword(s) from ${name}`;
    case "code_patch":
      return `Patch ${a.artifact} (reviewed and applied by a person)`;
    case "register_experiment":
      return `Register experiment ${a.experiment_id}: ${a.hypothesis}`;
  }
}

export interface ApprovalPromptInput {
  to: string;
  row: PlanRow;
  plan: Plan;
  head: LedgerHead;
  /** Key for signed buttons; without one no buttons are offered. */
  buttonKey?: string;
}

export function approvalPrompt(input: ApprovalPromptInput): OutboundMessage {
  const { row, plan } = input;
  const short = shortHash(plan.plan_hash);
  const failing = plan.policy_result.checks.filter((c) => c.ok === false);
  const unknown = plan.policy_result.checks.filter((c) => c.ok === null);
  const net = plan.impact_estimate.daily_spend_delta;
  const lines = [`Plan #${row.number} needs your approval.`, ""];
  plan.actions.slice(0, 6).forEach((a) => lines.push(`- ${describe(a)}`));
  if (plan.actions.length > 6) lines.push(`- and ${plan.actions.length - 6} more (mdj plan show ${row.number})`);
  lines.push("", net.currency === null && net.gross === 0 ? "No budget change." : `Daily budget change: ${net.net >= 0 ? "+" : ""}${net.net} ${net.currency ?? ""} net, ${net.gross} ${net.currency ?? ""} gross.`);
  lines.push(`Policy: ${failing.length > 0 ? "FAIL" : "pass"}${unknown.length > 0 ? ` (${unknown.length} check(s) not evaluated)` : ""}.`);
  if (plan.simulation) lines.push(`Simulation ${plan.simulation.id}: P50 ${plan.simulation.p50}, chance above zero ${(plan.simulation.p_positive * 100).toFixed(0)}%.`);
  if (plan.policy_result.two_step_required) lines.push("This plan needs a second confirmation. Run `mdj approve " + row.number + "` on your computer to get a code, then reply STRIKE " + row.number + " " + short + " <code>.");
  lines.push("", "To approve and export, reply exactly:", `STRIKE ${row.number} ${short}`, `HOLD ${row.number} keeps it as a draft. DROP ${row.number} rejects it.`);
  lines.push("", `Plan hash ${short}. ${witness(input.head)} Compare it with \`mdj ledger verify\` on your computer.`);
  const key = input.buttonKey;
  return {
    to: input.to,
    text: lines.join("\n"),
    ...(key
      ? {
          buttons: [
            { id: signButton(key, "STRIKE", row.number, short), title: `STRIKE ${row.number}` },
            { id: signButton(key, "HOLD", row.number, short), title: `HOLD ${row.number}` },
            { id: signButton(key, "DROP", row.number, short), title: `DROP ${row.number}` },
          ],
        }
      : {}),
  };
}

export const HELP_TEXT = [
  "Commands (type them; voice notes can only ask for reports):",
  "STATUS, PULSE, SCOUT, DIAGNOSE, SIMULATE <plan>",
  "STRIKE <plan> <hash>: approve and export a plan. The 8-character hash is on its card.",
  "HOLD <plan>, DROP <plan>, PAUSE ALL, RESUME",
].join("\n");
