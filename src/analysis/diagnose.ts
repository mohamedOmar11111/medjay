// mdj diagnose: root-cause anomaly detection over a scout snapshot. Deterministic rules with named
// thresholds, no model in the loop: the same snapshot always gives the same findings, each citing the
// source file and the date of its data. Findings recommend; they never act (a change is a plan, and
// a plan needs approval).
import type { AdsetSnapshot, PlatformSnapshot, Snapshot } from "./scout.js";

export const THRESHOLDS = {
  /** An ad set must carry at least this share of all spend to count as bleeding. */
  bleedMinSpendShare: 0.05,
  bleedMinActiveDays: 5,
  /** Platform conversions / CRM leads. Above warn the platform over-claims; above high it is not credible. */
  calibrationWarn: 1.25,
  calibrationHigh: 2,
  /** A campaign this far over, with enough conversions to be meaningful, is flagged on its own. */
  campaignCalibration: 3,
  campaignMinConversions: 20,
  campaignMinSpendShare: 0.05,
  /** Platform ROAS this many times the blended MER is flagged. */
  roasOverMer: 1.5,
  matchRateMin: 0.9,
  slowFirstResponseSeconds: 600,
  ghostRateMax: 0.4,
  excerptChars: 48,
} as const;

export type Severity = "high" | "medium" | "low";
export type Category = "spend" | "measurement" | "funnel" | "data";

export interface Evidence {
  /** The source file(s) the numbers came from. */
  source: string;
  /** The date of the newest data used (YYYY-MM-DD). */
  as_of: string | null;
  facts: Record<string, string | number | null>;
}

export interface Finding {
  id: string;
  kind: "bleeding_adset" | "over_attribution" | "mer_vs_roas" | "low_match_rate" | "slow_first_response" | "conversation_drop_off" | "instruction_like_text" | "stale_data";
  category: Category;
  severity: Severity;
  title: string;
  summary: string;
  /** Spend that bought nothing the CRM can see, when that is known. */
  wasted_spend: number | null;
  /** Spend that cannot be trusted until the gap closes, when waste is not known. */
  spend_at_risk: number | null;
  evidence: Evidence[];
  recommendation: string;
  rank: number;
}

export interface Diagnosis {
  status: "ok" | "no_data";
  currency: string;
  period: Snapshot["period"];
  findings: Finding[];
  /** Ids of the top three money, measurement or funnel findings. */
  top: string[];
  thresholds: typeof THRESHOLDS;
}

type Draft = Omit<Finding, "rank">;

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const fmt = (n: number, currency: string) => `${currency} ${Math.round(n).toLocaleString("en-US")}`;
/** Names come from the data, so they are bounded before they reach a sentence. */
const name = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

function sourceFor(snapshot: Snapshot, platform: string | null, kind: string) {
  const found = snapshot.sources.find((s) => (platform ? s.platform === platform : s.kind === kind));
  return { source: found?.source_id ?? "unknown", as_of: found?.period_end ?? null };
}

function bleeding(snapshot: Snapshot): Draft[] {
  const total = snapshot.totals.spend;
  return snapshot.adsets
    .filter((a) => a.deals === 0 && a.active_days >= THRESHOLDS.bleedMinActiveDays && total > 0 && a.spend / total >= THRESHOLDS.bleedMinSpendShare && a.adset !== "(ad set not matched)")
    .map((a: AdsetSnapshot): Draft => {
      const claims = a.platform_conversions;
      const src = sourceFor(snapshot, a.platform, "ad_platform");
      const crm = sourceFor(snapshot, null, "crm");
      return {
        id: `bleeding_adset:${a.platform}:${slug(a.adset)}`,
        kind: "bleeding_adset",
        category: "spend",
        severity: "high",
        title: `${name(a.adset)} spent ${fmt(a.spend, snapshot.currency)} with no deal`,
        summary: `${a.platform} ad set "${name(a.adset)}" (campaign "${name(a.campaign)}") spent ${fmt(a.spend, snapshot.currency)} over ${a.active_days} days. The platform reports ${claims} result(s); the CRM has ${a.leads} lead(s), ${a.qualified} qualified and 0 deals.`,
        wasted_spend: a.spend,
        spend_at_risk: null,
        evidence: [
          { ...src, facts: { spend: a.spend, platform_conversions: claims, active_days: a.active_days } },
          { ...crm, facts: { crm_leads: a.leads, crm_qualified: a.qualified, crm_deals: 0 } },
        ],
        recommendation: `Review "${name(a.adset)}" first: pause it or cut its budget, then check whether its ${a.leads} lead(s) were reached in time. A pause is a plan action and needs your approval.`,
      };
    });
}

