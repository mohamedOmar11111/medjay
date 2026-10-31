// The agent loop. One model call per step; the loop, not the model or the SDK, owns every tool call
// (so each one goes through the registry's permission pipeline), every checkpoint, every cap and
// every ledger entry. A run always ends in a named state and is never thrown away:
//   completed, needs_human, max_steps_reached, max_tokens_reached, max_cost_reached, aborted, failed
// Interrupted runs resume from what was saved (see resume.ts) without re-running or re-billing steps.
import type { RunEvent } from "../../run-events.js";
import { cardFor } from "./cards.js";
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../../audit/canonical.js";
import type { Ledger } from "../../audit/ledger.js";
import { AllTargetsFailedError, classifyError } from "../../models/fallback.js";
import { effectiveRunLimits, type Policy } from "../../shield/policy.js";
import type { Store } from "../../store/db.js";
import type { UsageSurface, SlotName } from "../../constants.js";
import type { Surface } from "../../style/caveman.js";
import type { StyleConfig } from "../../style/config.js";
import type { BannedPhrase } from "../../style/slop.js";
import { buildContext, ContextBudgetError, type ContextBlock } from "../context/builder.js";
import { Redactor } from "../context/redact.js";
import { buildSystemPrompt } from "../context/system-prompt.js";
import { estimateTokens } from "../context/tokens.js";
import type { ToolRegistry } from "../registry.js";
import type { RunScope } from "../scope.js";
import { historyBlocks, NUDGE_MARKER, NUDGE_TEXT } from "./history.js";
import { RunRepo, type PendingCall, type RunHeader, type RunStatus, type StepRecord, type StoredCall, type StoredResult } from "./repo.js";
import { RunAbortedError, type ModelDriver } from "./types.js";

export { NUDGE_MARKER };

export interface RunDeps {
  workspaceId: string;
  policy: Policy;
  ledger: Ledger;
  store: Store;
  registry: ToolRegistry;
  scope: RunScope;
  driver: ModelDriver;
  style: StyleConfig;
  language: string;
  extraBanned?: readonly BannedPhrase[];
  now: () => Date;
  newRunId?: () => string;
  /** How long a running run holds its lease (default 10 minutes). */
  leaseMs?: number;
  contextBudgetTokens?: number;
  reserveOutputTokens?: number;
  staleAfterDays?: number;
  /** Who resumed a run, for the ledger. */
  actor?: string;
  /** Watches the run as it happens (the live view). A throwing observer never affects the run. */
  onEvent?: (event: RunEvent) => void;
}

export interface RunInput {
  task: string;
  surface: UsageSurface;
  slot: SlotName;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  finalText: string;
  steps: number;
  tokens: { input: number; output: number };
  costUsd: number;
  costKnown: boolean;
  pending?: PendingCall;
  proposals: unknown[];
  /** Up to three next steps the agent offered with suggest_next. */
  suggestions?: { label: string; prompt: string }[];
  error?: { kind: string; message: string };
}

const DEFAULT_LEASE_MS = 600_000;
const DEFAULT_CONTEXT_BUDGET = 100_000;
const DEFAULT_RESERVE_OUTPUT = 4096;
const NUDGE_FRACTION = 0.8;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const policyHash = (policy: Policy): string => sha256(canonicalJson(policy));

const STYLE_SURFACE: Record<UsageSurface, Surface> = {
  diagnosis: "internal",
  internal_narration: "internal",
  whatsapp_reply: "whatsapp",
  client_copy: "client_copy",
  other: "internal",
};

const STOP_REASON: Record<string, string> = {
  completed: "done",
  needs_human: "approval_required",
  max_steps_reached: "max_steps",
  max_tokens_reached: "max_tokens",
  max_cost_reached: "max_cost",
  aborted: "aborted",
};

interface Ctx {
  deps: RunDeps;
  repo: RunRepo;
  runId: string;
  redactor: Redactor;
  signal: AbortSignal;
  /** A pending call a human has approved for this resume. */
  approveCallId?: string;
  /** A pending call a human has declined for this resume: it is not run, and the model is told. */
  denyCallId?: string;
}

export const OWNER_DECLINED = "The owner declined this change. Do not send the same text again; ask what they would like different.";
const ALREADY_DECLINED = "The owner already declined this exact change earlier in this run. Do not send it again; ask what they would like different.";
const MAX_DIFF_CHARS = 4000;

