// Per-slot failover with hard timeouts, so an unreachable local model or proxy surfaces a clean
// error (or moves on to a fallback) instead of hanging.
import type { ResolvedTarget } from "./slots.js";

export type FailureKind = "timeout" | "connection" | "auth" | "billing" | "transient" | "other";

export interface AttemptFailure {
  target: ResolvedTarget;
  kind: FailureKind;
  message: string;
}

export class AllTargetsFailedError extends Error {
  constructor(readonly attempts: AttemptFailure[]) {
    super(
      `all model targets failed: ${attempts
        .map((a) => `${a.target.provider}/${a.target.model} (${a.kind}: ${a.message})`)
        .join("; ")}`,
    );
    this.name = "AllTargetsFailedError";
  }
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"]);

export function classifyError(error: unknown): FailureKind {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    name?: string;
    code?: string;
    statusCode?: number;
    message?: string;
    cause?: { code?: string };
  };
  const text = typeof error === "string" ? error : (e.message ?? "");
  const code = e.code ?? e.cause?.code;
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  if (/credit balance|insufficient (quota|funds|credit)|exceeded your current quota|billing/i.test(text)) {
    return "billing";
  }
  if (e.statusCode === undefined && ((code && CONNECTION_CODES.has(code)) || /cannot connect|fetch failed|ECONNREFUSED/i.test(text))) {
    return "connection";
  }
  if (e.statusCode === 401 || e.statusCode === 403) return "auth";
  if (e.statusCode !== undefined && (e.statusCode === 408 || e.statusCode === 429 || e.statusCode >= 500)) {
    return "transient";
  }
  return "other";
}

const short = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);

/**
 * Run `run` against each target in order. Timeout, connection, auth, billing and transient
 * failures move on to the next target; any other error (for example an invalid request that
 * would fail everywhere) is rethrown unchanged.
 */
export async function withFallback<T>(
  targets: ResolvedTarget[],
  run: (target: ResolvedTarget, signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; target: ResolvedTarget; attempts: AttemptFailure[] }> {
  if (targets.length === 0) throw new Error("no model targets configured for this slot");
  const attempts: AttemptFailure[] = [];
  for (const target of targets) {
    try {
      const value = await run(target, AbortSignal.timeout(target.timeoutMs));
      return { value, target, attempts };
    } catch (error) {
      const kind = classifyError(error);
      if (kind === "other") throw error;
      attempts.push({ target, kind, message: short(error) });
    }
  }
  throw new AllTargetsFailedError(attempts);
}
