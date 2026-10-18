// mdj scout, second half: a cross-channel snapshot with truth calibration. Platform-reported numbers
// are set against CRM actuals, and the match rate is always reported: leads that cannot be tied to
// a campaign are listed, never dropped. Definitions are fixed (SPEC section 9) and shown in every report.
import { normKey } from "../ingest/values.js";
import type { Mappings } from "../ingest/mapping.js";
import type { Issue } from "../ingest/normalize.js";
import { IngestRepo } from "../ingest/repo.js";
import type { Store } from "../store/db.js";

export const DEFINITIONS = {
  blended_mer: "Blended MER = net revenue of deals won in the period (CRM, the revenue source of truth) / total ad spend in the period, all channels.",
  platform_roas: "Platform ROAS = platform-attributed revenue / that platform's spend; only platforms that report revenue have one.",
  calibration_ratio: "Calibration ratio = platform-reported conversions / CRM leads matched to that platform. 1.0 means they agree; above 1.0 the platform claims more than the CRM can confirm.",
  match_rate: "Match rate = CRM leads tied to a known campaign / all CRM leads in the period. Unmatched leads are listed with the reason.",
  cohorts: "Per-platform and per-ad-set CRM figures follow the leads created in the period and any deals those leads closed; Blended MER uses deals won in the period.",
} as const;

export interface ScoutOptions {
  store: Store;
  mappings: Mappings;
  /** Only rows in this ISO 4217 currency are summed; others are listed, never converted. */
  baseCurrency: string;
  timezone: string;
  now: Date;
  days?: number;
  freshnessSlaHours: number;
}

export interface SourceStatus {
  source_id: string;
  kind: string;
  platform: string | null;
  rows: number;
  period_end: string | null;
  age_days: number | null;
  stale: boolean;
  issues: { errors: number; warnings: number; suspicious: number };
}

export interface Funnel {
  leads: number;
  qualified: number;
  deals: number;
  revenue: number;
}

export interface PlatformSnapshot extends Funnel {
  platform: string;
  spend: number;
  impressions: number;
  clicks: number;
  platform_conversions: number;
  platform_revenue: number;
  platform_roas: number | null;
  calibration_ratio: number | null;
  cpc: number | null;
  cost_per_lead: number | null;
  cost_per_qualified: number | null;
  cost_per_deal: number | null;
}

export interface AdsetSnapshot extends Funnel {
  platform: string;
  campaign: string;
  adset: string;
  spend: number;
  clicks: number;
  platform_conversions: number;
  active_days: number;
  cost_per_deal: number | null;
}

export type UnmatchedReason = "no_utm" | "unknown_source" | "unknown_campaign";

export interface UnmatchedLead {
  lead_id: string;
  reason: UnmatchedReason;
  created_at: string;
  has_deal: boolean;
}