/** True when an earlier call in this run, with the same tool and the same input, was declined by the owner. */
function declinedBefore(steps: StepRecord[], call: StoredCall): boolean {
  const key = canonicalJson(call.input);
  return steps.some((s) =>
    s.tool_results.some(
      (r) => r.error?.kind === "denied" && /^The owner (?:already )?declined/.test(r.error.message) && s.tool_calls.some((c) => c.call_id === r.call_id && c.name === call.name && canonicalJson(c.input) === key),
    ),
  );
}

/** Tell the observer, if any; its bugs stay its own. */
function emit(ctx: Ctx, event: RunEvent): void {
  try {
    ctx.deps.onEvent?.(event);
  } catch {
    // an observer must never break a run
  }
}

const redactValue = (redactor: Redactor, value: unknown): unknown => {
  if (value === undefined) return undefined;
  const redacted = redactor.redact(JSON.stringify(value)).text;
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
};

/** A file stamped later than "now" (clock skew, a copied file) is stamped "now" instead of breaking the run. */
const notInTheFuture = (asOf: string, now: Date): string => (Date.parse(asOf) > now.getTime() ? now.toISOString() : asOf);

const errorKind = (error: unknown) => (error instanceof AllTargetsFailedError ? (error.attempts[error.attempts.length - 1]?.kind ?? "failed") : classifyError(error) === "other" ? "failed" : classifyError(error));
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);

export async function startRun(deps: RunDeps, input: RunInput, signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
  const repo = new RunRepo(deps.store);
  const runId = deps.newRunId?.() ?? `run_${randomBytes(5).toString("hex")}`;
  const redactor = new Redactor();
  const task = redactor.redact(input.task).text;
  const { limits, raised } = effectiveRunLimits(deps.policy);

  repo.create({
    runId,
    workspaceId: deps.workspaceId,
    surface: input.surface,
    slot: input.slot,
    task,
    language: deps.language,
    policyHash: policyHash(deps.policy),
    limits: { max_steps: limits.max_steps, max_tokens: limits.max_tokens, max_cost_usd: limits.max_cost_usd },
    now: deps.now(),
  });
  // Raising a cap above the engine default is always visible, before the first step can run.
  if (raised.length > 0) {
    await deps.ledger.append({ actor: `agent:${runId}`, event: "run_limits_elevated", payload: { run_id: runId, raised } });
  }
  await deps.ledger.append({
    actor: `agent:${runId}`,
    event: "run.started",
    payload: { run_id: runId, workspace: deps.workspaceId, surface: input.surface, slot: input.slot, policy_hash: policyHash(deps.policy), limits },
  });
  return drive({ deps, repo, runId, redactor, signal });
}

