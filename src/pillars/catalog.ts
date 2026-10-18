// The eleven Growth Architect pillars live in the engine, not in every workspace.yaml.
// A workspace only says which pillars are active (and optional per-pillar slot overrides).
import type { SlotName } from "../constants.js";

export const BUSINESS_TYPES = ["ecom", "b2b_saas", "high_ticket_hybrid", "agency", "local_leadgen"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export type Availability = "M1" | "M2" | "M3" | "M4" | "post-M3";

export interface Pillar {
  id: number;
  key: string;
  title: string;
  /** First milestone in which the pillar has working skills. */
  availableFrom: Availability;
  defaultSlot: SlotName;
}

export const PILLARS: readonly Pillar[] = [
  { id: 1, key: "ads_and_acquisition", title: "Ads and Paid Acquisition", availableFrom: "M1", defaultSlot: "reasoning" },
  { id: 2, key: "creative_strategy_and_fatigue", title: "Creative Strategy and Fatigue Engineering", availableFrom: "M3", defaultSlot: "creative" },
  { id: 3, key: "seo_content_and_geo", title: "SEO, Content and GEO", availableFrom: "M4", defaultSlot: "reasoning" },
  { id: 4, key: "cro_and_landing_systems", title: "CRO and Landing Systems", availableFrom: "M2", defaultSlot: "reasoning" },
  { id: 5, key: "conversational_and_sales_loops", title: "Conversational and Sales-Assisted Revenue Loops", availableFrom: "M1", defaultSlot: "reasoning" },
  { id: 6, key: "offer_pricing_and_monetization", title: "Offer, Pricing and Monetization", availableFrom: "M3", defaultSlot: "reasoning" },
  { id: 7, key: "retention_lifecycle_and_ltv", title: "Retention, Lifecycle and LTV", availableFrom: "M3", defaultSlot: "creative" },
  { id: 8, key: "measurement_and_truth_calibration", title: "Measurement, Attribution and Truth Calibration", availableFrom: "M1", defaultSlot: "reasoning" },
  { id: 9, key: "strategy_and_unit_economics", title: "Strategy and Unit-Economics Simulation", availableFrom: "M1", defaultSlot: "reasoning" },
  { id: 10, key: "intelligence_shadow_scout_and_tactics", title: "Intelligence, Shadow Scouting and the Tested-Tactics Log", availableFrom: "M2", defaultSlot: "reasoning" },
  { id: 11, key: "earned_community_partnerships_and_events", title: "Earned Media, Community, Partnerships and Events", availableFrom: "post-M3", defaultSlot: "creative" },
];

export const pillarById = (id: number): Pillar | undefined => PILLARS.find((p) => p.id === id);

export const isStubbed = (id: number): boolean => pillarById(id)?.availableFrom === "post-M3";

/** Default active pillars per business type. Pillar 11 is never on by default. */
export const DEFAULT_PILLARS: Record<BusinessType, number[]> = {
  ecom: [1, 2, 3, 4, 6, 7, 8, 9, 10],
  b2b_saas: [1, 3, 4, 5, 7, 8, 9, 10],
  high_ticket_hybrid: [1, 2, 3, 4, 5, 6, 8, 9, 10],
  agency: [1, 2, 3, 4, 8, 9, 10],
  local_leadgen: [1, 3, 4, 5, 8, 9, 10],
};