export interface Snapshot {
  status: "ok" | "no_data";
  currency: string;
  period: { start: string; end: string; days: number } | null;
  definitions: typeof DEFINITIONS;
  sources: SourceStatus[];
  totals: Funnel & { spend: number; platform_conversions: number; blended_mer: number | null; cost_per_lead: number | null; cost_per_deal: number | null };
  platforms: PlatformSnapshot[];
  adsets: AdsetSnapshot[];
  match: { matched: number; unmatched: number; rate: number | null; matched_by_prefix: number; unmatched_leads: UnmatchedLead[]; unmatched_listed: number };
  conversations: { median_first_response_seconds: number | null; ghost_rate: number | null; leads_with_response_time: number };
  excluded: { ad_rows_other_currency: number; deals_other_currency: number };
  /** Cells that read like instructions to an AI, from the issue lists of the sources. */
  suspicious_cells: { source_id: string; column: string; row: number | undefined; excerpt: string }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const ratio = (a: number, b: number): number | null => (b > 0 ? r2(a / b) : null);

const localDay = (iso: string, timezone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

const addDays = (day: string, delta: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (later: string, earlier: string): number => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

type Row = Record<string, unknown>;
const all = (store: Store, sql: string, ...params: (string | number)[]): Row[] => store.database().prepare(sql).all(...params) as Row[];

interface FactRow {
  date: string;
  platform: string;
  campaign: string;
  adset: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conv_value: number;
}

const emptyFunnel = (): Funnel => ({ leads: 0, qualified: 0, deals: 0, revenue: 0 });

export function scout(options: ScoutOptions): Snapshot {
  const { store, mappings, baseCurrency, timezone, now } = options;
  const days = options.days ?? 7;
  const sources = new IngestRepo(store).sources();
  const nowDay = localDay(now.toISOString(), timezone);
  const sla = Math.max(1, Math.ceil(options.freshnessSlaHours / 24));

  const sourceStatus: SourceStatus[] = sources.map((s) => {
    const issues = s.issues as Issue[];
    const age = s.period_end ? dayDiff(nowDay, s.period_end) : null;
    return {
      source_id: s.source_id,
      kind: s.kind,
      platform: s.platform,
      rows: s.rows,
      period_end: s.period_end,
      age_days: age,
      stale: age !== null && age > sla,
      issues: { errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warn").length, suspicious: issues.filter((i) => i.kind === "suspicious_text").length },
    };
  });
  const suspicious = sources.flatMap((s) => (s.issues as Issue[]).filter((i) => i.kind === "suspicious_text").map((i) => ({ source_id: s.source_id, column: i.column ?? "", row: i.row, excerpt: i.excerpt ?? "" })));

  const excludedAds = Number((all(store, "SELECT COUNT(*) AS n FROM fact_daily WHERE currency <> ?", baseCurrency)[0] as Row).n);
  const excludedDeals = Number((all(store, "SELECT COUNT(*) AS n FROM deals WHERE currency <> ?", baseCurrency)[0] as Row).n);
  const facts = all(store, "SELECT date, platform, campaign, adset, spend, impressions, clicks, conversions, conv_value FROM fact_daily WHERE currency = ? ORDER BY date", baseCurrency) as unknown as FactRow[];

  const blank: Snapshot = {
    status: "no_data",
    currency: baseCurrency,
    period: null,
    definitions: DEFINITIONS,
    sources: sourceStatus,
    totals: { ...emptyFunnel(), spend: 0, platform_conversions: 0, blended_mer: null, cost_per_lead: null, cost_per_deal: null },
    platforms: [],
    adsets: [],
    match: { matched: 0, unmatched: 0, rate: null, matched_by_prefix: 0, unmatched_leads: [], unmatched_listed: 0 },
    conversations: { median_first_response_seconds: null, ghost_rate: null, leads_with_response_time: 0 },
    excluded: { ad_rows_other_currency: excludedAds, deals_other_currency: excludedDeals },
    suspicious_cells: suspicious,
  };
  if (facts.length === 0) return blank;

  const end = facts[facts.length - 1]!.date;
  const start = addDays(end, -(days - 1));
  const window = facts.filter((f) => f.date >= start && f.date <= end);

  // ---- ad facts by platform and ad set
  const platforms = new Map<string, PlatformSnapshot>();
  const adsets = new Map<string, AdsetSnapshot & { _days: Set<string> }>();
  const campaignsByPlatform = new Map<string, Map<string, string>>();
  const adsetKey = (platform: string, campaign: string, adset: string) => `${platform}\u0001${normKey(campaign)}\u0001${normKey(adset)}`;
  const platformOf = (name: string): PlatformSnapshot => {
    let p = platforms.get(name);
    if (!p) {
      p = { platform: name, spend: 0, impressions: 0, clicks: 0, platform_conversions: 0, platform_revenue: 0, platform_roas: null, calibration_ratio: null, cpc: null, cost_per_lead: null, cost_per_qualified: null, cost_per_deal: null, ...emptyFunnel() };
      platforms.set(name, p);
    }
    return p;
  };
  const adsetOf = (platform: string, campaign: string, adset: string) => {
    const key = adsetKey(platform, campaign, adset);
    let a = adsets.get(key);
    if (!a) {
      a = { platform, campaign, adset, spend: 0, clicks: 0, platform_conversions: 0, active_days: 0, cost_per_deal: null, ...emptyFunnel(), _days: new Set<string>() };
      adsets.set(key, a);
    }
    return a;
  };
  for (const f of window) {
    const p = platformOf(f.platform);
    p.spend += f.spend;
    p.impressions += f.impressions;
    p.clicks += f.clicks;
    p.platform_conversions += f.conversions;
    p.platform_revenue += f.conv_value;
    const a = adsetOf(f.platform, f.campaign, f.adset);
    a.spend += f.spend;
    a.clicks += f.clicks;
    a.platform_conversions += f.conversions;
    if (f.spend > 0) a._days.add(f.date);
    const byKey = campaignsByPlatform.get(f.platform) ?? new Map<string, string>();
    byKey.set(normKey(f.campaign), f.campaign);
    campaignsByPlatform.set(f.platform, byKey);
  }

  // ---- CRM: leads created in the window, with qualification and deals
  const qualifiedStages = new Set(mappings.funnel.qualified.map((s) => s.toLowerCase()));
  const qualifiedLeads = new Set<string>();
  for (const row of all(store, "SELECT source_id, lead_id, stage FROM lead_stage_events")) {
    if (qualifiedStages.has(String(row.stage).toLowerCase())) qualifiedLeads.add(`${row.source_id}\u0001${row.lead_id}`);
  }
  const dealsByLead = new Map<string, { value: number; won_at: string }[]>();
  let revenueWonInWindow = 0;
  let dealsWonInWindow = 0;
  for (const d of all(store, "SELECT source_id, lead_id, value, won_at FROM deals WHERE currency = ?", baseCurrency)) {
    const key = `${d.source_id}\u0001${d.lead_id}`;
    const list = dealsByLead.get(key) ?? [];
    list.push({ value: Number(d.value), won_at: String(d.won_at) });
    dealsByLead.set(key, list);
    const wonDay = localDay(String(d.won_at), timezone);
    if (wonDay >= start && wonDay <= end) {
      revenueWonInWindow += Number(d.value);
      dealsWonInWindow += 1;
    }
  }

  const aliasToPlatform = new Map<string, string>();
  for (const [platform, aliases] of Object.entries(mappings.attribution.source_aliases)) for (const a of aliases) aliasToPlatform.set(normKey(a), platform);

  let matched = 0;
  let byPrefix = 0;
  const unmatched: UnmatchedLead[] = [];
  const responseTimes: number[] = [];
  let ghosted = 0;
  let ghostKnown = 0;
  let leadsInWindow = 0;
  let qualifiedInWindow = 0;
  let dealsOfWindowLeads = 0;
  let revenueOfWindowLeads = 0;

  for (const l of all(store, "SELECT source_id, lead_id, created_at, utm_source, campaign, adset, first_response_seconds, ghosted_after_price FROM leads ORDER BY created_at, lead_id")) {
    const created = String(l.created_at);
    const day = localDay(created, timezone);
    if (day < start || day > end) continue;
    leadsInWindow += 1;
    const key = `${l.source_id}\u0001${l.lead_id}`;
    const isQualified = qualifiedLeads.has(key);
    const deals = dealsByLead.get(key) ?? [];
    if (isQualified) qualifiedInWindow += 1;
    dealsOfWindowLeads += deals.length;
    revenueOfWindowLeads += deals.reduce((a, d) => a + d.value, 0);
    if (l.first_response_seconds !== null) responseTimes.push(Number(l.first_response_seconds));
    if (l.ghosted_after_price !== null) {
      ghostKnown += 1;
      if (Number(l.ghosted_after_price) === 1) ghosted += 1;
    }

    const source = String(l.utm_source);
    const campaign = String(l.campaign);
    const reasonless = source === "" && campaign.trim() === "";
    const platform = aliasToPlatform.get(normKey(source));
    let reason: UnmatchedReason | undefined;
    let campaignName: string | undefined;
    if (reasonless) reason = "no_utm";
    else if (!platform) reason = "unknown_source";
    else {
      const known = campaignsByPlatform.get(platform) ?? new Map<string, string>();
      const want = normKey(campaign);
      campaignName = known.get(want);
      if (!campaignName && want !== "") {
        // UTM values are often a shortened campaign name: accept a unique match at a word boundary
        const candidates = [...known.entries()].filter(([k]) => k.startsWith(`${want}_`));
        if (candidates.length === 1) {
          campaignName = (candidates[0] as [string, string])[1];
          byPrefix += 1;
        }
      }
      if (!campaignName) reason = "unknown_campaign";
    }

    if (reason || !platform || !campaignName) {
      unmatched.push({ lead_id: String(l.lead_id), reason: reason ?? "unknown_campaign", created_at: created, has_deal: deals.length > 0 });
      continue;
    }
    matched += 1;
    const p = platformOf(platform);
    p.leads += 1;
    if (isQualified) p.qualified += 1;
    p.deals += deals.length;
    p.revenue += deals.reduce((a, d) => a + d.value, 0);
    const wantAdset = normKey(String(l.adset));
    const known = [...adsets.values()].find((a) => a.platform === platform && normKey(a.campaign) === normKey(campaignName as string) && normKey(a.adset) === wantAdset);
    const a = known ?? adsetOf(platform, campaignName, "(ad set not matched)");
    a.leads += 1;
    if (isQualified) a.qualified += 1;
    a.deals += deals.length;
    a.revenue += deals.reduce((x, d) => x + d.value, 0);
  }

  // ---- finish
  const platformList = [...platforms.values()]
    .map((p) => ({
      ...p,
      spend: r2(p.spend),
      platform_revenue: r2(p.platform_revenue),
      revenue: r2(p.revenue),
      platform_roas: p.platform_revenue > 0 ? ratio(p.platform_revenue, p.spend) : null,
      calibration_ratio: ratio(p.platform_conversions, p.leads),
      cpc: ratio(p.spend, p.clicks),
      cost_per_lead: ratio(p.spend, p.leads),
      cost_per_qualified: ratio(p.spend, p.qualified),
      cost_per_deal: ratio(p.spend, p.deals),
    }))
    .sort((a, b) => b.spend - a.spend || a.platform.localeCompare(b.platform));

  const adsetList: AdsetSnapshot[] = [...adsets.values()]
    .map(({ _days, ...a }) => ({ ...a, spend: r2(a.spend), revenue: r2(a.revenue), active_days: _days.size, cost_per_deal: ratio(a.spend, a.deals) }))
    .sort((a, b) => b.spend - a.spend || a.adset.localeCompare(b.adset));

  const spend = r2(platformList.reduce((s, p) => s + p.spend, 0));
  const totalLeads = leadsInWindow;
  return {
    ...blank,
    status: "ok",
    period: { start, end, days },
    totals: {
      spend,
      platform_conversions: platformList.reduce((s, p) => s + p.platform_conversions, 0),
      leads: totalLeads,
      qualified: qualifiedInWindow,
      deals: dealsOfWindowLeads,
      revenue: r2(revenueOfWindowLeads),
      blended_mer: ratio(revenueWonInWindow, spend),
      cost_per_lead: ratio(spend, totalLeads),
      cost_per_deal: ratio(spend, dealsWonInWindow),
    },
    platforms: platformList,
    adsets: adsetList,
    match: {
      matched,
      unmatched: unmatched.length,
      rate: totalLeads > 0 ? r4(matched / totalLeads) : null,
      matched_by_prefix: byPrefix,
      unmatched_leads: unmatched.slice(0, 20),
      unmatched_listed: Math.min(unmatched.length, 20),
    },
    conversations: {
      median_first_response_seconds: median(responseTimes),
      ghost_rate: ghostKnown > 0 ? r4(ghosted / ghostKnown) : null,
      leads_with_response_time: responseTimes.length,
    },
  };
}
