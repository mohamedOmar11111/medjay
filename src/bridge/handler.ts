// The inbound side of the WhatsApp command bridge. Ring 0 rules, all enforced here in code:
//   - a request is signature-verified before it is parsed; unsigned or mis-signed is rejected (401)
//   - a message id is processed once (replay is a silent no-op)
//   - the sender must be an approver in shield.policy.yaml, with the permission the command needs
//   - voice (audio, or a transcript) can only queue reports; it can never strike, hold, drop, pause or
//     change anything, even if the transcript says "STRIKE 4 <hash>"
//   - a strike is a TYPED message "STRIKE <plan> <hash>" or a signed button, the hash must match the
//     plan as it is now, and the plan then goes through the ordinary approval and strike code
//   - nothing the bridge logs contains message text, only the command kind
import type { Diagnosis } from "../analysis/diagnose.js";
import { diagnose } from "../analysis/diagnose.js";
import type { Snapshot } from "../analysis/scout.js";
import type { Ledger } from "../audit/ledger.js";
import { approvePlan, holdPlan, rejectPlan } from "../plan/approve.js";
import { readPlanFile } from "../plan/files.js";
import type { PlanDeps } from "../plan/propose.js";
import type { PlanSimOutcome } from "../plan/simulate-plan.js";
import { strikePlan } from "../plan/strike.js";
import { INVARIANTS, isStrikeConfirmationValid } from "../shield/invariants.js";
import type { Policy } from "../shield/policy.js";
import type { Store } from "../store/db.js";
import { authorizeSender, type Approver, type SenderResolver } from "./auth.js";
import { verifyButton } from "./buttons.js";
import { parseCommand, permissionFor, voiceMayRun, type Command } from "./commands.js";
import { approvalPrompt, HELP_TEXT, pulseCard, shortHash, witness } from "./outbound.js";
import { parseWebhook, WebhookParseError } from "./parse.js";
import { BridgeRepo, type Job, type JobKind } from "./queue.js";
import { verifySignature } from "./signature.js";
import type { InboundMessage, OutboundMessage, Via } from "./types.js";
import type { WebhookSpec } from "./webhook-spec.js";

export interface ReadServices {
  report(): Promise<{ snapshot: Snapshot; diagnosis: Diagnosis }>;
  simulate(plan: number): Promise<PlanSimOutcome>;
}

export interface BridgeDeps {
  workspaceId: string;
  webhook: WebhookSpec;
  /** Webhook secret; also keys the signed buttons. */
  secret: string;
  policy: Policy;
  ledger: Ledger;
  store: Store;
  plans: PlanDeps;
  resolver: SenderResolver;
  reads: ReadServices;
  now: () => Date;
  rateLimitPerMinute?: number;
}

export interface Handled {
  id: string;
  sender: string;
  via: Via;
  command: string;
  outcome: string;
}

export interface WebhookResult {
  status: 200 | 400 | 401 | 503;
  replies: OutboundMessage[];
  handled: Handled[];
}

const DEFAULT_RATE = 20;
const short = (hash: string) => hash.slice(0, 16);

export async function handleWebhook(deps: BridgeDeps, req: { rawBody: string; headers: Record<string, string | undefined> }): Promise<WebhookResult> {
  if (deps.secret === "") return { status: 503, replies: [], handled: [] };
  if (!verifySignature(deps.webhook, req.rawBody, req.headers, deps.secret)) {
    await deps.ledger.append({ actor: "bridge", event: "bridge.rejected", payload: { reason: "bad_signature", provider: deps.webhook.label } });
    return { status: 401, replies: [], handled: [] };
  }
  let messages: InboundMessage[];
  try {
    messages = parseWebhook(deps.webhook, JSON.parse(req.rawBody));
  } catch (error) {
    if (error instanceof WebhookParseError || error instanceof SyntaxError) return { status: 400, replies: [], handled: [] };
    throw error;
  }
  const replies: OutboundMessage[] = [];
  const handled: Handled[] = [];
  for (const message of messages) {
    const result = await handleMessage(deps, message);
    replies.push(...result.replies);
    if (result.handled) handled.push(result.handled);
  }
  if (replies.length > 0) {
    const head = (await deps.ledger.head()).hash.slice(0, 12);
    for (const r of replies) r.meta = { ...r.meta, ledger_head: head };
  }
  return { status: 200, replies, handled };
}

