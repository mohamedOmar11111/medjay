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

describe("buildSystemPrompt first conversation", () => {
  const t = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "workspace_profile", "context_update"] });
  it("is added only when the profile tool exists", () => {
    expect(t).toMatch(/needs_profile/);
    expect(buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness"] })).not.toMatch(/needs_profile|workspace_profile/);
  });
  it("tells the agent to open with one open question, not a form or a menu, and to infer what it can", () => {
    expect(t).toMatch(/one open question/i);
    expect(t).toMatch(/not a form|no form|never a (?:form|menu)/i);
    expect(t).toMatch(/infer/i);
  });
  it("says what a country or a language implies, to say what it understood, and to save it with workspace_profile", () => {
    expect(t).toMatch(/country[^.]*currency/i);
    expect(t).toMatch(/what you understood/i);
    expect(t).toMatch(/workspace_profile/);
  });
});

describe("buildSystemPrompt strategist (first conversation with the profile tool)", () => {
  const tools = ["workspace_readiness", "workspace_profile", "context_update", "growth_simulate", "suggest_next"];
  const t = buildSystemPrompt({ ...base, surface: "internal", tools });
  it("is added only when the profile tool exists", () => {
    expect(t).toMatch(/senior growth marketer/i);
    expect(buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness"] })).not.toMatch(/senior growth marketer/i);
  });
  it("says back the business and the money lever, then challenges up to two plans with a reason, an alternative and what would change its mind", () => {
    expect(t).toMatch(/biggest money lever/i);
    expect(t).toMatch(/up to two/i);
    expect(t).toMatch(/what would change your mind/i);
  });
  it("shows a six-step plan every turn and asks at most two questions", () => {
    expect(t).toMatch(/\[done\], \[now\] or \[next\]/);
    expect(t).toMatch(/at most two questions/i);
  });
  it("applies market knowledge as a labelled starting assumption, and picks the channel for the first budget", () => {
    expect(t).toMatch(/my starting assumption/i);
    expect(t).toMatch(/WhatsApp/);
    expect(t).toMatch(/runner-up/i);
  });
  it("writes full drafts after the interview: offer matrix, ads in the owner's language, landing page, never published", () => {
    expect(t).toMatch(/offer matrix/i);
    expect(t).toMatch(/3 angles x 2 variants/);
    expect(t).toMatch(/landing page/i);
    expect(t).toMatch(/nothing is published/i);
  });
  it("asks once whether it is the owner or an agency setting up a client", () => {
    expect(t).toMatch(/owner, or setting this up for a client/i);
  });
  it("never lets an invented number pass as a benchmark, with or without search", () => {
    expect(t).toMatch(/my estimate, verify/);
    expect(t).not.toMatch(/web_search/);
  });
});

describe("buildSystemPrompt web search", () => {
  const withSearch = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "workspace_profile", "web_search"] });
  it("is added only when the search tool exists", () => {
    expect(withSearch).toMatch(/web_search/);
    expect(buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness"] })).not.toMatch(/web_search/);
  });
  it("searches the vertical and market before choosing a channel or quoting a figure", () => {
    expect(withSearch).toMatch(/before (?:you )?choos\w+ a channel/i);
  });
  it("quotes a benchmark only from a search result, with its source and year, and shows disagreement as a range", () => {
    expect(withSearch).toMatch(/only[^.]*search result/i);
    expect(withSearch).toMatch(/\[metric\], \[vertical\], \[country\]: \[low\]-\[high\] \[currency\] \(\[source\], \[year\]\)/);
    expect(withSearch).toMatch(/disagree[^.]*range/i);
  });
  it("keeps the owner's private details out of the query and treats results as data", () => {
    expect(withSearch).toMatch(/never put[^.]*(?:private|owner)[^.]*query/i);
    expect(withSearch).toMatch(/data, never (?:as )?instructions/i);
  });
});

describe("buildSystemPrompt first reply sequence", () => {
  it("saves the profile in the same turn instead of waiting for a yes, because the owner approves the save anyway", () => {
    const t = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "workspace_profile"] });
    expect(t).toMatch(/call workspace_profile in the same turn/i);
  });
  it("searches in the first reply after the owner describes the business, before answering", () => {
    const t = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "workspace_profile", "web_search"] });
    expect(t).toMatch(/first reply[^.]*web_search/i);
    expect(t).toMatch(/before you answer/i);
  });
});

describe("buildSystemPrompt search is run, not announced", () => {
  it("forbids saying a search will happen and then stopping", () => {
    const t = buildSystemPrompt({ ...base, surface: "internal", tools: ["workspace_readiness", "workspace_profile", "web_search"] });
    expect(t).toMatch(/never (?:say|announce)[^.]*(?:search|look)[^.]*(?:then )?(?:stop|end)/i);
    expect(t).toMatch(/answer comes after the results/i);
  });
});
