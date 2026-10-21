// What a period-summary export (campaigns, search terms, devices, days; no date column) says about a
// period, in numbers a person can act on. Pure reads over the facts in the store; nothing is changed.
import type { Store } from "../store/db.js";

export interface SummaryCampaign {
  name: string;
  spend: number;
  conversions: number;
  cost_per_conversion: number | null;
  share_of_spend: number;
}

export interface PeriodSummary {
  platform: string;
  currency: string;
  period: { start: string; end: string; days: number };
  totals: { spend: number; conversions: number; clicks: number; cost_per_conversion: number | null };
  campaigns: SummaryCampaign[];
  /** Search terms that spent money and never converted, biggest spend first. */
  zero_conversion_terms: { term: string; spend: number; clicks: number }[];
  /** Keywords by spend (the keyword report has no conversions, so it cannot say which never converted). */
  top_keywords: { keyword: string; spend: number; clicks: number }[];
  devices: { device: string; spend: number; clicks: number; conversions: number; cost_per_conversion: number | null }[];
  daily: { date: string; spend: number; conversions: number }[];
  /** Reports from the same period that disagree with each other. */
  notes: string[];
}

interface Row {
  key: string;
  spend: number;
  clicks: number;
  conversions: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const cpa = (spend: number, conversions: number) => (conversions > 0 ? r2(spend / conversions) : null);
const MS_PER_DAY = 86_400_000;
const inclusiveDays = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / MS_PER_DAY) + 1;
const LIST_LIMIT = 10;
/** Two reports of the same period should agree within this share. */
const AGREEMENT_TOLERANCE = 0.02;

export function periodSummary(store: Store): PeriodSummary | null {
  const db = store.database();
  const periods = db
    .prepare("SELECT period_start AS start, period_end AS end, dimension, platform, currency FROM fact_period GROUP BY period_start, period_end, dimension, platform, currency")
    .all() as { start: string; end: string; dimension: string; platform: string; currency: string }[];
  if (periods.length === 0) return null;
  // the most recent period that has campaigns (else any), the longest one when several end on the same day
  const pool = periods.some((p) => p.dimension === "campaign") ? periods.filter((p) => p.dimension === "campaign") : periods;
  const chosen = [...pool].sort((a, b) => b.end.localeCompare(a.end) || inclusiveDays(b.start, b.end) - inclusiveDays(a.start, a.end))[0]!;
  const rows = (dimension: string): Row[] =>
    db
      .prepare("SELECT key, SUM(spend) AS spend, SUM(clicks) AS clicks, SUM(conversions) AS conversions FROM fact_period WHERE dimension = ? AND period_start = ? AND period_end = ? AND platform = ? GROUP BY key")
      .all(dimension, chosen.start, chosen.end, chosen.platform) as unknown as Row[];
  const sum = (list: Row[], field: "spend" | "clicks" | "conversions") => list.reduce((total, row) => total + row[field], 0);

  const campaignRows = rows("campaign").sort((a, b) => b.spend - a.spend);
  const totalSpend = sum(campaignRows, "spend");
  const totalConversions = sum(campaignRows, "conversions");
  const campaigns: SummaryCampaign[] = campaignRows.map((c) => ({
    name: c.key,
    spend: c.spend,
    conversions: c.conversions,
    cost_per_conversion: cpa(c.spend, c.conversions),
    share_of_spend: totalSpend > 0 ? r3(c.spend / totalSpend) : 0,
  }));

  const deviceRows = rows("device").sort((a, b) => b.spend - a.spend);
  const dailyRows = rows("day").sort((a, b) => a.key.localeCompare(b.key));
  const notes: string[] = [];
  const compare = (label: string, list: Row[]) => {
    if (list.length === 0 || totalSpend <= 0) return;
    const other = sum(list, "spend");
    const gap = Math.abs(other - totalSpend) / totalSpend;
    if (gap > AGREEMENT_TOLERANCE) notes.push(`The ${label} report adds up to ${r2(other)} but the campaigns report adds up to ${r2(totalSpend)} (${Math.round(gap * 100)}% apart); check both were exported for the same dates and filters.`);
  };
  compare("devices", deviceRows);
  compare("daily", dailyRows);

  return {
    platform: chosen.platform,
    currency: chosen.currency,
    period: { start: chosen.start, end: chosen.end, days: inclusiveDays(chosen.start, chosen.end) },
    totals: { spend: totalSpend, conversions: totalConversions, clicks: sum(campaignRows, "clicks"), cost_per_conversion: cpa(totalSpend, totalConversions) },
    campaigns,
    zero_conversion_terms: rows("search_term")
      .filter((t) => t.conversions === 0 && t.spend > 0)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, LIST_LIMIT)
      .map((t) => ({ term: t.key, spend: t.spend, clicks: t.clicks })),
    top_keywords: rows("keyword")
      .sort((a, b) => b.spend - a.spend)
      .slice(0, LIST_LIMIT)
      .map((k) => ({ keyword: k.key, spend: k.spend, clicks: k.clicks })),
    devices: deviceRows.map((d) => ({ device: d.key, spend: d.spend, clicks: d.clicks, conversions: d.conversions, cost_per_conversion: cpa(d.spend, d.conversions) })),
    daily: dailyRows.map((d) => ({ date: d.key, spend: d.spend, conversions: d.conversions })),
    notes,
  };
}
