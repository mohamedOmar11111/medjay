// The context builder: the one place a prompt is assembled. Everything the model sees passes through
// here, so every guarantee lives here and the agent loop never sees an unstamped, unredacted or
// unspotlighted prompt:
//   - every data block carries source, as_of and trust (mandatory), with its age and a STALE flag
//   - one client per run: a block from another workspace is refused
//   - untrusted content is spotlighted; phone numbers, emails and secrets are redacted first
//   - a token budget with deterministic, priority-ordered compaction:
//       tier 0 system and directives, tier 1 task and tool schemas: never compacted
//       tier 2 recent tool outputs, tier 3 reference context and older steps: compacted, oldest first
//     truncated or elided blocks keep their stamp, so a gap is visible rather than silent
import { randomBytes } from "node:crypto";
import type { ToolOutcome, Trust } from "../registry.js";
import { Redactor, type RedactionCounts } from "./redact.js";
import { neutralize, spotlightFrame } from "./spotlight.js";
import { estimateTokens, truncateToTokens } from "./tokens.js";

export type Tier = 0 | 1 | 2 | 3;
export type BlockRole = "system" | "user" | "assistant" | "tool";
export type BlockKind = "system" | "task" | "tools" | "history" | "file" | "tool_result" | "message";

export interface ContextBlock {
  id: string;
  tier: Tier;
  role: BlockRole;
  kind: BlockKind;
  label: string;
  text: string;
  trust: Trust;
  /** Required on every block that carries workspace data (tier 1 and up). */
  workspaceId?: string;
  /** Required with as_of on files and tool results. */
  source?: string;
  as_of?: string;
  step?: number;
  /** Used instead of a blind cut when reference context has to shrink. */
  summary?: string;
}

export interface ContextMessage {
  role: Exclude<BlockRole, "system">;
  content: string;
  blockId: string;
}

export interface CompactionEntry {
  id: string;
  action: "summarized" | "truncated" | "elided";
  beforeTokens: number;
  afterTokens: number;
}

export interface ContextReport {
  estimatedTokens: number;
  availableTokens: number;
  budgetTokens: number;
  reserveOutputTokens: number;
  compaction: CompactionEntry[];
  redactions: RedactionCounts;
  stale: string[];
  blocks: { id: string; tier: Tier; tokens: number }[];
}

export interface BuiltContext {
  system: string;
  messages: ContextMessage[];
  report: ContextReport;
}

export interface BuildOptions {
  workspaceId: string;
  budgetTokens: number;
  reserveOutputTokens?: number;
  now: Date;
  /** Data older than this many days is flagged STALE. Default 30. */
  staleAfterDays?: number;
  /** Id source for spotlight blocks. Default: 12 random hex characters. Injected in tests. */
  nonce?: () => string;
  /** Share one across a run so placeholders stay consistent between steps. */
  redactor?: Redactor;
}

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export class ContextScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextScopeError";
  }
}

export class ContextBudgetError extends Error {
  constructor(
    readonly protectedTokens: number,
    readonly availableTokens: number,
  ) {
    super(`the system prompt and task need ~${protectedTokens} tokens but only ~${availableTokens} are available; they are never compacted. Raise the budget or shorten the task.`);
    this.name = "ContextBudgetError";
  }
}

const DAY_MS = 86_400_000;
const FUTURE_TOLERANCE_MS = 60_000;
const MIN_KEEP_TOKENS = 150;
const KEEP_FRACTION = 0.25;

interface Rendered {
  block: ContextBlock;
  index: number;
  prefix: string;
  body: string;
  suffix: string;
  state: "full" | "summarized" | "truncated" | "elided";
  originalBodyTokens: number;
  nonce?: string;
}

const tokensOf = (r: Rendered) => estimateTokens(r.prefix + r.body + r.suffix);
const text = (r: Rendered) => r.prefix + r.body + r.suffix;