function overAttribution(snapshot: Snapshot): Draft[] {
  const out: Draft[] = [];
  const total = snapshot.totals.spend;
  for (const p of snapshot.platforms as PlatformSnapshot[]) {
    if (p.calibration_ratio === null || p.calibration_ratio < THRESHOLDS.calibrationWarn) continue;
    const src = sourceFor(snapshot, p.platform, "ad_platform");
    const crm = sourceFor(snapshot, null, "crm");
    out.push({
      id: `over_attribution:${p.platform}`,
      kind: "over_attribution",
      category: "measurement",
      severity: p.calibration_ratio >= THRESHOLDS.calibrationHigh ? "high" : "medium",
      title: `${p.platform} claims ${p.calibration_ratio}x the conversions the CRM can confirm`,
      summary: `${p.platform} reports ${p.platform_conversions} conversions on ${fmt(p.spend, snapshot.currency)} of spend; the CRM has ${p.leads} lead(s) matched to ${p.platform} (${p.deals} deal(s)). Judge ${p.platform} on cost per qualified lead (${p.cost_per_qualified === null ? "n/a" : fmt(p.cost_per_qualified, snapshot.currency)}) and per deal, not on its own conversion count.`,
      wasted_spend: null,
      spend_at_risk: p.spend,
      evidence: [
        { ...src, facts: { platform_conversions: p.platform_conversions, spend: p.spend } },
        { ...crm, facts: { crm_leads: p.leads, crm_qualified: p.qualified, crm_deals: p.deals, calibration_ratio: p.calibration_ratio } },
      ],
      recommendation: `Optimize ${p.platform} toward CRM-confirmed outcomes (send qualified and won events back as offline conversions) and compare budgets by cost per qualified lead.`,
    });
  }
  for (const a of snapshot.adsets) {
    if (a.platform_conversions < THRESHOLDS.campaignMinConversions || total <= 0 || a.spend / total < THRESHOLDS.campaignMinSpendShare) continue;
    const r = a.leads > 0 ? a.platform_conversions / a.leads : Number.POSITIVE_INFINITY;
    if (r < THRESHOLDS.campaignCalibration) continue;
    out.push({
      id: `over_attribution:${a.platform}:${slug(a.campaign)}:${slug(a.adset)}`,
      kind: "over_attribution",
      category: "measurement",
      severity: "high",
      title: `${name(a.campaign)} reports ${a.platform_conversions} conversions for ${a.leads} CRM lead(s)`,
      summary: `${a.platform} campaign "${name(a.campaign)}" (${name(a.adset)}) spent ${fmt(a.spend, snapshot.currency)} and reports ${a.platform_conversions} conversions. The CRM matched ${a.leads} lead(s) and ${a.deals} deal(s) to it.`,
      wasted_spend: null,
      spend_at_risk: a.spend,
      evidence: [
        { ...sourceFor(snapshot, a.platform, "ad_platform"), facts: { platform_conversions: a.platform_conversions, spend: a.spend } },
        { ...sourceFor(snapshot, null, "crm"), facts: { crm_leads: a.leads, crm_deals: a.deals } },
      ],
      recommendation: `Treat this campaign's reported conversions as unproven. Check what it counts as a conversion, and hold its budget until CRM leads catch up.`,
    });
  }
  return out;
}

function merVsRoas(snapshot: Snapshot): Draft[] {
  const mer = snapshot.totals.blended_mer;
  if (mer === null || mer <= 0) return [];
  return (snapshot.platforms as PlatformSnapshot[])
    .filter((p) => p.platform_roas !== null && p.platform_roas > mer * THRESHOLDS.roasOverMer)
    .map(
      (p): Draft => ({
        id: `mer_vs_roas:${p.platform}`,
        kind: "mer_vs_roas",
        category: "measurement",
        severity: "medium",
        title: `${p.platform} ROAS ${p.platform_roas} vs Blended MER ${mer}`,
        summary: `${p.platform} reports a ROAS of ${p.platform_roas}, while the business earned ${mer} per ${snapshot.currency} of ad spend across all channels (Blended MER, from CRM deals). The platform's value numbers are not revenue.`,
        wasted_spend: null,
        spend_at_risk: null,
        evidence: [
          { ...sourceFor(snapshot, p.platform, "ad_platform"), facts: { platform_roas: p.platform_roas } },
          { ...sourceFor(snapshot, null, "crm"), facts: { blended_mer: mer } },
        ],
        recommendation: `Plan budgets against Blended MER and cost per deal. Use ${p.platform}'s ROAS only to compare its own campaigns.`,
      }),
    );
}

function matching(snapshot: Snapshot): Draft[] {
  const { rate, unmatched } = snapshot.match;
  if (rate === null || rate >= THRESHOLDS.matchRateMin) return [];
  return [
    {
      id: "low_match_rate",
      kind: "low_match_rate",
      category: "measurement",
      severity: "medium",
      title: `Only ${Math.round(rate * 100)}% of CRM leads can be tied to a campaign`,
      summary: `${unmatched} lead(s) have no usable campaign tag (missing UTM, unknown source or campaign), so every per-campaign figure undercounts. They are listed in the scout report.`,
      wasted_spend: null,
      spend_at_risk: null,
      evidence: [{ ...sourceFor(snapshot, null, "crm"), facts: { match_rate: rate, unmatched_leads: unmatched } }],
      recommendation: "Make the WhatsApp entry links carry UTM parameters and a click id, and check that the CRM stores them.",
    },
  ];
}

