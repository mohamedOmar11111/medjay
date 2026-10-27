// The tool registry: the ONLY way an agent run touches anything. Tools come in four classes and
// none of them can change a platform:
//   read    : look at workspace data (scoped to one client)
//   draft   : produce text for a human (copy, summaries)
//   propose : turn an idea into validated proposals; a plan compiled from them still needs approval
//   context : change one of the four context files the owner fills in; ALWAYS waits for a person
// There is no write class. Changes reach a platform only through plan -> approve -> strike.
//
// Every call goes through one pipeline: lookup, strict input validation, permission (shield policy
// rules per action and resource, client scope on declared paths), execution with a timeout, output
// limits, and a ledger entry (hash of the input, never its content).
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/canonical.js";
import type { Ledger } from "../audit/ledger.js";
import { evaluateRules } from "../shield/evaluate.js";
import type { Policy } from "../shield/policy.js";
import { RunScope, ScopeError } from "./scope.js";

export type ToolClass = "read" | "draft" | "propose" | "context";
export const TOOL_CLASSES: readonly ToolClass[] = ["read", "draft", "propose", "context"];

export type Trust = "trusted" | "untrusted";

export type ToolErrorKind = "unknown_tool" | "invalid_input" | "denied" | "approval_required" | "scope" | "timeout" | "failed";

export interface ToolContext {
  runId: string;
  step: number;
  scope: RunScope;
  signal: AbortSignal;
  now: () => Date;
}

export interface ToolDef<S extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  description: string;
  class: ToolClass;
  /** Strict schema: unknown keys are errors. */
  input: S;
  /** Workspace-relative paths the call will touch; checked against the client scope before it runs. */
  paths?: (input: z.infer<S>) => string[];
  /** Resources for policy rules (for example "meta:adset/123"), besides tool:<name> and client:<name>. */
  resources?: (input: z.infer<S>) => string[];
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<O>;
  /** Whether the OUTPUT may carry instructions from outside. Default: untrusted (fail closed). */
  trustOf?: (input: z.infer<S>, output: O, ctx: ToolContext) => Trust;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Identity helper that keeps the input type flowing into the other fields. */
export const defineTool = <S extends z.ZodType, O>(def: ToolDef<S, O>): ToolDef<S, O> => def;

export interface ToolSpec {
  name: string;
  description: string;
  class: ToolClass;
  input_schema: unknown;
}

export interface RunContext {
  runId: string;
  step: number;
  scope: RunScope;
  signal?: AbortSignal;
  /**
   * A human approved this one call: an `ask` becomes allowed (logged as approved_once). It never
   * overrides a deny or a forbidden action, and it does not carry over to any other call.
   */
  approveAsk?: boolean;
}

export type ToolOutcome =
  | { ok: true; output: unknown; trust: Trust; durationMs: number }
  | { ok: false; error: { kind: ToolErrorKind; message: string }; durationMs: number };

export interface RegistryDeps {
  policy: Policy;
  ledger: Ledger;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const NAME = /^[a-z][a-z0-9_]{1,47}$/;
// A mislabelled tool must not slip in: names that read like a write are refused outright.
const WRITE_LIKE = /^(?:write|delete|remove|update|create|set|put|patch|post|publish|send|execute|exec|run|shell|strike|approve|apply|deploy|pause|resume|enable|disable|edit|modify|upload|install)(?:_|$)/;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 300);

