// The seam between the agent loop and a model. The loop never talks to a provider; it asks a
// ModelDriver for one step. That keeps the loop testable with a scripted model, and keeps failover,
// timeouts, credentials and stream parsing in one place (the AI SDK driver).
import type { ToolSpec } from "../registry.js";
import type { StepUsageRecord } from "./repo.js";

export type StepUsage = StepUsageRecord;

export interface ModelStepInput {
  system: string;
  /** Alternating user and assistant text. Prior steps arrive as stamped transcript text. */
  messages: { role: "user" | "assistant"; content: string }[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface Failover {
  /** The target that failed, as provider/model. */
  from: string;
  kind: string;
  message: string;
}

export interface ModelStepResult {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  usage: StepUsage;
  /** USD, or null when the model's price is unknown (counted as zero toward the cap, and flagged). */
  costUsd: number | null;
  /** The target that actually answered. */
  model: { provider: string; model: string };
  latencyMs: number;
  /** Targets that failed before this one answered, in order. */
  failovers: Failover[];
  finishReason: string;
}

export interface ModelDriver {
  step(input: ModelStepInput): Promise<ModelStepResult>;
}

/** Thrown by a driver when the run was aborted (Ctrl+C), so the loop saves the run as resumable. */
export class RunAbortedError extends Error {
  constructor() {
    super("run aborted");
    this.name = "RunAbortedError";
  }
}
