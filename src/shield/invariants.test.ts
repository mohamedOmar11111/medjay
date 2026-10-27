import { describe, expect, it } from "vitest";
import { INVARIANTS, FORBIDDEN_CONFIG_KEYS, canVoiceTrigger, isStrikeConfirmationValid } from "./invariants.js";

describe("engine invariants (not configurable)", () => {
  it("fixes voice and confirmation rules", () => {
    expect(INVARIANTS.voiceMayStrike).toBe(false);
    expect(INVARIANTS.voiceMayChangePolicy).toBe(false);
    expect(INVARIANTS.strikeRequiresTypedOrButton).toBe(true);
    expect(INVARIANTS.confirmationBindsPlanHash).toBe(true);
    expect(INVARIANTS.contextUpdateAlwaysAsks).toBe(true);
  });

  it("is frozen so code cannot flip a rule at runtime", () => {
    expect(Object.isFrozen(INVARIANTS)).toBe(true);
    expect(() => {
      (INVARIANTS as { voiceMayStrike: boolean }).voiceMayStrike = true;
    }).toThrow();
  });

  it("lets voice trigger read and draft jobs only", () => {
    for (const job of ["scout", "diagnose", "simulate", "plan", "status", "pulse"] as const) {
      expect(canVoiceTrigger(job), job).toBe(true);
    }
    for (const job of ["strike", "approve", "policy_change", "cap"] as const) {
      expect(canVoiceTrigger(job), job).toBe(false);
    }
  });

  it("accepts a strike only from typed text or a button tap", () => {
    expect(isStrikeConfirmationValid({ via: "typed" })).toBe(true);
    expect(isStrikeConfirmationValid({ via: "button" })).toBe(true);
    expect(isStrikeConfirmationValid({ via: "voice" })).toBe(false);
    expect(isStrikeConfirmationValid({ via: "voice_transcript" })).toBe(false);
  });

  it("lists config keys that must never appear in workspace.yaml", () => {
    expect(FORBIDDEN_CONFIG_KEYS).toContain("allow_voice_for_strike");
    expect(FORBIDDEN_CONFIG_KEYS).toContain("require_typed_confirmation");
  });
});