/** Shared by start and resume: finish any half-done step, then loop until the run stops. */
export async function drive(ctx: Ctx): Promise<RunResult> {
  const { deps, repo, runId } = ctx;
  emit(ctx, { type: "run.started", run_id: runId, slot: repo.require(runId).slot });
  try {
    // A step with a call that has no finished result: crashed before its tools ran, or paused for a human.
    const half = repo.steps(runId).find((s) => s.phase === "model_done" || s.tool_calls.some((c) => !s.tool_results.some((r) => r.call_id === c.call_id && r.status === "done")));
    if (half) {
      const outcome = await executeCalls(ctx, half);
      if (outcome === "aborted") return finish(ctx, "aborted");
      if (outcome === "needs_human") return finish(ctx, "needs_human");
    }

    for (;;) {
      const header = repo.require(runId);
      const capped = capStop(header);
      if (capped) return finish(ctx, capped);
      if (ctx.signal.aborted) return finish(ctx, "aborted");

      repo.setLease(runId, new Date(deps.now().getTime() + (deps.leaseMs ?? DEFAULT_LEASE_MS)));
      const nudge = header.nudged || shouldNudge(header);
      if (nudge && !header.nudged) repo.setNudged(runId);
      const stepIndex = header.steps_done + 1;

      let prompt: ReturnType<typeof assemble>;
      try {
        prompt = assemble(ctx, header, nudge);
      } catch (error) {
        if (error instanceof ContextBudgetError) return finish(ctx, "failed", { error: { kind: "context_budget", message: error.message } });
        throw error;
      }

      emit(ctx, { type: "step.started", step: stepIndex, max_steps: header.limits.max_steps });
      const started = Date.now();
      let result;
      try {
        result = await deps.driver.step({ system: prompt.system, messages: prompt.messages, tools: deps.registry.specs(), signal: ctx.signal });
      } catch (error) {
        if (ctx.signal.aborted || error instanceof RunAbortedError) return finish(ctx, "aborted");
        const kind = errorKind(error);
        deps.store.recordUsage({ ts: deps.now().toISOString(), job: `run:${runId}`, slot: header.slot, surface: header.surface, provider: "unknown", model: "unknown", latencyMs: Date.now() - started, ok: false, errorKind: kind });
        return finish(ctx, "failed", { error: { kind, message: errorMessage(error) } });
      }

      const target = `${result.model.provider}/${result.model.model}`;
      for (const f of result.failovers) {
        await deps.ledger.append({ actor: `agent:${runId}`, event: "model.failover", payload: { run_id: runId, step: stepIndex, from: f.from, to: target, kind: f.kind, message: f.message } });
      }
      const text = cleanAnswer(ctx.redactor.redact(result.text).text);
      const calls: StoredCall[] = result.toolCalls.map((c, i) => ({ call_id: `c${stepIndex}_${i + 1}`, name: c.name, input: redactValue(ctx.redactor, c.input) }));

      // Phase 1: the model has answered and been billed. Save it before touching any tool.
      repo.beginStep(runId, stepIndex, { assistantText: text, toolCalls: calls, usage: result.usage, model: result.model, costUsd: result.costUsd, costKnown: result.costUsd !== null, nudge, now: deps.now() });
      if (text.trim() !== "") emit(ctx, { type: "step.text", step: stepIndex, text });
      deps.store.recordUsage({
        ts: deps.now().toISOString(),
        job: `run:${runId}`,
        slot: header.slot,
        surface: header.surface,
        provider: result.model.provider,
        model: result.model.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedTokens: result.usage.cachedTokens,
        reasoningTokens: result.usage.reasoningTokens,
        ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
        latencyMs: result.latencyMs,
        ok: true,
      });

      if (calls.length === 0) {
        if (text.trim() === "") {
          repo.completeStep(runId, stepIndex, [], deps.now());
          return finish(ctx, "failed", { error: { kind: "empty_response", message: "the model returned neither text nor a tool call" } });
        }
        repo.completeStep(runId, stepIndex, [], deps.now());
        return finish(ctx, "completed", { finalText: text });
      }

      const step = repo.steps(runId).find((s) => s.step_index === stepIndex) as StepRecord;
      const outcome = await executeCalls(ctx, step);
      if (outcome === "aborted") return finish(ctx, "aborted");
      if (outcome === "needs_human") return finish(ctx, "needs_human");
      // A turn that wrote its answer and offered next steps is the last turn. Another model call would only repeat itself.
      if (text.trim() !== "" && offersNextSteps(repo.steps(runId).find((s) => s.step_index === stepIndex))) return finish(ctx, "completed", { finalText: text });
    }
  } catch (error) {
    // Anything unexpected still ends the run cleanly, with what was saved intact.
    return finish(ctx, "failed", { error: { kind: "internal", message: errorMessage(error) } });
  }
}

/** True when the step's only tool calls are suggest_next and every one of them was accepted. */
function offersNextSteps(step: StepRecord | undefined): boolean {
  if (!step || step.tool_calls.length === 0) return false;
  return step.tool_calls.every((c) => c.name === "suggest_next" && step.tool_results.some((r) => r.call_id === c.call_id && r.status === "done" && r.ok));
}

/** Some models copy the history log's "Tool calls: ..." line into their answer; the owner should never see it. */
export function cleanAnswer(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*Tool calls?:/i.test(line))
    .join("\n")
    .trimEnd();
}

function capStop(header: RunHeader): RunStatus | undefined {
  if (header.steps_done >= header.limits.max_steps) return "max_steps_reached";
  if (header.input_tokens + header.output_tokens >= header.limits.max_tokens) return "max_tokens_reached";
  if (header.cost_usd >= header.limits.max_cost_usd) return "max_cost_reached";
  return undefined;
}

function shouldNudge(header: RunHeader): boolean {
  const stepsAt = Math.max(1, Math.floor(NUDGE_FRACTION * header.limits.max_steps));
  return (
    header.steps_done >= stepsAt ||
    header.input_tokens + header.output_tokens >= NUDGE_FRACTION * header.limits.max_tokens ||
    header.cost_usd >= NUDGE_FRACTION * header.limits.max_cost_usd
  );
}

