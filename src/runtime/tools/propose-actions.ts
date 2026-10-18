import { z } from "zod";
import { ProposalSchema } from "../../plan/types.js";
import { checkPolicy, type PolicyAction } from "../../shield/evaluate.js";
import type { Policy } from "../../shield/policy.js";
import { defineTool } from "../registry.js";

/**
 * Validates proposed changes and previews them against policy. It returns the normalized proposals
 * and the policy result so the agent can adjust; it creates no plan, writes nothing, and calls no
 * platform. A human turns proposals into a plan, and approves that plan, separately.
 */
export function proposePlanActionsTool(policy: Policy) {
  return defineTool({
    name: "propose_plan_actions",
    description:
      "Propose changes (budget changes, status changes, negative keywords, code patches, experiments) as validated proposals, with a preview of how the policy would judge them. This changes nothing: a plan is compiled and approved by a human separately.",
    class: "propose",
    input: z.object({ client: z.string().min(1).max(80).optional(), proposals: z.array(ProposalSchema).min(1).max(50) }).strict(),
    resources: ({ proposals }) => [...new Set(proposals.flatMap((p) => ("target" in p ? [`${p.target.platform}:${p.target.kind}/${p.target.id}`] : [])))],
    execute: async ({ client, proposals }) => {
      const actions: PolicyAction[] = proposals.map((p, index) => {
        const id = `p${index + 1}`;
        const target = "target" in p ? { platform: p.target.platform, kind: p.target.kind, id: p.target.id } : { platform: "workspace", kind: p.type, id };
        return p.type === "budget_change"
          ? { id, type: p.type, target, from: p.from, to: p.to, currency: p.currency, irreversible: false }
          : { id, type: p.type, target, irreversible: false };
      });
      const result = checkPolicy(policy, { ...(client ? { client } : {}), actions });
      return { proposals, policy: result };
    },
    trustOf: () => "trusted",
  });
}
