// The `style` block of workspace.yaml.
//   caveman: how terse the harness's OWN prose is (internal narration, WhatsApp replies).
//   slop:    the anti-slop linter for customer-facing copy.
// Client copy, approval prompts and security/spend warnings are never caveman: those surfaces are
// not configurable (the schema rejects them), so no config edit can make a warning cryptic.
import { z } from "zod";

export const CAVEMAN_LEVELS = ["off", "lite", "full", "ultra"] as const;
export type CavemanLevel = (typeof CAVEMAN_LEVELS)[number];

const Level = z.enum(CAVEMAN_LEVELS);

export const StyleConfigSchema = z
  .object({
    caveman: z
      .object({ internal: Level.default("full"), whatsapp: Level.default("lite") })
      .strict()
      .prefault({}),
    slop: z
      .object({
        /** Default: protocol + extended, plus ar when the workspace writes Arabic. */
        packs: z.array(z.enum(["protocol", "extended", "ar"])).min(1).optional(),
        fail_on: z.enum(["error", "warn"]).default("error"),
        allow: z.array(z.string().min(1)).default([]),
        extra_banned: z.array(z.object({ phrase: z.string().min(1), suggestion: z.string().min(1).optional() }).strict()).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type StyleConfig = z.infer<typeof StyleConfigSchema>;
