import { describe, expect, it } from "vitest";
import { PolicySchema } from "../../shield/policy.js";
import { StyleConfigSchema } from "../../style/config.js";
import { buildSystemPrompt } from "./system-prompt.js";

const policy = PolicySchema.parse({
  limits: { max_daily_budget_increase_pct: 20, max_total_spend_cap: { amount: 1500, currency: "USD", period: "day", scope: "workspace" } },
  forbidden_actions: ["delete_campaign"],
  runtime_limits: { max_steps: 8, max_tokens: 90_000, max_cost_usd: 0.5 },
});
const style = StyleConfigSchema.parse({});
const base = { workspaceId: "etlaala-ksa", policy, style, language: "en" };

describe("buildSystemPrompt", () => {
  it("states what the agent can and cannot do", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal" });
    expect(text).toMatch(/cannot change any ad account/i);
    expect(text).toMatch(/proposal/i);
    expect(text).toMatch(/human approves/i);
  });

  it("requires sources and dates, and a stop for a human when a tool needs approval", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal" });
    expect(text).toMatch(/source/i);
    expect(text).toMatch(/as_of/);
    expect(text).toMatch(/approval_required/);
  });

  it("includes the untrusted-data instruction", () => {
    expect(buildSystemPrompt({ ...base, surface: "internal" })).toMatch(/untrusted_data/);
  });

  it("summarizes the limits the run lives under", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal" });
    expect(text).toMatch(/8 steps/);
    expect(text).toMatch(/90000 tokens|90,000 tokens/);
    expect(text).toMatch(/0\.5/);
    expect(text).toMatch(/20%/);
    expect(text).toMatch(/1500 USD/);
    expect(text).toMatch(/delete_campaign/);
  });

  it("names the client workspace and never any other", () => {
    expect(buildSystemPrompt({ ...base, surface: "internal" })).toContain("etlaala-ksa");
  });

  it("adds the terse directive on narration surfaces and not on client copy, approvals or security", () => {
    expect(buildSystemPrompt({ ...base, surface: "internal" })).toMatch(/Drop articles/);
    expect(buildSystemPrompt({ ...base, surface: "whatsapp" })).toMatch(/keep articles/i);
    for (const surface of ["client_copy", "approval", "security"] as const) {
      expect(buildSystemPrompt({ ...base, surface }), surface).not.toMatch(/Drop articles|keep articles and full sentences/);
    }
  });

  it("adds the anti-slop rules for customer-facing copy, with the brand's own forbidden phrases", () => {
    const text = buildSystemPrompt({ ...base, surface: "client_copy", extraBanned: [{ phrase: "premium experience" }] });
    expect(text).toMatch(/leverage/);
    expect(text).toContain("premium experience");
    expect(buildSystemPrompt({ ...base, surface: "internal" })).not.toMatch(/leverage -> use/);
  });

  it("caps the terse directive at lite for non-English", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", language: "ar" });
    expect(text).not.toMatch(/Drop articles/);
    expect(text).toMatch(/user's language/i);
  });

  it("is deterministic", () => {
    expect(buildSystemPrompt({ ...base, surface: "internal" })).toBe(buildSystemPrompt({ ...base, surface: "internal" }));
  });
});
