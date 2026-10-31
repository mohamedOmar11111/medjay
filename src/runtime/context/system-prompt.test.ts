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

describe("buildSystemPrompt with the growth tools", () => {
  it("tells the agent to scout before it says anything about performance, and to simulate before advising more spend", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", tools: ["growth_scout", "growth_diagnose", "growth_simulate", "read_file"] });
    expect(text).toMatch(/call growth_scout/);
    expect(text).toMatch(/growth_simulate before/);
    expect(text).toMatch(/platform's own|CRM/);
  });
  it("says nothing about them when they are not available", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", tools: ["read_file"] });
    expect(text).not.toMatch(/growth_scout/);
    expect(buildSystemPrompt({ ...base, surface: "internal" })).not.toMatch(/growth_scout/);
  });
});

describe("buildSystemPrompt with skills", () => {
  it("tells the agent to look for a saved skill first, and that a skill adds method but no permissions", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", tools: ["skill_search", "skill_load"] });
    expect(text).toMatch(/skill_search/);
    expect(text).toMatch(/never give you more permissions|cannot give you/i);
  });
  it("says nothing about skills when there are none", () => {
    expect(buildSystemPrompt({ ...base, surface: "internal", tools: ["read_file"] })).not.toMatch(/skill_search/);
  });
});

describe("buildSystemPrompt with drafts", () => {
  it("tells the agent to keep finished work as drafts, that customer-facing ones are checked, and that nothing is sent by saving", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", tools: ["draft_save", "draft_read"] });
    expect(text).toMatch(/draft_save/);
    expect(text).toMatch(/checked/);
    expect(text).toMatch(/sends nothing and publishes nothing/);
  });
  it("says nothing about drafts when the tool is missing", () => {
    expect(buildSystemPrompt({ ...base, surface: "internal", tools: ["read_file"] })).not.toMatch(/draft_save/);
  });
});

describe("buildSystemPrompt guide rules (Guide, Suggest, Act)", () => {
  const all = ["workspace_readiness", "context_update", "suggest_next", "growth_scout", "growth_simulate", "draft_save"];
  const text = (tools: string[]) => buildSystemPrompt({ ...base, surface: "internal", tools });

  it("appears when the workspace check exists, and not otherwise", () => {
    expect(text(all)).toMatch(/Guide, Suggest, Act/);
    expect(text(["read_file", "growth_scout"])).not.toMatch(/Guide, Suggest, Act|workspace_readiness/);
  });

  it("starts with the workspace check when asked what to do, and says never to answer 'I cannot' for missing data", () => {
    const t = text(all);
    expect(t).toMatch(/workspace_readiness first/);
    expect(t).toMatch(/never (?:reply|answer|say)[^.]*cannot/i);
    expect(t).toMatch(/missing/i);
  });

  it("gives the discovery questions in order, two or three at a time, saved as you go", () => {
    const t = text(all);
    const order = ["what you sell", "who it is for", "price and average", "margin, the target", "cost per lead", "claims you may", "brand voice"].map((w) => t.toLowerCase().indexOf(w));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(t).toMatch(/two or three/);
    expect(t).toMatch(/context_update/);
  });

  it("names the tools it relies on: simulate with a spend and no data, and suggest_next last", () => {
    const t = text(all);
    expect(t).toMatch(/growth_simulate[^.]*spend/);
    expect(t).toMatch(/suggest_next/);
    expect(t).toMatch(/gd-|skill/i);
  });

  it("only mentions the tools that exist", () => {
    const t = text(["workspace_readiness"]);
    expect(t).not.toMatch(/context_update|suggest_next|growth_simulate/);
  });

  it("tells the agent a declined change must not be sent again", () => {
    expect(text(all)).toMatch(/declin/i);
  });
});

describe("buildSystemPrompt tool-call format", () => {
  it("says to call tools through the tool interface and never to write a call as text", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", tools: ["read_file"] });
    expect(text).toMatch(/never write a tool call as text/i);
    expect(text).toMatch(/Tool calls:/);
  });
});

describe("buildSystemPrompt retry after a refused save", () => {
  it("tells the agent to fix a refused context_update and send it again before reporting back", () => {
    const text = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "context_update"] });
    expect(text).toMatch(/refuses[^.]*fix[^.]*again/i);
  });
});

describe("buildSystemPrompt setup concierge", () => {
  const t = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "context_update", "suggest_next", "growth_scout"] });
  it("tells the agent to lead the owner step by step: where to go, what to look at, what to save and the exact place", () => {
    expect(t).toMatch(/one step at a time/i);
    expect(t).toMatch(/where to go/i);
    expect(t).toMatch(/what to look at/i);
    expect(t).toMatch(/what to save/i);
    expect(t).toMatch(/exact (?:folder|path)/i);
  });
  it("uses the export guides and says they are unverified, and asks the owner to report what they see", () => {
    expect(t).toMatch(/guides/i);
    expect(t).toMatch(/not been checked|unverified|may differ/i);
  });
  it("then calls growth_scout once the owner says the file is saved, and answers in the owner's language", () => {
    expect(t).toMatch(/growth_scout/);
    expect(t).toMatch(/language/i);
  });
});
