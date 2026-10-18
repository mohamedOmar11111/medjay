// mdj resume: rebuild a run from its saved steps and carry on from the next one. Steps already saved
// are never re-run and never re-billed; the policy and limits in force NOW apply, and the ledger
// records who resumed what, under which policy.
import { effectiveRunLimits } from "../../shield/policy.js";
import { Redactor } from "../context/redact.js";
import { drive, policyHash, type RunDeps, type RunResult } from "./run.js";
import { RunRepo } from "./repo.js";

export class ResumeError extends Error {}

export interface ResumeOptions {
  /** A human approves exactly this pending call, once. */
  approveTool?: string;
}

const FINISHED = ["completed", "max_steps_reached", "max_tokens_reached", "max_cost_reached"];

export async function resumeRun(deps: RunDeps, runId: string, options: ResumeOptions = {}, signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
  const repo = new RunRepo(deps.store);
  const header = repo.get(runId);
  if (!header) throw new ResumeError(`no run ${runId}`);
  if (header.workspace_id !== deps.workspaceId) throw new ResumeError(`run ${runId} belongs to workspace ${header.workspace_id}, not ${deps.workspaceId}`);
  if (FINISHED.includes(header.status)) throw new ResumeError(`run ${runId} already finished (${header.status}); start a new run instead`);
  if (header.status === "running" && header.lease_until && Date.parse(header.lease_until) > deps.now().getTime()) {
    throw new ResumeError(`run ${runId} is still running (lease until ${header.lease_until}); wait for the lease to expire`);
  }
  if (options.approveTool !== undefined && header.pending?.callId !== options.approveTool) {
    throw new ResumeError(`${options.approveTool} is not the pending call of ${runId}${header.pending ? ` (pending: ${header.pending.callId})` : " (nothing is pending)"}`);
  }

  const steps = repo.steps(runId);
  const redactor = new Redactor();
  redactor.continueFrom([header.task, ...steps.flatMap((s) => [s.assistant_text, JSON.stringify(s.tool_calls), JSON.stringify(s.tool_results)])]);

  const actor = deps.actor ?? "cli";
  const nowHash = policyHash(deps.policy);
  const { limits, raised } = effectiveRunLimits(deps.policy);
  const pendingCall = header.pending;

  if (nowHash !== header.policy_hash) {
    await deps.ledger.append({ actor, event: "run.policy_changed", payload: { run_id: runId, old: header.policy_hash, new: nowHash } });
  }
  if (raised.length > 0) await deps.ledger.append({ actor, event: "run_limits_elevated", payload: { run_id: runId, raised, at: "resume" } });
  if (options.approveTool !== undefined && pendingCall) {
    await deps.ledger.append({ actor, event: "tool.approved_once", payload: { run_id: runId, call_id: pendingCall.callId, tool: pendingCall.tool, step: pendingCall.step } });
  }
  await deps.ledger.append({
    actor,
    event: "run.resumed",
    payload: { run_id: runId, from_status: header.status, steps_done: header.steps_done, policy_hash: nowHash, ...(options.approveTool ? { approved_call: options.approveTool } : {}) },
  });

  repo.reopen(runId, { policyHash: nowHash, limits: { max_steps: limits.max_steps, max_tokens: limits.max_tokens, max_cost_usd: limits.max_cost_usd }, now: deps.now() });
  return drive({ deps, repo, runId, redactor, signal, ...(options.approveTool ? { approveCallId: options.approveTool } : {}) });
}
