// Our own offer, declared in the frontmatter of context/offer-matrix.md, so a gap comparison has
// something to compare against:
//   offer:
//     headline: ...
//     price_anchor: { amount: 3999, currency: SAR }
//     bnpl: { present: true, providers: [tabby] }
//     cta_channel: whatsapp | web_checkout | phone | form
//     trust_signals: [rating, licence, guarantee, customer_count, secure_payment, press]
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const OfferSchema = z
  .object({
    headline: z.string().min(1).max(200).optional(),
    price_anchor: z.object({ amount: z.number().positive(), currency: z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code such as SAR") }).strict().optional(),
    bnpl: z.object({ present: z.boolean(), providers: z.array(z.string().min(1)).default([]) }).strict().optional(),
    cta_channel: z.enum(["whatsapp", "web_checkout", "phone", "form"]).optional(),
    trust_signals: z.array(z.enum(["rating", "licence", "guarantee", "customer_count", "secure_payment", "press"])).default([]),
  })
  .strict();

export type OurOffer = z.infer<typeof OfferSchema>;

export function parseOurOffer(text: string): OurOffer | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  if (!front) return undefined;
  const data = parseYaml(front[1] as string) as { offer?: unknown } | null;
  if (data?.offer === undefined || data.offer === null) return undefined;
  const parsed = OfferSchema.safeParse(data.offer);
  if (!parsed.success) {
    throw new Error(`context/offer-matrix.md offer block is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "offer"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
