import type { PolicyResult } from "../shield/evaluate.js";

export class PlanNotFoundError extends Error {
  constructor(number: number) {
    super(`no plan #${number}`);
    this.name = "PlanNotFoundError";
  }
}

export class PlanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanStateError";
  }
}

export class ExpiredError extends Error {
  constructor(number: number, expiresAt: string) {
    super(`plan #${number} expired at ${expiresAt}; compile a new plan`);
    this.name = "ExpiredError";
  }
}

export class HashMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HashMismatchError";
  }
}

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

export class ReplayError extends Error {
  constructor() {
    super("this approval nonce was already used (replay refused)");
    this.name = "ReplayError";
  }
}

export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationError";
  }
}

export class PolicyViolationError extends Error {
  constructor(
    readonly result: PolicyResult,
    context: string,
  ) {
    const failed = result.checks.filter((c) => c.ok === false);
    super(
      `${context}: policy check failed\n${failed
        .map((c) => `  - ${c.rule}${c.action_id ? ` (${c.action_id})` : ""}: ${c.note ?? `limit ${c.limit}, actual ${c.actual}`}`)
        .join("\n")}`,
    );
    this.name = "PolicyViolationError";
  }
}