function conversations(snapshot: Snapshot): Draft[] {
  const out: Draft[] = [];
  const { median_first_response_seconds: median, ghost_rate: ghost } = snapshot.conversations;
  const crm = sourceFor(snapshot, null, "crm");
  if (median !== null && median > THRESHOLDS.slowFirstResponseSeconds) {
    out.push({
      id: "slow_first_response",
      kind: "slow_first_response",
      category: "funnel",
      severity: "medium",
      title: `Median first response takes ${Math.round(median / 60)} minutes`,
      summary: `Half of the leads waited longer than ${Math.round(median / 60)} minutes for a first reply. Cold WhatsApp leads decay fast.`,
      wasted_spend: null,
      spend_at_risk: null,
      evidence: [{ ...crm, facts: { median_first_response_seconds: median } }],
      recommendation: "Add an instant auto-reply and a staffing rule for the busiest ad hours.",
    });
  }
  if (ghost !== null && ghost >= THRESHOLDS.ghostRateMax) {
    out.push({
      id: "conversation_drop_off",
      kind: "conversation_drop_off",
      category: "funnel",
      severity: "medium",
      title: `${Math.round(ghost * 100)}% of leads go quiet after the price`,
      summary: `${Math.round(ghost * 100)}% of conversations with a recorded outcome stop after the price is shared.`,
      wasted_spend: null,
      spend_at_risk: null,
      evidence: [{ ...crm, facts: { ghost_rate: ghost } }],
      recommendation: "Test a price message with the payment options (BNPL) up front, and a follow-up at 24 hours.",
    });
  }
  return out;
}

function dataQuality(snapshot: Snapshot): Draft[] {
  const out: Draft[] = [];
  if (snapshot.suspicious_cells.length > 0) {
    const bySource = new Map<string, number>();
    for (const c of snapshot.suspicious_cells) bySource.set(c.source_id, (bySource.get(c.source_id) ?? 0) + 1);
    out.push({
      id: "instruction_like_text",
      kind: "instruction_like_text",
      category: "data",
      severity: "medium",
      title: `${snapshot.suspicious_cells.length} data cell(s) read like instructions to an AI`,
      summary: `Text addressed to an AI assistant was found in ${[...bySource.keys()].map(name).join(", ")}. It is treated as plain data and no agent acts on it. Campaign names, UTM tags and CRM fields can be edited by anyone with access to those tools.`,
      wasted_spend: null,
      spend_at_risk: null,
      evidence: [...bySource.entries()].map(([source, count]) => {
        const first = snapshot.suspicious_cells.find((c) => c.source_id === source);
        const excerpt = first ? first.excerpt.slice(0, THRESHOLDS.excerptChars) : "";
        return { source, as_of: snapshot.sources.find((s) => s.source_id === source)?.period_end ?? null, facts: { cells: count, first_column: first?.column ?? "", first_row: first?.row ?? null, excerpt } };
      }),
      recommendation: "Find out who set these names and remove the text. Review who can edit campaign names and UTM parameters.",
    });
  }
  for (const s of snapshot.sources.filter((x) => x.stale)) {
    out.push({
      id: `stale_data:${slug(s.source_id)}`,
      kind: "stale_data",
      category: "data",
      severity: s.kind === "web_analytics" ? "low" : "high",
      title: `${name(s.source_id)} is ${s.age_days} day(s) old`,
      summary: `The newest data in this export is from ${s.period_end}, which is older than the freshness limit. Numbers that depend on it describe the past.`,
      wasted_spend: null,
      spend_at_risk: null,
      evidence: [{ source: s.source_id, as_of: s.period_end, facts: { age_days: s.age_days } }],
      recommendation: "Export fresh data into the dropzone and run `mdj scout` again.",
    });
  }
  return out;
}

// money known to be wasted ranks above money merely at risk, then larger amounts first
const impact = (f: Draft) => f.wasted_spend ?? f.spend_at_risk ?? 0;

export function diagnose(snapshot: Snapshot): Diagnosis {
  if (snapshot.status === "no_data") {
    return { status: "no_data", currency: snapshot.currency, period: null, findings: [], top: [], thresholds: THRESHOLDS };
  }
  const drafts = [...bleeding(snapshot), ...overAttribution(snapshot), ...merVsRoas(snapshot), ...matching(snapshot), ...conversations(snapshot), ...dataQuality(snapshot)];
  drafts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.wasted_spend ?? 0) - (a.wasted_spend ?? 0) || impact(b) - impact(a) || a.id.localeCompare(b.id));
  const findings = drafts.map((f, i): Finding => ({ ...f, rank: i + 1 }));
  const top = findings.filter((f) => f.category !== "data").slice(0, 3).map((f) => f.id);
  return { status: "ok", currency: snapshot.currency, period: snapshot.period, findings, top, thresholds: THRESHOLDS };
}
