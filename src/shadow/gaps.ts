// Gap comparison between our offer and what competitors show. Deterministic rules, no model. Prices
// are compared only in the same ISO currency and only as a relative difference; Medjay never converts.
import type { Channel, Offer, TrustKey } from "./extract.js";
import type { OurOffer } from "./ours.js";

export type { OurOffer };

export interface Gap {
  dimension: "bnpl" | "price" | "cta" | "trust";
  kind: "gap" | "advantage" | "parity" | "not_comparable";
  severity: "high" | "medium" | "low";
  detail: string;
  evidence: { competitor: string; note: string }[];
}

export interface NamedOffer {
  name: string;
  offer: Offer;
}

const PRICE_PARITY_PCT = 10;
const PRICE_HIGH_PCT = 25;
const pct1 = (n: number) => Math.round(n * 10) / 10;
const KIND_ORDER = { gap: 0, not_comparable: 1, parity: 2, advantage: 3 } as const;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

function bnplGaps(ours: OurOffer, comps: NamedOffer[]): Gap[] {
  if (!ours.bnpl) return [];
  const have = comps.filter((c) => c.offer.bnpl.present);
  const evidence = have.map((c) => ({ competitor: c.name, note: c.offer.bnpl.providers.join(", ") || "installments mentioned" }));
  if (!ours.bnpl.present && have.length > 0) {
    return [{ dimension: "bnpl", kind: "gap", severity: have.length * 2 > comps.length ? "high" : "medium", detail: `${have.length} of ${comps.length} competitors offer buy-now-pay-later. You do not.`, evidence }];
  }
  if (ours.bnpl.present && have.length === 0) return [{ dimension: "bnpl", kind: "advantage", severity: "low", detail: "You offer buy-now-pay-later and no competitor shows it.", evidence: [] }];
  return [];
}

function priceGaps(ours: OurOffer, comps: NamedOffer[]): Gap[] {
  const mine = ours.price_anchor;
  if (!mine) return [];
  const out: Gap[] = [];
  for (const c of comps) {
    const theirs = c.offer.price_anchor;
    if (!theirs) continue;
    const note = `${theirs.amount} ${theirs.currency}`;
    if (theirs.currency !== mine.currency) {
      out.push({ dimension: "price", kind: "not_comparable", severity: "low", detail: `${c.name}: currency differs or is not written as a code (${theirs.currency} against ${mine.currency}); prices are never converted.`, evidence: [{ competitor: c.name, note }] });
      continue;
    }
    const diff = pct1(((mine.amount - theirs.amount) / theirs.amount) * 100);
    if (diff > PRICE_PARITY_PCT) out.push({ dimension: "price", kind: "gap", severity: diff >= PRICE_HIGH_PCT ? "high" : "medium", detail: `Your anchor is ${diff}% above ${c.name}'s (${mine.amount} against ${theirs.amount} ${mine.currency}).`, evidence: [{ competitor: c.name, note }] });
    else if (diff < -PRICE_PARITY_PCT) out.push({ dimension: "price", kind: "advantage", severity: "low", detail: `Your anchor is ${Math.abs(diff)}% below ${c.name}'s (${mine.amount} against ${theirs.amount} ${mine.currency}).`, evidence: [{ competitor: c.name, note }] });
    else out.push({ dimension: "price", kind: "parity", severity: "low", detail: `Your anchor is within ${PRICE_PARITY_PCT}% of ${c.name}'s.`, evidence: [{ competitor: c.name, note }] });
  }
  return out;
}

function ctaGaps(ours: OurOffer, comps: NamedOffer[]): Gap[] {
  if (!ours.cta_channel) return [];
  const tally = new Map<Channel, string[]>();
  for (const c of comps) if (c.offer.cta.primary !== "none") tally.set(c.offer.cta.primary, [...(tally.get(c.offer.cta.primary) ?? []), c.name]);
  let top: Channel | undefined;
  for (const [channel, names] of tally) if (!top || names.length > (tally.get(top)?.length ?? 0)) top = channel;
  if (!top) return [];
  const names = tally.get(top) as string[];
  if (names.length * 2 <= comps.length) return [];
  const evidence = names.map((competitor) => ({ competitor, note: top as string }));
  if (top !== ours.cta_channel) return [{ dimension: "cta", kind: "gap", severity: "medium", detail: `${names.length} of ${comps.length} competitors lead with ${top}; you lead with ${ours.cta_channel}.`, evidence }];
  return [{ dimension: "cta", kind: "parity", severity: "low", detail: `Most competitors (${names.length} of ${comps.length}) also lead with ${top}.`, evidence }];
}

function trustGaps(ours: OurOffer, comps: NamedOffer[]): Gap[] {
  const mine = new Set<TrustKey>(ours.trust_signals);
  const seen = new Map<TrustKey, string[]>();
  for (const c of comps) for (const key of Object.keys(c.offer.trust) as TrustKey[]) if (!mine.has(key)) seen.set(key, [...(seen.get(key) ?? []), c.name]);
  if (seen.size === 0) return [];
  const keys = [...seen.keys()].sort();
  const strongest = Math.max(...[...seen.values()].map((v) => v.length));
  return [
    {
      dimension: "trust",
      kind: "gap",
      severity: strongest * 2 > comps.length ? "medium" : "low",
      detail: `Competitors show trust signals you do not: ${keys.map((k) => `${k} (${seen.get(k)!.length} of ${comps.length})`).join(", ")}.`,
      evidence: [...new Set([...seen.values()].flat())].sort().map((competitor) => ({ competitor, note: keys.filter((k) => seen.get(k)!.includes(competitor)).join(", ") })),
    },
  ];
}

export function compareOffers(ours: OurOffer | undefined, comps: NamedOffer[]): Gap[] {
  if (!ours || comps.length === 0) return [];
  const gaps = [...bnplGaps(ours, comps), ...priceGaps(ours, comps), ...ctaGaps(ours, comps), ...trustGaps(ours, comps)];
  return gaps.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.dimension.localeCompare(b.dimension) ||
      (a.evidence[0]?.competitor ?? "").localeCompare(b.evidence[0]?.competitor ?? ""),
  );
}