function validate(blocks: ContextBlock[], options: BuildOptions): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (!block.id) throw new ContextError("a context block has no id");
    if (seen.has(block.id)) throw new ContextError(`duplicate context block id "${block.id}"`);
    seen.add(block.id);
    if (block.tier === 0 && (block.role !== "system" || block.kind !== "system")) throw new ContextError(`block "${block.id}": tier 0 is for system text only`);
    if (block.trust !== "trusted" && block.trust !== "untrusted") throw new ContextError(`block "${block.id}" must say whether it is trusted or untrusted`);
    if (block.kind === "file" || block.kind === "tool_result") {
      if (!block.source) throw new ContextError(`block "${block.id}" has no source: every file and tool result must be stamped`);
      if (!block.as_of) throw new ContextError(`block "${block.id}" has no as_of date: every file and tool result must be stamped`);
    }
    if (block.as_of !== undefined) {
      const when = Date.parse(block.as_of);
      if (Number.isNaN(when)) throw new ContextError(`block "${block.id}": as_of "${block.as_of}" is not a date`);
      if (when > options.now.getTime() + FUTURE_TOLERANCE_MS) throw new ContextError(`block "${block.id}": as_of ${block.as_of} is in the future`);
    }
    if (block.tier >= 1) {
      if (!block.workspaceId) throw new ContextScopeError(`block "${block.id}" does not name its workspace; every data block must`);
      if (block.workspaceId !== options.workspaceId) {
        throw new ContextScopeError(`block "${block.id}" belongs to workspace "${block.workspaceId}", but this run is for "${options.workspaceId}"; one client per run`);
      }
    }
  }
}

