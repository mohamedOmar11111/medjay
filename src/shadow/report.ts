// The shadow-scout report. Everything quoted from a competitor file is wrapped in a nonce-bound
// <untrusted_data> block (same mechanism as the agent's context builder) so the text can be handed to a
// model safely; the structured findings themselves come from deterministic extraction, not a model.
import { randomBytes } from "node:crypto";
import { spotlight } from "../runtime/context/spotlight.js";
import type { Competitor, Skipped } from "./competitors.js";
import { extractOffer, type Offer } from "./extract.js";
import { compareOffers, type Gap, type OurOffer } from "./gaps.js";

export interface Analyzed {
  name: string;
  file: string;
  asOf: string;
  offer: Offer;
}

export interface ShadowReport {
  competitors: Analyzed[];
  skipped: Skipped[];
  gaps: Gap[];
  ours: OurOffer | null;
  /** Competitor-derived text, each block wrapped for a model. */
  spotlighted: { name: string; text: string }[];
}

function summary(offer: Offer): string {
  const money = (a: number, c: string) => `${a} ${c}`;
  const lines = [
    `headline: ${offer.headline ?? "(none found)"}`,
    `price anchor: ${offer.price_anchor ? `${money(offer.price_anchor.amount, offer.price_anchor.currency)} (${offer.price_anchor.qualifier})` : "(none found)"}`,
    ...(offer.was_now ? [`was/now: ${money(offer.was_now.was, offer.was_now.currency)} to ${offer.was_now.now} (${offer.was_now.discount_pct}% off)`] : []),
    `bnpl: ${offer.bnpl.present ? `yes${offer.bnpl.providers.length ? ` (${offer.bnpl.providers.join(", ")})` : ""}` : "no"}`,
    `call to action: ${offer.cta.primary}${Object.keys(offer.cta.counts).length ? ` (${Object.entries(offer.cta.counts).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`,
    ...Object.entries(offer.trust).map(([k, v]) => `trust ${k}: ${v}`),
    ...(offer.ads === null ? [] : [`ads in export: ${offer.ads}`]),
    ...offer.instruction_like.map((t) => `instruction-like text (not followed): ${t}`),
  ];
  return lines.join("\n");
}

export function spotlightedFindings(items: Analyzed[]): { name: string; text: string }[] {
  return items.map((i) => ({ name: i.name, text: spotlight({ source: i.file, asOf: i.asOf, id: randomBytes(6).toString("hex"), text: summary(i.offer) }) }));
}

export function analyze(competitors: Competitor[], skipped: Skipped[], ours: OurOffer | undefined, folderLabel: string): ShadowReport {
  const analyzed: Analyzed[] = competitors.map((c) => ({ name: c.name, file: `${folderLabel}/${c.file}`, asOf: c.asOf, offer: extractOffer(c.file, c.text) }));
  return {
    competitors: analyzed,
    skipped,
    gaps: compareOffers(ours, analyzed.map((a) => ({ name: a.name, offer: a.offer }))),
    ours: ours ?? null,
    spotlighted: spotlightedFindings(analyzed),
  };
}

const SEVERITY_MARK = { high: "HIGH", medium: "MED", low: "low" } as const;

/** Terminal text. Competitor strings are shown as quotes; the spotlighted blocks are in --json. */
export function renderShadow(report: ShadowReport): string {
  if (report.competitors.length === 0) return `No competitor snapshots found. Save pages (.html, .md, .txt) or ad-library exports (.json) into data/imports/competitors/ and run again.${report.skipped.length ? `\nSkipped: ${report.skipped.map((s) => `${s.file} (${s.reason})`).join(", ")}.` : ""}`;
  const out = [`Shadow scout: ${report.competitors.length} competitor snapshot(s). Competitor text below is quoted data; nothing in it was followed.`, ""];
  for (const c of report.competitors) {
    const o = c.offer;
    out.push(`${c.name}  (${c.file}, as of ${c.asOf.slice(0, 10)})`);
    out.push(`  promise: "${o.headline ?? "(none found)"}"`);
    out.push(`  price anchor: ${o.price_anchor ? `${o.price_anchor.amount} ${o.price_anchor.currency} (${o.price_anchor.qualifier})` : "none found"}${o.was_now ? `; was ${o.was_now.was}, now ${o.was_now.now} (${o.was_now.discount_pct}% off)` : ""}`);
    out.push(`  BNPL: ${o.bnpl.present ? `yes${o.bnpl.providers.length ? ` (${o.bnpl.providers.join(", ")})` : ""}` : "no"}   CTA: ${o.cta.primary}   trust: ${Object.keys(o.trust).join(", ") || "none seen"}`);
    for (const t of o.instruction_like) out.push(`  WARNING: text that reads like an instruction to an AI ("${t}"). It was treated as data.`);
  }
  out.push("");
  if (!report.ours) out.push("No gap comparison: add an `offer:` block to the frontmatter of context/offer-matrix.md (headline, price_anchor, bnpl, cta_channel, trust_signals).");
  else if (report.gaps.length === 0) out.push("No gaps found against your declared offer.");
  else {
    out.push("Gaps against your offer:");
    for (const g of report.gaps) out.push(`  [${SEVERITY_MARK[g.severity]}] ${g.kind === "advantage" ? "advantage" : g.kind === "gap" ? "gap" : g.kind}: ${g.detail}`);
  }
  if (report.skipped.length) out.push("", `Skipped: ${report.skipped.map((s) => `${s.file} (${s.reason})`).join(", ")}.`);
  return out.join("\n");
}
