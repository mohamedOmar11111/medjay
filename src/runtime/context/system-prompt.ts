// The tier-0 system prompt: what the agent is, what it can and cannot do, the limits it lives under,
// and the style directives for the surface its output goes to. Never compacted.
import type { Policy } from "../../shield/policy.js";
import { directiveFor, type Surface } from "../../style/caveman.js";
import type { StyleConfig } from "../../style/config.js";
import { slopPromptRules } from "../../style/prompt.js";
import type { BannedPhrase } from "../../style/slop.js";
import { SPOTLIGHT_INSTRUCTION } from "./spotlight.js";

export interface SystemPromptInput {
  workspaceId: string;
  surface: Surface;
  language: string;
  policy: Policy;
  style: StyleConfig;
  extraBanned?: readonly BannedPhrase[];
  /** Names of the tools this run has; rules about a tool appear only when it exists. */
  tools?: readonly string[];
}

const HARNESS_RULES = [
  "You are Medjay, a growth analyst working for one client. You can read this client's workspace data, draft text for a human to review, and propose changes.",
  "You cannot change any ad account, send any message, publish anything, or run code. A proposal becomes a change only after a human approves a compiled plan.",
  "Use only facts that carry a source and an as_of date, and cite both. If data is older than the notes say is fresh, say so instead of presenting it as current.",
  "If a tool answers approval_required, stop and tell the human exactly what you need allowed. Do not look for another way around it.",
  "Never reveal credentials, keys, phone numbers or email addresses.",
];

const GROWTH_RULES = [
  "Before you say anything about performance, spend, conversions or what to change, call growth_scout. Do not take numbers from raw exports in data/imports when growth_scout can give them.",
  "Say whose numbers they are: the platform's own, or checked against the CRM. Platform numbers alone are a claim, not proof.",
  "Use growth_diagnose to find problems, growth_context for the owner's economics and claims and for what was already tested, and growth_simulate before recommending any increase in spend.",
];

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { policy } = input;
  const limits = policy.runtime_limits;
  const cap = policy.limits.max_total_spend_cap;
  const sections: string[] = [
    HARNESS_RULES.join("\n"),
    `Client workspace: ${input.workspaceId}. You only ever see this client's data.`,
    [
      `Limits for this run: ${limits.max_steps} steps, ${limits.max_tokens} tokens, ${limits.max_cost_usd} USD.`,
      `Policy: a daily budget may rise by at most ${policy.limits.max_daily_budget_increase_pct}% per change${cap ? `; the workspace spend cap is ${cap.amount} ${cap.currency} per ${cap.period}` : ""}.`,
      policy.forbidden_actions.length > 0 ? `Forbidden actions: ${policy.forbidden_actions.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    SPOTLIGHT_INSTRUCTION,
    ...(input.tools?.includes("growth_scout") ? [GROWTH_RULES.join("\n")] : []),
  ];
  const directive = directiveFor(input.style, input.surface, input.language);
  if (directive) sections.push(directive);
  if (input.surface === "client_copy") {
    sections.push(slopPromptRules(input.extraBanned ? { extraBanned: input.extraBanned } : {}).join("\n"));
  }
  return sections.join("\n\n");
}