export function buildContext(blocks: ContextBlock[], options: BuildOptions): BuiltContext {
  validate(blocks, options);
  const redactor = options.redactor ?? new Redactor();
  const nonce = options.nonce ?? (() => randomBytes(6).toString("hex"));
  const staleAfterDays = options.staleAfterDays ?? 30;
  const reserve = options.reserveOutputTokens ?? 0;
  const available = options.budgetTokens - reserve;
  const redactionsBefore = redactor.counts();
  const stale: string[] = [];

  const rendered: Rendered[] = blocks.map((block, index): Rendered => {
    if (block.tier === 0) {
      return { block, index, prefix: "", body: block.text, suffix: "", state: "full", originalBodyTokens: estimateTokens(block.text) };
    }
    const body = redactor.redact(block.text).text;
    const asOfMs = block.as_of ? Date.parse(block.as_of) : undefined;
    const ageDays = asOfMs === undefined ? undefined : Math.max(0, Math.floor((options.now.getTime() - asOfMs) / DAY_MS));
    const isStale = ageDays !== undefined && ageDays > staleAfterDays;
    if (isStale) stale.push(block.id);

    if (block.trust === "untrusted") {
      const id = nonce();
      const { open, close } = spotlightFrame({ id, source: block.source ?? `block:${block.id}`, asOf: block.as_of ?? options.now.toISOString() });
      return { block, index, prefix: `${open}\n`, body: neutralize(body), suffix: `\n${close}`, state: "full", originalBodyTokens: estimateTokens(body), nonce: id };
    }
    const header =
      block.source && block.as_of
        ? `[${block.source} | as_of ${block.as_of} (${ageDays} days old${isStale ? ", STALE: verify before relying on it" : ""}) | ${block.trust}]\n`
        : "";
    return { block, index, prefix: header, body, suffix: "", state: "full", originalBodyTokens: estimateTokens(body) };
  });

  const total = () => rendered.reduce((sum, r) => sum + tokensOf(r), 0);
  const protectedTokens = rendered.filter((r) => r.block.tier <= 1).reduce((sum, r) => sum + tokensOf(r), 0);
  const compaction: CompactionEntry[] = [];

  const order = (tier: Tier) =>
    rendered
      .filter((r) => r.block.tier === tier)
      .sort((a, b) => (a.block.step ?? 0) - (b.block.step ?? 0) || a.index - b.index);

  const elide = (r: Rendered) => {
    const b = r.block;
    r.body = `[elided to fit the context budget: ${b.label} | ${b.source ?? "no source"} | as_of ${b.as_of ?? "unknown"} | ${b.trust}; call the tool again if you need it]`;
    r.prefix = "";
    r.suffix = "";
    r.state = "elided";
  };
  const shrink = (r: Rendered, mode: "truncate" | "elide") => {
    const before = tokensOf(r);
    if (r.state === "elided") return;
    if (mode === "elide") {
      elide(r);
      compaction.push({ id: r.block.id, action: "elided", beforeTokens: before, afterTokens: tokensOf(r) });
      return;
    }
    if (r.state !== "full") return;
    if (r.block.summary) {
      r.body = `${redactor.redact(r.block.summary).text}\n[summarized from ~${r.originalBodyTokens} tokens]`;
      r.state = "summarized";
      compaction.push({ id: r.block.id, action: "summarized", beforeTokens: before, afterTokens: tokensOf(r) });
      return;
    }
    const keep = Math.max(MIN_KEEP_TOKENS, Math.floor(r.originalBodyTokens * KEEP_FRACTION));
    if (r.originalBodyTokens <= keep) return;
    const cut = truncateToTokens(r.body, keep);
    r.body = `${cut.text}\n[truncated: kept ~${estimateTokens(cut.text)} of ~${r.originalBodyTokens} tokens]`;
    r.state = "truncated";
    compaction.push({ id: r.block.id, action: "truncated", beforeTokens: before, afterTokens: tokensOf(r) });
  };

  const stages: [Tier, "truncate" | "elide"][] = [[3, "truncate"], [3, "elide"], [2, "truncate"], [2, "elide"]];
  for (const [tier, mode] of stages) {
    if (total() <= available) break;
    for (const r of order(tier)) {
      if (total() <= available) break;
      shrink(r, mode);
    }
  }
  if (total() > available) throw new ContextBudgetError(protectedTokens, available);

  const redactionsAfter = redactor.counts();
  return {
    system: rendered.filter((r) => r.block.tier === 0).map(text).join("\n\n"),
    messages: rendered.filter((r) => r.block.tier !== 0).map((r) => ({ role: r.block.role as ContextMessage["role"], content: text(r), blockId: r.block.id })),
    report: {
      estimatedTokens: total(),
      availableTokens: available,
      budgetTokens: options.budgetTokens,
      reserveOutputTokens: reserve,
      compaction,
      redactions: {
        phone: redactionsAfter.phone - redactionsBefore.phone,
        email: redactionsAfter.email - redactionsBefore.email,
        secret: redactionsAfter.secret - redactionsBefore.secret,
      },
      stale,
      blocks: rendered.map((r) => ({ id: r.block.id, tier: r.block.tier, tokens: tokensOf(r) })),
    },
  };
}

/** A tool outcome as a stamped tier-2 block. Failures carry only the error, as trusted text. */
export function toolResultBlock(input: { tool: string; step: number; workspaceId: string; now: Date; outcome: ToolOutcome; callIndex?: number }): ContextBlock {
  const { tool, step, workspaceId, now, outcome } = input;
  const base = { id: `step${step}_${tool}_${input.callIndex ?? 0}`, tier: 2 as const, role: "tool" as const, kind: "tool_result" as const, label: `${tool} (step ${step})`, step, workspaceId };
  if (!outcome.ok) {
    return { ...base, text: `${tool} failed (${outcome.error.kind}): ${outcome.error.message}`, trust: "trusted", source: `tool:${tool}`, as_of: now.toISOString() };
  }
  const output = outcome.output as { source?: unknown; as_of?: unknown } | null;
  const source = typeof output?.source === "string" ? output.source : `tool:${tool}`;
  const asOf = typeof output?.as_of === "string" && !Number.isNaN(Date.parse(output.as_of)) ? output.as_of : now.toISOString();
  return { ...base, text: JSON.stringify(outcome.output ?? null), trust: outcome.trust, source, as_of: asOf };
}