function hashInput(input: unknown): string {
  try {
    return sha256(canonicalJson(input));
  } catch {
    return "unhashable";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private readonly now: () => Date;

  constructor(private readonly deps: RegistryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  register<S extends z.ZodType, O>(definition: ToolDef<S, O>): void {
    const tool = definition as unknown as ToolDef;
    if (!NAME.test(tool.name)) throw new Error(`invalid tool name "${tool.name}": use lowercase letters, digits and underscores (2-48 characters)`);
    if (!TOOL_CLASSES.includes(tool.class)) throw new Error(`invalid tool class "${String(tool.class)}": tools are read, draft, propose or context; there is no write class`);
    if (WRITE_LIKE.test(tool.name)) throw new Error(`tool name "${tool.name}" reads like a write; agents cannot write. Changes go through a plan`);
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, class: t.class, input_schema: z.toJSONSchema(t.input) }));
  }

  async invoke(call: { name: string; input: unknown }, run: RunContext): Promise<ToolOutcome> {
    const started = Date.now();
    const duration = () => Date.now() - started;
    const tool = this.tools.get(call.name);
    const log = (fields: Record<string, unknown>) => this.log(call.name, tool?.class, run, fields);

    if (!tool) {
      await log({ decision: "none", ok: false, error_kind: "unknown_tool", input_sha256: hashInput(call.input), duration_ms: duration() });
      return { ok: false, error: { kind: "unknown_tool", message: `no tool named "${call.name}"` }, durationMs: duration() };
    }

    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const message = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
      await log({ decision: "none", ok: false, error_kind: "invalid_input", input_sha256: hashInput(call.input), duration_ms: duration() });
      return { ok: false, error: { kind: "invalid_input", message }, durationMs: duration() };
    }
    const input = parsed.data;
    const inputHash = hashInput(input);

    const resources = [...(tool.resources?.(input) ?? []), `tool:${tool.name}`, ...(run.scope.client ? [`client:${run.scope.client}`] : [])];
    const policyDecision = this.decide(tool, resources);
    const approvedOnce = policyDecision === "ask" && run.approveAsk === true;
    const decision = approvedOnce ? "allow" : policyDecision;
    const allowLabel = approvedOnce ? "approved_once" : "allow";
    if (decision !== "allow") {
      const kind: ToolErrorKind = decision === "deny" ? "denied" : "approval_required";
      await this.log(call.name, tool.class, run, { decision, ok: false, error_kind: kind, input_sha256: inputHash, resources, duration_ms: duration() }, decision === "deny" ? "tool.denied" : "tool.invoked");
      return {
        ok: false,
        error: { kind, message: decision === "deny" ? `policy denies ${tool.class}.${tool.name}` : `policy requires a human to allow ${tool.class}.${tool.name}` },
        durationMs: duration(),
      };
    }

    try {
      for (const rel of tool.paths?.(input) ?? []) run.scope.assertAllowed(rel);
    } catch (error) {
      const message = error instanceof ScopeError ? error.message : "path check failed";
      await log({ decision: allowLabel, ok: false, error_kind: "scope", input_sha256: inputHash, resources, duration_ms: duration() });
      return { ok: false, error: { kind: "scope", message }, durationMs: duration() };
    }

    const timeoutMs = tool.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = run.signal ? AbortSignal.any([timeout, run.signal]) : timeout;
    const ctx: ToolContext = { runId: run.runId, step: run.step, scope: run.scope, signal, now: this.now };

    let outcome: ToolOutcome;
    try {
      const output = await Promise.race([
        tool.execute(input, ctx),
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      let serialized: string;
      try {
        serialized = JSON.stringify(output ?? null);
      } catch {
        throw new Error("output cannot be serialized");
      }
      const bytes = Buffer.byteLength(serialized, "utf8");
      const max = tool.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      if (bytes > max) throw new Error(`output is ${bytes} bytes, over the ${max} byte limit; return less or paginate`);
      outcome = { ok: true, output, trust: tool.trustOf ? tool.trustOf(input, output, ctx) : "untrusted", durationMs: duration() };
      await log({ decision: allowLabel, ok: true, input_sha256: inputHash, resources, output_bytes: bytes, trust: outcome.trust, duration_ms: duration() });
    } catch (error) {
      const timedOut = signal.aborted;
      const kind: ToolErrorKind = timedOut ? "timeout" : error instanceof ScopeError ? "scope" : "failed";
      const message = timedOut ? `tool ${tool.name} stopped after ${timeoutMs} ms or by the run` : short(error instanceof Error ? error.message : String(error));
      outcome = { ok: false, error: { kind, message }, durationMs: duration() };
      await log({ decision: allowLabel, ok: false, error_kind: kind, input_sha256: inputHash, resources, duration_ms: duration() });
    }
    return outcome;
  }

  private decide(tool: ToolDef, resources: string[]): "allow" | "deny" | "ask" {
    const { policy } = this.deps;
    const action = `${tool.class}.${tool.name}`;
    if (policy.forbidden_actions.includes(tool.name) || policy.forbidden_actions.includes(action)) return "deny";
    const effects = resources.map((resource) => evaluateRules(policy.rules, action, resource, policy.defaults.effect));
    if (effects.includes("deny")) return "deny";
    // A change to a context file always waits for a person: engine code, so no policy edit can lift it.
    if (tool.class === "context") return "ask";
    return effects.includes("ask") ? "ask" : "allow";
  }

  private async log(tool: string, cls: ToolClass | undefined, run: RunContext, fields: Record<string, unknown>, event: "tool.invoked" | "tool.denied" = "tool.invoked"): Promise<void> {
    await this.deps.ledger.append({
      actor: `agent:${run.runId}`,
      event,
      payload: { run_id: run.runId, step: run.step, tool, ...(cls ? { class: cls } : {}), ...fields },
    });
  }
}