function assemble(ctx: Ctx, header: RunHeader, nudge: boolean) {
  const { deps } = ctx;
  const surface = STYLE_SURFACE[header.surface];
  const blocks: ContextBlock[] = [
    {
      id: "system",
      tier: 0,
      role: "system",
      kind: "system",
      label: "system",
      text: buildSystemPrompt({ workspaceId: deps.workspaceId, surface, language: header.language, policy: deps.policy, style: deps.style, tools: deps.registry.specs().map((t) => t.name), ...(deps.extraBanned ? { extraBanned: deps.extraBanned } : {}) }),
      trust: "trusted",
    },
    { id: "task", tier: 1, role: "user", kind: "task", label: "task", text: header.task, trust: "trusted", workspaceId: deps.workspaceId },
    ...historyBlocks(ctx.repo.steps(ctx.runId), deps.workspaceId),
  ];
  if (nudge) blocks.push({ id: "nudge", tier: 1, role: "user", kind: "task", label: "budget notice", text: NUDGE_TEXT, trust: "trusted", workspaceId: deps.workspaceId });

  const toolSchemaTokens = estimateTokens(JSON.stringify(deps.registry.specs()));
  const built = buildContext(blocks, {
    workspaceId: deps.workspaceId,
    budgetTokens: deps.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET,
    reserveOutputTokens: (deps.reserveOutputTokens ?? DEFAULT_RESERVE_OUTPUT) + toolSchemaTokens,
    now: deps.now(),
    redactor: ctx.redactor,
    ...(deps.staleAfterDays === undefined ? {} : { staleAfterDays: deps.staleAfterDays }),
  });

  // Providers want alternating user and assistant turns: tool results are user-side text, and
  // neighbours with the same role are merged.
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of built.messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.content}`;
    else messages.push({ role, content: m.content });
  }
  if (messages.length === 0 || messages[0]!.role !== "user") messages.unshift({ role: "user", content: header.task });
  return { system: built.system, messages };
}

/** Run the calls of one step that have no result yet. Returns how the step ended. */
async function executeCalls(ctx: Ctx, step: StepRecord): Promise<"complete" | "needs_human" | "aborted"> {
  const { deps, repo, runId } = ctx;
  const header = repo.require(runId);
  const results: StoredResult[] = [];
  let pending: PendingCall | undefined;

  for (const call of step.tool_calls) {
    const existing = step.tool_results.find((r) => r.call_id === call.call_id);
    if (existing && existing.status === "done") {
      results.push(existing);
      continue;
    }
    if (pending) {
      results.push({ call_id: call.call_id, name: call.name, status: "skipped", ok: false, trust: "trusted" });
      continue;
    }
    emit(ctx, { type: "tool.started", step: step.step_index, call_id: call.call_id, name: call.name, class: deps.registry.specs().find((t) => t.name === call.name)?.class ?? "unknown", input_hash: sha256(canonicalJson(call.input)).slice(0, 12) });
    // A person said no to this call, or already said no to this exact one earlier in the run: it is not run, and not asked again.
    const refusal = call.call_id === ctx.denyCallId ? OWNER_DECLINED : declinedBefore(repo.steps(runId), call) ? ALREADY_DECLINED : undefined;
    if (refusal !== undefined) {
      const card = cardFor(call.name, call.input, undefined, false, "denied");
      emit(ctx, { type: "tool.finished", step: step.step_index, call_id: call.call_id, name: call.name, ok: false, label: card.label, summary: card.summary, error_kind: "denied" });
      results.push({ call_id: call.call_id, name: call.name, status: "done", ok: false, error: { kind: "denied", message: refusal }, trust: "trusted" });
      continue;
    }
    const outcome = await deps.registry.invoke(
      { name: call.name, input: call.input },
      { runId, step: step.step_index, scope: deps.scope, signal: ctx.signal, ...(call.call_id === ctx.approveCallId ? { approveAsk: true } : {}) },
    );
    if (ctx.signal.aborted) return "aborted";
    // Show the person what would change. A call that could not succeed anyway goes back to the model, not to a person.
    const shown = !outcome.ok && outcome.error.kind === "approval_required" ? await deps.registry.preview({ name: call.name, input: call.input }) : undefined;
    const bounced = shown !== undefined && !shown.ok ? shown.message : undefined;
    const kindShown = bounced !== undefined ? "invalid_input" : outcome.ok ? undefined : outcome.error.kind;
    const card = cardFor(call.name, call.input, outcome.ok ? outcome.output : undefined, outcome.ok, kindShown);
    emit(ctx, { type: "tool.finished", step: step.step_index, call_id: call.call_id, name: call.name, ok: outcome.ok, label: card.label, summary: card.summary, ...(kindShown === undefined ? {} : { error_kind: kindShown }) });
    if (!outcome.ok && outcome.error.kind === "approval_required") {
      if (shown === undefined || !shown.ok) {
        results.push({ call_id: call.call_id, name: call.name, status: "done", ok: false, error: { kind: "invalid_input", message: bounced ?? "could not be checked" }, trust: "trusted" });
        continue;
      }
      emit(ctx, { type: "permission.requested", call_id: call.call_id, tool: call.name, summary: shown.preview.summary, ...(shown.preview.diff === undefined ? {} : { diff: shown.preview.diff.slice(0, MAX_DIFF_CHARS) }) });
      pending = { callId: call.call_id, tool: call.name, step: step.step_index };
      results.push({ call_id: call.call_id, name: call.name, status: "pending_approval", ok: false, error: outcome.error, trust: "trusted" });
      continue;
    }
    if (outcome.ok) {
      const out = outcome.output as { source?: unknown; as_of?: unknown } | null;
      results.push({
        call_id: call.call_id,
        name: call.name,
        status: "done",
        ok: true,
        output: redactValue(ctx.redactor, outcome.output),
        trust: outcome.trust,
        ...(typeof out?.source === "string" ? { source: out.source } : {}),
        ...(typeof out?.as_of === "string" ? { as_of: notInTheFuture(out.as_of, deps.now()) } : {}),
      });
    } else {
      results.push({ call_id: call.call_id, name: call.name, status: "done", ok: false, error: outcome.error, trust: "trusted" });
    }
  }

  repo.completeStep(runId, step.step_index, results, deps.now());
  if (pending) {
    repo.setStatus(runId, "running", { now: deps.now(), pending });
    return "needs_human";
  }
  void header;
  return "complete";
}

async function finish(ctx: Ctx, status: RunStatus, extra: { finalText?: string; error?: { kind: string; message: string } } = {}): Promise<RunResult> {
  const { deps, repo, runId } = ctx;
  const header = repo.require(runId);
  const steps = repo.steps(runId);
  const finalText = extra.finalText ?? [...steps].reverse().find((s) => s.assistant_text.trim() !== "")?.assistant_text ?? "";
  const pending = status === "needs_human" ? header.pending : null;
  repo.setStatus(runId, status, {
    now: deps.now(),
    stopReason: extra.error ? extra.error.kind : (STOP_REASON[status] ?? status),
    finalText,
    pending,
    error: extra.error ?? null,
  });
  const after = repo.require(runId);
  await deps.ledger.append({
    actor: `agent:${runId}`,
    event: "run.finished",
    payload: {
      run_id: runId,
      status,
      steps: after.steps_done,
      tokens: { input: after.input_tokens, output: after.output_tokens },
      cost_usd: after.cost_usd,
      cost_known: after.cost_known,
      stop_reason: after.stop_reason,
      ...(pending ? { pending } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    },
  });
  const proposals = collectProposals(steps.length === 0 ? [] : repo.steps(runId));
  const suggestions = collectSuggestions(steps.length === 0 ? [] : repo.steps(runId));
  emit(ctx, {
    type: "run.finished",
    status,
    steps: after.steps_done,
    tokens: { input: after.input_tokens, output: after.output_tokens },
    cost_usd: after.cost_usd,
    cost_known: after.cost_known,
    final_text: finalText,
    proposals: proposals.length,
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(pending ? { pending: { call_id: pending.callId, tool: pending.tool } } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });
  return {
    runId,
    status,
    finalText,
    steps: after.steps_done,
    tokens: { input: after.input_tokens, output: after.output_tokens },
    costUsd: after.cost_usd,
    costKnown: after.cost_known,
    ...(pending ? { pending } : {}),
    proposals,
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

/** The options from the most recent successful suggest_next call (the tool has already checked them). */
export function collectSuggestions(steps: StepRecord[]): { label: string; prompt: string }[] {
  for (const step of [...steps].reverse()) {
    for (const result of [...step.tool_results].reverse()) {
      if (result.name === "suggest_next" && result.ok) {
        const actions = (result.output as { actions?: unknown } | undefined)?.actions;
        if (Array.isArray(actions)) return actions as { label: string; prompt: string }[];
      }
    }
  }
  return [];
}

/** The proposals from the most recent successful propose_plan_actions call. */
export function collectProposals(steps: StepRecord[]): unknown[] {
  for (const step of [...steps].reverse()) {
    for (const result of [...step.tool_results].reverse()) {
      if (result.name === "propose_plan_actions" && result.ok) {
        const proposals = (result.output as { proposals?: unknown } | undefined)?.proposals;
        if (Array.isArray(proposals)) return proposals;
      }
    }
  }
  return [];
}
