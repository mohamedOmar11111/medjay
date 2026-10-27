// Engine invariants: rules the Shield enforces that no configuration file can change.
// They are code, not config, so a one-line YAML edit can never make a voice note spend money.

export const INVARIANTS = Object.freeze({
  /** A voice note (or its transcript) can never execute a strike. */
  voiceMayStrike: false,
  /** A voice note can never change shield.policy.yaml limits or approvers. */
  voiceMayChangePolicy: false,
  /** A strike needs an explicit typed command or an interactive button tap. */
  strikeRequiresTypedOrButton: true,
  /** A confirmation is bound to the plan hash it was shown, not just a plan number. */
  confirmationBindsPlanHash: true,
  /** An agent's change to a context file always waits for a person, whatever the policy rules say. */
  contextUpdateAlwaysAsks: true,
} as const);

/** Keys that must never appear in workspace.yaml because the rule they would toggle is fixed. */
export const FORBIDDEN_CONFIG_KEYS: readonly string[] = Object.freeze([
  "allow_voice_for_strike",
  "allow_voice_for_read_jobs",
  "allow_voice_for_policy_change",
  "require_typed_confirmation",
  "include_plan_hash_in_prompt",
]);

/** Read-only and draft jobs a voice note may trigger. Everything else is refused. */
const VOICE_ALLOWED_JOBS: ReadonlySet<string> = new Set(["scout", "diagnose", "simulate", "plan", "status", "pulse"]);

export function canVoiceTrigger(job: string): boolean {
  return VOICE_ALLOWED_JOBS.has(job);
}

export function isStrikeConfirmationValid(confirmation: { via: string }): boolean {
  return confirmation.via === "typed" || confirmation.via === "button";
}
