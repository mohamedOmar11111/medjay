// Turns saved steps back into context blocks. History is replayed as stamped transcript text rather
// than provider-specific tool messages: it works with every provider, compacts cleanly, and means a
// resumed run sees exactly what an uninterrupted one would have. The last two steps are "recent"
// (tier 2); older steps are reference context (tier 3) and are the first to be compacted.
import type { ContextBlock } from "../context/builder.js";
import type { StepRecord, StoredResult } from "./repo.js";

const RECENT_STEPS = 2;

export const NUDGE_MARKER = "Runtime notice:";
export const NUDGE_TEXT =
  `${NUDGE_MARKER} you have used 80% or more of this run's budget (steps, tokens or cost). ` +
  "Do not start new exploratory reads. Synthesize your findings now, call propose_plan_actions if you have proposals ready, " +
  "and conclude with your final answer in this reply.";

const describeCall = (call: { call_id: string; name: string; input: unknown }) => `${call.call_id} ${call.name} ${JSON.stringify(call.input)}`;

function resultText(result: StoredResult): string {
  if (result.status === "pending_approval") return `${result.name} is waiting for a human to allow it; it has not run.`;
  if (result.status === "skipped") return `${result.name} was not run because an earlier call in the same step needed approval.`;
  if (!result.ok) return `${result.name} failed (${result.error?.kind ?? "error"}): ${result.error?.message ?? "no detail"}`;
  return JSON.stringify(result.output ?? null);
}

export function historyBlocks(steps: StepRecord[], workspaceId: string): ContextBlock[] {
  const last = steps.length === 0 ? 0 : Math.max(...steps.map((s) => s.step_index));
  const blocks: ContextBlock[] = [];
  for (const step of steps) {
    const tier = step.step_index > last - RECENT_STEPS ? 2 : 3;
    const lines = [
      step.assistant_text,
      step.tool_calls.length > 0 ? `Tool calls: ${step.tool_calls.map(describeCall).join("; ")}` : "",
    ].filter(Boolean);
    if (lines.length > 0) {
      blocks.push({ id: `step${step.step_index}_assistant`, tier, role: "assistant", kind: "history", label: `your step ${step.step_index}`, text: lines.join("\n"), trust: "trusted", workspaceId, step: step.step_index });
    }
    for (const result of step.tool_results) {
      const out = result.output as { source?: unknown; as_of?: unknown } | undefined;
      blocks.push({
        id: `step${step.step_index}_${result.call_id}`,
        tier,
        role: "tool",
        kind: "tool_result",
        label: `${result.name} result ${result.call_id}`,
        text: resultText(result),
        trust: result.trust,
        workspaceId,
        step: step.step_index,
        source: result.source ?? (typeof out?.source === "string" ? out.source : `tool:${result.name}`),
        as_of: result.as_of ?? (typeof out?.as_of === "string" ? out.as_of : step.created_at),
      });
    }
  }
  return blocks;
}
