import { z } from "zod";
import { resolvePublishDrafts, type DraftPort } from "../../plan/draft-binding.js";
import { ProposalSchema, type CompiledAction } from "../../plan/types.js";
import { checkPolicy, type PolicyAction } from "../../shield/evaluate.js";
import type { Policy } from "../../shield/policy.js";
import { defineTool } from "../registry.js";

/**
 * Validates proposed changes and previews them against policy. It returns the normalized proposals
 * and the policy result so the agent can adjust; it creates no plan, writes nothing, and calls no
 * platform. A human turns proposals into a plan, and approves that plan, separately.
 *
 * A publish_post proposal is bound to one version of a draft and its SHA-256. The same check that will
 * run when the plan is proposed runs here, so the agent hears about a stale, failed or missing draft now.
 */
export function proposePlanActionsTool(policy: Policy, drafts?: DraftPort) {
  return defineTool({
    name: "propose_plan_actions",
    description:
      "Propose changes (budget changes, status changes, negative keywords, code patches, experiments, WordPress posts) as validated proposals, with a preview of how the policy would judge them. A publish_post proposal names one saved draft version and its sha256 (from draft_save); its draft_checks result says whether that draft can be published. This changes nothing: a plan is compiled and approved by a human separately.",
    class: "propose",
    input: z.object({ client: z.string().min(1).max(80).optional(), proposals: z.array(ProposalSchema).min(1).max(50) }).strict(),
    resources: ({ proposals }) => [...new Set(proposals.flatMap((p) => ("target" in p ? [`${p.target.platform}:${p.target.kind}/${p.target.id}`] : p.type === "publish_post" ? [`wordpress:post/${p.site}`] : [])))],
    execute: async ({ client, proposals }) => {
      const actions: PolicyAction[] = proposals.map((p, index) => {
        const id = `p${index + 1}`;
        const target = "target" in p ? { platform: p.target.platform, kind: p.target.kind, id: p.target.id } : p.type === "publish_post" ? { platform: "wordpress", kind: "post", id: p.site } : { platform: "workspace", kind: p.type, id };
        const irreversible = p.type === "publish_post" && p.post_status === "publish";
        return p.type === "budget_change" ? { id, type: p.type, target, from: p.from, to: p.to, currency: p.currency, irreversible: false } : { id, type: p.type, target, irreversible };
      });
      const result = checkPolicy(policy, { ...(client ? { client } : {}), actions }, { stage: "propose" });

      const publishing = proposals.flatMap((p, index) => (p.type === "publish_post" ? [{ index, action: { ...p, id: `p${index + 1}`, irreversible: p.post_status === "publish", inverse: { type: "unpublish_post" as const } } as CompiledAction }] : []));
      if (publishing.length === 0) return { proposals, policy: result };
      const { problems } = await resolvePublishDrafts(publishing.map((x) => x.action), drafts);
      const draft_checks = publishing.map(({ index, action }) => {
        const problem = problems.get(action.id);
        return problem ? { index, ok: false, problem } : { index, ok: true };
      });
      return { proposals, policy: result, draft_checks };
    },
    trustOf: () => "trusted",
  });
}
