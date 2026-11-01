// workspace_profile: how the AI model records what it learns about the business in the first conversation
// (name, business type, currency, language, timezone, what is sold). Like context_update it is class
// `context`: the registry always asks the owner first, and nothing but these six fields can be given.
import { z } from "zod";
import { BUSINESS_TYPES, type ProfileStore } from "../../context/profile.js";
import { defineTool, type ToolDef } from "../registry.js";

const Input = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    business_type: z.enum(BUSINESS_TYPES).optional(),
    base_currency: z.string().regex(/^[A-Z]{3}$/, "a three-letter code in capitals, like SAR").optional(),
    timezone: z.string().min(1).max(60).optional(),
    language: z.string().regex(/^[a-z]{2,3}$/, "a lowercase language code like en or ar").optional(),
    vertical: z.string().trim().min(1).max(80).optional(),
    reason: z.string().min(1).max(300),
  })
  .strict()
  .refine((v) => [v.name, v.business_type, v.base_currency, v.timezone, v.language, v.vertical].some((x) => x !== undefined), "give at least one profile field");

export function profileTools(store: ProfileStore): ToolDef[] {
  const profile = defineTool({
    name: "workspace_profile",
    description: `Record what you have learned about the owner's business in the workspace profile. Fields: name (the business or brand), business_type (${BUSINESS_TYPES.join(" | ")}: ecom = online store, b2b_saas = B2B software, high_ticket_hybrid = high-ticket or consultative sales such as travel packages, property or clinics, agency = marketing agency, local_leadgen = local business getting leads from ads), base_currency (the currency they spend in, a code like SAR), timezone (an IANA name like Asia/Riyadh), language (the language they write to you in, en or ar), vertical (what they sell, a few words). Send only what you actually know or can reasonably infer, and tell the owner in plain words what you are about to save so they can correct you. The owner must allow the change; if a value is refused, fix it and send it again.`,
    class: "context",
    input: Input,
    resources: () => ["context:workspace-profile"],
    preview: async ({ reason, ...change }) => {
      const p = await store.propose(change);
      return { summary: `workspace profile: ${p.changed ? p.changes.map((c) => c.field).join(", ") : "no change"} (${reason})`, diff: p.diff };
    },
    execute: async ({ reason, ...change }, ctx) => {
      const r = await store.apply(change, { author: `agent:${ctx.runId}`, reason });
      return {
        saved: r.changed,
        fields: r.changes.map((c) => c.field),
        version: r.version,
        ...(r.unit_economics === undefined ? {} : { unit_economics: r.unit_economics }),
        note: r.changed ? "Saved. The previous workspace.yaml is kept as a numbered version." : "Nothing changed: the profile already says this.",
      };
    },
    trustOf: () => "trusted",
  });
  return [profile] as unknown as ToolDef[];
}