async function handleMessage(deps: BridgeDeps, message: InboundMessage): Promise<{ replies: OutboundMessage[]; handled?: Handled }> {
  const repo = new BridgeRepo(deps.store);
  const now = deps.now();
  const reply = (text: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({ to: message.from, text, ...extra });

  const auth = await authorizeSender(deps.policy, message.from, deps.workspaceId, deps.resolver);
  // the id is remembered before anything else, so a replay is a no-op whoever sent it
  const senderKey = auth.ok ? short(auth.hash) : "unknown";
  if (!repo.remember({ id: message.id, provider: deps.webhook.label, sender_hash: senderKey, via: message.via }, now)) return { replies: [] };

  const done = (command: string, outcome: string, replies: OutboundMessage[]): { replies: OutboundMessage[]; handled: Handled } => {
    repo.settle(message.id, command, outcome);
    return { replies, handled: { id: message.id, sender: senderKey, via: message.via, command, outcome } };
  };
  const log = (event: string, payload: Record<string, unknown>) => deps.ledger.append({ actor: auth.ok ? `whatsapp:${auth.approver.name}` : "bridge", event, payload: { via: message.via, sender: senderKey, ...payload } });

  // Unknown senders get no reply at all: nothing to probe, nothing to spam.
  if (!auth.ok) {
    await log("bridge.rejected", { reason: auth.reason });
    return done("-", `rejected:${auth.reason}`, []);
  }

  const limit = deps.rateLimitPerMinute ?? DEFAULT_RATE;
  if (repo.recentFrom(senderKey, new Date(now.getTime() - 60_000)) > limit) {
    await log("bridge.rejected", { reason: "rate_limited" });
    return done("-", "rejected:rate_limited", []);
  }

  const resolved = resolveCommand(deps, message);
  if (resolved.problem) {
    await log("bridge.rejected", { reason: resolved.problem.code });
    return done("-", `rejected:${resolved.problem.code}`, [reply(resolved.problem.text)]);
  }
  const command = resolved.command as Command;

  // Ring 0: a voice note may only ask for reports.
  if (message.via === "voice" && !voiceMayRun(command)) {
    await log("bridge.refused_voice", { command: command.kind });
    const hint = await typedHint(deps, command);
    return done(command.kind, "refused:voice", [reply(`Voice notes can only ask for reports. They cannot approve, hold, drop or change anything.${hint}`)]);
  }
  if (message.via === "other") return done("-", "refused:unsupported", [reply("I can only read typed messages and button taps.")]);

  const permission = permissionFor(command);
  if (permission !== null && !auth.approver.can.includes(permission)) {
    await log("bridge.denied", { command: command.kind, needs: permission });
    return done(command.kind, "denied:permission", [reply(`Your number is not allowed to do that (${permission}).`)]);
  }

  const paused = repo.isPaused();
  if (paused && !["resume", "status", "help"].includes(command.kind)) {
    return done(command.kind, "refused:paused", [reply("The bridge is paused. Send RESUME to continue.")]);
  }

  try {
    const replies = await execute(deps, repo, auth.approver, message, command, reply);
    await log("bridge.command", { command: command.kind, ...("plan" in command ? { plan: command.plan } : {}) });
    return done(command.kind, "ok", replies);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await log("bridge.error", { command: command.kind, error: text.slice(0, 300) });
    return done(command.kind, "error", [reply(`That did not work: ${text.split("\n")[0]?.slice(0, 200) ?? "error"}`)]);
  }
}

function resolveCommand(deps: BridgeDeps, message: InboundMessage): { command?: Command; problem?: { code: string; text: string } } {
  if (message.via === "button") {
    const button = verifyButton(deps.secret, message.buttonId ?? "");
    if (!button) return { problem: { code: "bad_button", text: "That button is not valid or has been changed." } };
    if (button.action === "STRIKE") return { command: { kind: "strike", plan: button.plan, hash: button.hash } };
    return { command: { kind: button.action === "HOLD" ? "hold" : "drop", plan: button.plan } };
  }
  return { command: parseCommand(message.text ?? "") };
}

async function typedHint(deps: BridgeDeps, command: Command): Promise<string> {
  if (command.kind !== "strike" && command.kind !== "strike_incomplete") return "";
  const row = deps.plans.repo.get(command.plan);
  if (!row || !["proposed", "held"].includes(row.state)) return "";
  return ` To approve plan #${row.number}, type: STRIKE ${row.number} ${shortHash(row.plan_hash)}`;
}

async function execute(deps: BridgeDeps, repo: BridgeRepo, approver: Approver, message: InboundMessage, command: Command, reply: (text: string, extra?: Partial<OutboundMessage>) => OutboundMessage): Promise<OutboundMessage[]> {
  const now = deps.now();
  switch (command.kind) {
    case "help":
      return [reply(HELP_TEXT)];
    case "unknown":
    case "cap_unsupported":
      return [reply(command.kind === "cap_unsupported" ? "CAP is not available over WhatsApp yet. Change the plan on your computer." : `I did not understand that.\n${HELP_TEXT}`)];
    case "pause_all":
    case "resume":
      repo.setPaused(command.kind === "pause_all", now);
      return [reply(command.kind === "pause_all" ? "Bridge paused. Only STATUS, HELP and RESUME work until you send RESUME." : "Bridge resumed.")];
    case "status":
    case "pulse":
    case "scout":
    case "diagnose":
    case "simulate":
      return [reply(await runReadJob(deps, repo, message, command))];
    case "strike_incomplete": {
      const row = deps.plans.repo.get(command.plan);
      if (!row) return [reply(`There is no plan #${command.plan}.`)];
      const plan = await readPlanFile(deps.plans.dir, row);
      return [approvalPrompt({ to: message.from, row, plan, head: await deps.ledger.head(), buttonKey: deps.secret })];
    }
    case "hold":
    case "drop": {
      if (!isStrikeConfirmationValid({ via: message.via })) throw new Error("this needs a typed message or a button tap");
      const actor = `whatsapp:${approver.name}`;
      const row = command.kind === "hold" ? await holdPlan(deps.plans, command.plan, { actor }) : await rejectPlan(deps.plans, command.plan, { actor, reason: "rejected over WhatsApp" });
      return [reply(`Plan #${row.number} ${command.kind === "hold" ? "held. Nothing will run." : "rejected."}\n${witness(await deps.ledger.head())}`)];
    }
    case "strike":
      return [reply(await strike(deps, approver, message, command))];
  }
}

/** Queue a read job in SQLite and run it. If the process dies mid-job it is picked up again later. */
async function runReadJob(deps: BridgeDeps, repo: BridgeRepo, message: InboundMessage, command: Command): Promise<string> {
  const id = repo.enqueue({ message_id: message.id, sender_hash: "-", kind: command.kind as JobKind, args: "plan" in command ? { plan: command.plan } : {} }, deps.now());
  await processJobs(deps, repo);
  const job = repo.get(id) as Job;
  if (job.status === "done") return job.result_text ?? "";
  return `That report failed (${job.error ?? "unknown error"}). It will be retried.`;
}

export async function processJobs(deps: BridgeDeps, repo = new BridgeRepo(deps.store)): Promise<number> {
  let n = 0;
  for (let job = repo.claim(deps.now()); job; job = repo.claim(deps.now())) {
    try {
      repo.finish(job.job_id, { text: await runJob(deps, job) }, deps.now());
    } catch (error) {
      repo.finish(job.job_id, { error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, deps.now());
    }
    n += 1;
  }
  return n;
}

async function runJob(deps: BridgeDeps, job: Job): Promise<string> {
  const head = await deps.ledger.head();
  const pending = deps.plans.repo.list("proposed");
  switch (job.kind) {
    case "help":
      return HELP_TEXT;
    case "status": {
      const states = new Map<string, number>();
      for (const row of deps.plans.repo.list()) states.set(row.state, (states.get(row.state) ?? 0) + 1);
      const counts = [...states].map(([s, c]) => `${c} ${s}`).join(", ") || "no plans";
      return [`${deps.workspaceId}: ${counts}.`, pending.length > 0 ? `Waiting for approval: ${pending.map((p) => `#${p.number} (${shortHash(p.plan_hash)})`).join(", ")}.` : "Nothing waiting for approval.", witness(head)].join("\n");
    }
    case "pulse":
    case "scout": {
      const { snapshot, diagnosis } = await deps.reads.report();
      return pulseCard({ workspace: deps.workspaceId, snapshot, diagnosis, pending, head });
    }
    case "diagnose": {
      const { snapshot } = await deps.reads.report();
      const d = diagnose(snapshot);
      if (d.findings.length === 0) return `No anomalies above the thresholds.\n${witness(head)}`;
      const lines = d.findings.slice(0, 5).map((f, i) => `${i + 1}. [${f.severity}] ${f.title}`);
      return [`${d.findings.length} finding(s):`, ...lines, witness(head)].join("\n");
    }
    case "simulate": {
      const outcome = await deps.reads.simulate(job.args.plan as number);
      if (outcome.kind === "not_applicable") return outcome.message;
      if (outcome.kind === "insufficient_inputs") return `Cannot simulate: ${outcome.result.problems.map((p) => p.input).join(", ")} need fixing in context/unit-economics.md.`;
      const r = outcome.record;
      return [`Simulation ${r.sim_id} for plan #${job.args.plan}: chance above zero ${(r.p_positive * 100).toFixed(0)}% (needs ${(outcome.minPositive * 100).toFixed(0)}%), P50 ${r.p50}, P10 ${r.p10}, P90 ${r.p90}.`, outcome.passes ? (outcome.attachedAs ? `Passes. Plan #${outcome.attachedAs} now carries it.` : "Passes.") : "Does not pass. The plan was left as it is.", witness(head)].join("\n");
    }
  }
}

async function strike(deps: BridgeDeps, approver: Approver, message: InboundMessage, command: Extract<Command, { kind: "strike" }>): Promise<string> {
  // Ring 0, restated at the point of no return: only a typed message or a button tap may get here.
  if (!INVARIANTS.strikeRequiresTypedOrButton || !isStrikeConfirmationValid({ via: message.via === "typed" ? "typed" : message.via === "button" ? "button" : "voice" })) {
    throw new Error("a strike needs a typed message or a button tap");
  }
  const row = deps.plans.repo.get(command.plan);
  if (!row) return `There is no plan #${command.plan}.`;
  const plan = await readPlanFile(deps.plans.dir, row);
  const allowed = approver.clients.includes("*") || approver.clients.includes(plan.client ?? deps.workspaceId) || approver.clients.includes(deps.workspaceId);
  if (!allowed) return `Your number is not allowed to approve plan #${row.number}.`;
  if (!plan.plan_hash.startsWith(command.hash)) {
    return `The hash does not match plan #${row.number}. It may have changed since the card you saw. Current hash: ${shortHash(plan.plan_hash)}. Check the plan, then send STRIKE ${row.number} ${shortHash(plan.plan_hash)}.`;
  }
  const actor = `whatsapp:${approver.name}`;
  if (row.state === "proposed" || row.state === "held") {
    const approved = await approvePlan(deps.plans, row.number, { approver: actor, channel: "whatsapp", ...(command.code ? { confirmationCode: command.code } : {}) });
    if (approved.status === "confirmation_required") {
      // The code is NOT sent over WhatsApp: a second factor on the same channel is no second factor.
      return `Plan #${row.number} needs a second confirmation. Run \`mdj approve ${row.number}\` on your computer to get a code, then send: STRIKE ${row.number} ${shortHash(plan.plan_hash)} <code>`;
    }
  } else if (row.state !== "approved") {
    return `Plan #${row.number} is ${row.state}; nothing to approve.`;
  }
  const result = await strikePlan(deps.plans, row.number, { actor });
  const lines = result.results.map((r) => `${r.action_id}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  return [`Plan #${row.number} ${result.state}. Files are in ${result.exportDir}. Nothing was sent to the ad platforms; import the files yourself.`, ...lines, witness(await deps.ledger.head())].join("\n");
}
