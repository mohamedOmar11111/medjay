// The media-buyer rules: 20 deterministic checks over Meta, TikTok and Google exports. Each reads one
// small CSV, applies decision rules whose numbers live in config.ts, and returns a verdict per row
// plus a summary. Two of them (anomaly-explainer, test-readout) REFUSE to answer when the data is
// too thin. Nothing here writes anywhere: a verdict is advice, and a change still goes through a plan.
//
// Ported from the "20 Claude Skills for Media Buyers" guide and its mb_rules.py. Behaviour differences,
// on purpose: cells written as "27%" are read as 0.27; a cell that is present but not a number is
// reported as a warning instead of silently counting as 0; missing columns and bad dates are errors
// that name the column or row; test-readout cannot divide by zero clicks.
import { RULE_DEFAULTS, type RuleConfig } from "./config.js";

export type Row = Record<string, string>;
export type Cell = string | number;
export interface RuleResult {
  rows: Record<string, Cell>[];
  summary: Record<string, unknown>;
  warnings: string[];
}

export class MediaRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaRuleError";
  }
}

export interface Ctx {
  cfg: RuleConfig;
  params: Record<string, string>;
  now: () => Date;
  warn: (message: string) => void;
}

export interface ParamDef {
  name: string;
  required: boolean;
  note: string;
}

export interface RuleDef {
  id: string;
  number: number;
  platforms: string;
  title: string;
  description: string;
  /** The default file name under data/imports/media/. */
  file: string;
  columns: string[];
  optionalColumns: string[];
  params: ParamDef[];
  decision: string[];
  output: string;
  guardrails: string;
  run: (rows: Row[], ctx: Ctx) => { rows: Record<string, Cell>[]; summary: Record<string, unknown> };
}

// ---------- helpers

/** Python's round(): halves go to the even neighbour (72.5 -> 72), so numbers match the guide's output. */
export function pyRound(x: number, digits = 0): number {
  // Python rounds the exact binary value: 2.675 is really 2.67499..., so it gives 2.67; only a true
  // tie (0.5, 2.5, 72.5) goes to the even neighbour. toFixed with extra digits shows the exact expansion.
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 30));
  const tail = exact.slice(exact.length - 30);
  const isTie = /^50*$/.test(tail);
  if (!isTie) return Number(x.toFixed(digits));
  const scale = 10 ** digits;
  const floor = Math.floor(Math.abs(x) * scale);
  const even = floor % 2 === 0 ? floor : floor + 1;
  return (Math.sign(x) * even) / scale;
}

const norm = (s: unknown): string => String(s ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

function num(ctx: Ctx, cell: unknown, what: string, fallback = 0): number {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : fallback;
  const text = String(cell ?? "").trim();
  if (text === "") return fallback;
  const percent = text.endsWith("%");
  const n = Number(text.replace(/[,$%\s]/g, ""));
  if (!Number.isFinite(n)) {
    ctx.warn(`${what}: "${text.slice(0, 30)}" is not a number and counted as ${fallback}`);
    return fallback;
  }
  return percent ? n / 100 : n;
}

const DAY = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** A naive timestamp (no time zone) as UTC milliseconds. Dates and clock times are only ever compared with each other. */
export function parseDay(text: unknown, what: string): number {
  const m = DATE.exec(String(text ?? "").trim());
  if (!m) throw new MediaRuleError(`${what}: "${String(text ?? "").slice(0, 30)}" is not a date (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (Number.isNaN(ms)) throw new MediaRuleError(`${what}: "${m[0]}" is not a real date`);
  return ms;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number): string => {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const nowMs = (ctx: Ctx): number => (ctx.params.now ? parseDay(ctx.params.now, "param now") : ctx.now().getTime());

function param(ctx: Ctx, name: string): number {
  const raw = ctx.params[name];
  const n = raw === undefined ? Number.NaN : Number(String(raw).replace(/[,$]/g, ""));
  if (!Number.isFinite(n)) throw new MediaRuleError(`this check needs the parameter ${name}=<number> (for example ${name}=40)`);
  return n;
}

const at = (r: Row, i: number, c: string) => `row ${i + 2} ${c}`;

// ---------- the rules

function nearCopyCount(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const times = rows.map((r, i) => parseDay(r.launched, at(r, i, "launched")));
  const last = Math.max(...times);
  const recent = rows.filter((_, i) => (times[i] as number) > last - 30 * DAY);
  const groups = new Map<string, string[]>();
  for (const r of recent) {
    const key = [norm(r.angle), norm(r.format), norm(r.person)].join(" / ");
    groups.set(key, [...(groups.get(key) ?? []), r.ad_id as string]);
  }
  const n = groups.size;
  const verdict = n < cfg.concepts_min ? "UNDER" : n > cfg.concepts_max ? "ABOVE RANGE" : "IN RANGE";
  const out = [...groups].sort((a, b) => b[1].length - a[1].length).map(([concept, ids]) => ({ concept, ads: ids.length, ad_ids: ids.join(" ") }));
  return { rows: out, summary: { verdict, concepts: n, ads: recent.length, near_copies: recent.length - n, range: `${cfg.concepts_min}-${cfg.concepts_max}` } };
}

function unfundedAds(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const out = rows.map((r, i) => {
    const spend = num(ctx, r.spend_30d, at(r, i, "spend_30d"));
    const imp = num(ctx, r.impressions, at(r, i, "impressions"));
    const sales = num(ctx, r.purchases, at(r, i, "purchases"));
    const verdict = imp < cfg.impr_floor || spend < cfg.unfunded_spend ? "NEVER FUNDED" : sales === 0 ? "LEFT BEHIND" : "FUNDED";
    return { ad_id: r.ad_id as string, platform: r.platform ?? "", spend_30d: spend, impressions: Math.trunc(imp), purchases: Math.trunc(sales), verdict };
  });
  const total = out.reduce((a, o) => a + o.spend_30d, 0) || 1;
  const left = out.filter((o) => o.verdict === "LEFT BEHIND").reduce((a, o) => a + o.spend_30d, 0);
  return { rows: out, summary: { never_funded: out.filter((o) => o.verdict === "NEVER FUNDED").length, ads: out.length, left_behind_spend_share: pyRound(left / total, 3) } };
}

function leaveItAlone(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const target = param(ctx, "target_cpa");
  const spendOf = (r: Row, i: number) => num(ctx, r.spend !== undefined ? r.spend : r.spend_30d, at(r, i, "spend"));
  const sorted = rows.map((r, i) => ({ r, spend: spendOf(r, i), sales: num(ctx, r.purchases, at(r, i, "purchases")) })).sort((a, b) => b.spend - a.spend);
  const k = Math.max(1, Math.ceil(sorted.length * 0.1));
  const top = sorted.slice(0, k);
  const total = sorted.reduce((a, x) => a + x.spend, 0) || 1;
  const topSpend = top.reduce((a, x) => a + x.spend, 0);
  const sales = top.reduce((a, x) => a + x.sales, 0);
  const cpa = sales ? topSpend / sales : Number.POSITIVE_INFINITY;
  const verdict = cpa <= target ? "LEAVE ALONE" : cpa <= target * (1 + cfg.cpa_slack) ? "WATCH" : "FEED NEW CREATIVE";
  return {
    rows: top.map((x) => ({ ad_id: x.r.ad_id as string, spend: x.spend })),
    summary: { verdict, top_ads: k, top_share: pyRound(topSpend / total, 3), reference_share: cfg.top_decile_ref, top_cpa: Number.isFinite(cpa) ? pyRound(cpa, 2) : "no sales", target_cpa: target },
  };
}

function thumbstopCheck(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const out = rows.map((r, i) => {
    const imp = num(ctx, r.impressions, at(r, i, "impressions"));
    const rate = imp ? num(ctx, r.hook_views, at(r, i, "hook_views")) / imp : 0;
    const verdict = imp < cfg.impr_floor ? "TOO EARLY" : rate < cfg.thumbstop_floor ? "HOOK DEAD" : "HOOK OK";
    return { ad_id: r.ad_id as string, platform: r.platform ?? "", thumbstop: pyRound(rate, 3), roas: num(ctx, r.roas, at(r, i, "roas")), verdict };
  });
  return { rows: out, summary: { hook_dead: out.filter((o) => o.verdict === "HOOK DEAD").length } };
}

function fatigueCall(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const out = rows.map((r, i) => {
    const [cpmP, cpmN, ctrP, ctrN, freq] = (["cpm_prev", "cpm_now", "ctr_prev", "ctr_now", "frequency"] as const).map((c) => num(ctx, r[c], at(r, i, c)));
    const sig: string[] = [];
    if (cpmP && pyRound((cpmN as number) / cpmP - 1, 6) >= cfg.fatigue_cpm_rise) sig.push("CPM up");
    if (ctrP && pyRound(1 - (ctrN as number) / ctrP, 6) >= cfg.fatigue_ctr_drop) sig.push("CTR down");
    if ((freq as number) > cfg.fatigue_freq) sig.push(`freq > ${cfg.fatigue_freq}`);
    const verdict = sig.length >= cfg.fatigue_signals ? "FATIGUED" : sig.length > 0 ? "WATCH" : "FINE";
    return { ad_id: r.ad_id as string, signals: sig.join(", ") || "-", verdict };
  });
  return { rows: out, summary: { fatigued: out.filter((o) => o.verdict === "FATIGUED").length } };
}

function handsOff(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const now = nowMs(ctx);
  const out = rows.map((r, i) => {
    const first = parseDay(r.first_delivery, at(r, i, "first_delivery"));
    const age = (now - first) / 3_600_000;
    return { ad_id: r.ad_id as string, age_h: pyRound(age), verdict: age < cfg.hands_off_hours ? "HANDS OFF" : "OPEN", open_from: stamp(first + cfg.hands_off_hours * 3_600_000) };
  });
  return { rows: out, summary: { hands_off: out.filter((o) => o.verdict === "HANDS OFF").length } };
}

function tiktokFavourite(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const now = nowMs(ctx);
  const groups = new Map<string, { r: Row; spend: number }[]>();
  rows.forEach((r, i) => groups.set(r.ad_group as string, [...(groups.get(r.ad_group as string) ?? []), { r, spend: num(ctx, r.spend, at(r, i, "spend")) }]));
  const out = [...groups].map(([group, list]) => {
    const total = list.reduce((a, x) => a + x.spend, 0) || 1;
    const fav = list.reduce((a, x) => (x.spend > a.spend ? x : a));
    const share = fav.spend / total;
    const age = Math.floor((now - parseDay(fav.r.launched, `ad ${fav.r.ad_id} launched`)) / DAY);
    const verdict = share < cfg.favourite_share ? "SPREAD" : age > cfg.rotate_days ? "OLD FAVOURITE" : "NEW FAVOURITE";
    return { ad_group: group, favourite: fav.r.ad_id as string, share: pyRound(share, 2), age_days: age, verdict };
  });
  return { rows: out, summary: { old_favourites: out.filter((o) => o.verdict === "OLD FAVOURITE").length } };
}

function topSlotWatch(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const weeks = [...new Set(rows.map((r) => r.week as string))].sort();
  const last = weeks[weeks.length - 1];
  const byAd = new Map<string, Map<string, number>>();
  rows.forEach((r, i) => {
    const m = byAd.get(r.ad_id as string) ?? new Map<string, number>();
    m.set(r.week as string, num(ctx, r.spend_share, at(r, i, "spend_share")));
    byAd.set(r.ad_id as string, m);
  });
  const out: Record<string, Cell>[] = [];
  for (const [ad, shares] of byAd) {
    const peak = Math.max(...shares.values());
    if (peak < cfg.turnover_min_peak) continue;
    const current = (last === undefined ? undefined : shares.get(last)) ?? 0;
    out.push({ ad_id: ad, peak_share: peak, this_week: current, verdict: current <= peak * (1 - cfg.turnover_drop) ? "TURNING OVER" : "HOLDING" });
  }
  return { rows: out, summary: { turning_over: out.filter((o) => o.verdict === "TURNING OVER").length } };
}

function benchCheck(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const now = nowMs(ctx);
  const bench = rows.filter((r) => norm(r.status) === "approved");
  const stale = rows.filter((r) => norm(r.status) === "live" && Math.floor((now - parseDay(r.launched, `ad ${r.ad_id} launched`)) / DAY) > cfg.rotate_days);
  const short = Math.max(0, cfg.bench_min - bench.length);
  return {
    rows: stale.map((r) => ({ ad_id: r.ad_id as string, live_days: Math.floor((now - parseDay(r.launched, "launched")) / DAY) })),
    summary: { bench: bench.length, short_by: short, due_rotation: stale.length, verdict: short ? "SHORT" : "STOCKED" },
  };
}

function fairTest(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const out = rows.map((r, i) => {
    const imp = num(ctx, r.impressions, at(r, i, "impressions"));
    const verdict = imp < cfg.impr_floor ? "KEEP RUNNING" : imp < cfg.impr_read ? "EARLY READ" : imp < cfg.impr_pause ? "READ" : "PAUSE BY HAND";
    return { ad_id: r.ad_id as string, impressions: Math.trunc(imp), verdict };
  });
  const summary: Record<string, unknown> = {};
  if (ctx.params.weekly_budget !== undefined && ctx.params.cpm !== undefined) {
    const bought = (param(ctx, "weekly_budget") / param(ctx, "cpm")) * 1000;
    summary.impressions_per_week = Math.trunc(bought);
    summary.fair_tests_per_week = Math.floor(bought / cfg.impr_pause);
  }
  return { rows: out, summary };
}

function batchSizer(_rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const budget = param(ctx, "daily_budget");
  const cpa = param(ctx, "avg_cpa");
  const funded = budget >= cfg.batch_cpa_multiple * cpa;
  return {
    rows: [],
    summary: {
      daily_budget: budget,
      cpa_multiple_budget: cfg.batch_cpa_multiple * cpa,
      method_a_funded: funded,
      method_a: funded ? `${cfg.batch_big} ads per ad set` : "not funded",
      method_b: `${cfg.batch_small} ads per ad set at most, fewer on a small budget`,
    },
  };
}

function scaleInSteps(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const out = rows.map((r, i) => {
    const b = num(ctx, r.budget_now, at(r, i, "budget_now"));
    const prev = num(ctx, r.budget_prev, at(r, i, "budget_prev"));
    const cpa = num(ctx, r.cpa_3d, at(r, i, "cpa_3d"));
    const t = num(ctx, r.target_cpa, at(r, i, "target_cpa"));
    let verdict: string;
    let next: string;
    if (cpa <= t) [verdict, next] = ["STEP UP", `${(b * (1 + cfg.step_low)).toFixed(0)}-${(b * (1 + cfg.step_high)).toFixed(0)}`];
    else if (b > prev) [verdict, next] = ["CEILING", prev.toFixed(0)];
    else [verdict, next] = ["HOLD", b.toFixed(0)];
    return { ad_set: r.ad_set as string, budget: b, cpa_3d: cpa, target: t, verdict, next_budget: next };
  });
  return { rows: out, summary: {} };
}

function isCeiling(rows: Row[], ctx: Ctx) {
  const out = rows.map((r, i) => {
    const imp = num(ctx, r.impressions, at(r, i, "impressions"));
    const sis = num(ctx, r.search_is, at(r, i, "search_is"));
    const lostBudget = num(ctx, r.lost_is_budget, at(r, i, "lost_is_budget"));
    const lostRank = num(ctx, r.lost_is_rank, at(r, i, "lost_is_rank"));
    const flags: string[] = [];
    if (lostBudget > 0) flags.push(`budget-capped (${Math.round(lostBudget * 100)}% lost)`);
    if (r.exact_is !== undefined && r.exact_is.trim() !== "" && num(ctx, r.exact_is, at(r, i, "exact_is")) <= sis) flags.push("exact IS no better than overall");
    if (lostRank > 0) flags.push(`rank loss: check QS ${r.avg_qs && r.avg_qs.trim() !== "" ? r.avg_qs : "?"} before bids`);
    return { campaign: r.campaign as string, search_is: sis, ceiling: sis ? Math.trunc(imp / sis) : 0, flags: flags.join("; ") || "-" };
  });
  return { rows: out, summary: { budget_capped: out.filter((o) => o.flags.includes("budget-capped")).length } };
}

function pmaxSplit(rows: Row[], ctx: Ctx) {
  const target = param(ctx, "target_roas");
  const items = rows.map((r, i) => ({ product: r.product as string, spend: num(ctx, r.spend, at(r, i, "spend")), value: num(ctx, r.conv_value, at(r, i, "conv_value")) }));
  const spend = items.reduce((a, x) => a + x.spend, 0);
  const roas = spend ? items.reduce((a, x) => a + x.value, 0) / spend : 0;
  const out = items
    .map((x) => {
      const rr = x.spend ? x.value / x.spend : 0;
      return { product: x.product, spend: x.spend, roas: pyRound(rr, 2), bucket: x.spend === 0 ? "NO SPEND" : rr >= target ? "WINNER" : "LOSER" };
    })
    .sort((a, b) => b.roas - a.roas);
  return { rows: out, summary: { campaign_roas: pyRound(roas, 2), target_roas: target, verdict: roas < target && rows.length > 1 ? "SPLIT BEFORE ADDING SPEND" : "HOLDING TARGET" } };
}

function campaignJob(rows: Row[], _ctx: Ctx) {
  const out = rows.map((r) => {
    const miss = (["job", "signal", "metric"] as const).filter((f) => (r[f] ?? "").trim() === "");
    const issues = miss.map((m) => `no ${m}`);
    if (norm(r.type) === "pmax" && norm(r.brand_exclusions) !== "yes") issues.push("PMax without brand exclusions");
    return { campaign: r.campaign as string, type: r.type as string, verdict: miss.length ? "NO JOB" : issues.length ? "FIX" : "OK", issues: issues.join("; ") || "-" };
  });
  return { rows: out, summary: { no_job: out.filter((o) => o.verdict === "NO JOB").length } };
}

function brandSearchCheck(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const manual = new Set(cfg.manual_bids);
  const out = rows.map((r, i) => {
    const roas = num(ctx, r.roas, at(r, i, "roas"));
    const issues = manual.has(norm(r.bid_strategy).replaceAll(" ", "_")) ? [] : ["automated bidding on brand"];
    return { campaign: r.campaign as string, roas, band: roas < cfg.brand_roas_floor ? "BELOW FLOOR" : roas < cfg.brand_roas_ideal ? "OK" : "STRONG", issues: issues.join("; ") || "-" };
  });
  return { rows: out, summary: {} };
}

function dsaScout(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const cpa = param(ctx, "avg_cpa");
  const out = rows.map((r, i) => {
    const conv = num(ctx, r.conversions, at(r, i, "conversions"));
    const cost = num(ctx, r.cost, at(r, i, "cost"));
    const verdict = conv >= cfg.dsa_promote_conv && norm(r.in_keywords) !== "yes" ? "PROMOTE" : conv === 0 && cost >= cpa ? "NEGATIVE" : "WAIT";
    return { search_term: r.search_term as string, conversions: Math.trunc(conv), cost, verdict };
  });
  return { rows: out, summary: { promote: out.filter((o) => o.verdict === "PROMOTE").length, negative: out.filter((o) => o.verdict === "NEGATIVE").length } };
}

const STOP = new Set("a an the and or of to for your you with in on is it this that my our".split(" "));

function hookPageMatch(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  const out = rows.map((r, i) => {
    const hookText = norm(r.hook);
    const words = hookText.split(" ").map((w) => w.replace(/^[.,!?:;"']+|[.,!?:;"']+$/g, "")).filter((w) => w && !STOP.has(w));
    const head = norm(r.page_headline);
    const hit = words.length ? words.filter((w) => head.includes(w)).length / words.length : 0;
    const exact = hookText.replace(/^[.!?]+|[.!?]+$/g, "") !== "" && head.includes(hookText.replace(/^[.!?]+|[.!?]+$/g, ""));
    const verdict = exact ? "WORD FOR WORD" : hit >= cfg.match_min ? "MATCH" : "MISMATCH";
    return { ad_id: r.ad_id as string, overlap: pyRound(hit, 2), verdict, load: num(ctx, r.load_s, at(r, i, "load_s")) > cfg.load_max_s ? "SLOW" : "ok" };
  });
  return { rows: out, summary: { mismatch: out.filter((o) => o.verdict === "MISMATCH").length } };
}

function anomalyExplainer(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  if (!ctx.params.change_date) throw new MediaRuleError("this check needs change_date=YYYY-MM-DD, the day the account was changed");
  const change = parseDay(ctx.params.change_date, "param change_date");
  const days = rows.map((r, i) => ({ t: parseDay(r.date, at(r, i, "date")), spend: num(ctx, r.spend, at(r, i, "spend")), conv: num(ctx, r.conversions, at(r, i, "conversions")) }));
  const end = Math.max(...days.map((d) => d.t));
  const cutoff = end - cfg.lag_days * DAY;
  const use = days.filter((d) => d.t <= cutoff);
  const before = use.filter((d) => d.t < change);
  const after = use.filter((d) => d.t >= change);
  const cb = before.reduce((a, d) => a + d.conv, 0);
  const ca = after.reduce((a, d) => a + d.conv, 0);
  const gates: string[] = [];
  if (before.length < cfg.min_days) gates.push(`baseline ${before.length}d < ${cfg.min_days}d`);
  if (after.length < cfg.min_days) gates.push(`after-window ${after.length}d < ${cfg.min_days}d`);
  if (cb < cfg.min_conversions) gates.push(`baseline ${Math.trunc(cb)} conv < ${cfg.min_conversions}`);
  if (ca < cfg.min_conversions) gates.push(`after-window ${Math.trunc(ca)} conv < ${cfg.min_conversions}`);
  if (gates.length > 0) {
    const rate = after.length && ca ? ca / after.length : 1;
    const need = Math.max(cfg.min_days, Math.ceil(cfg.min_conversions / rate));
    return { rows: [], summary: { verdict: "REFUSED: NO CAUSE NAMED", failed_gates: gates, earliest_read: isoDay(change + (need + cfg.lag_days) * DAY) } };
  }
  const cpaB = before.reduce((a, d) => a + d.spend, 0) / cb;
  const cpaA = after.reduce((a, d) => a + d.spend, 0) / ca;
  return { rows: [], summary: { verdict: "READ OK", cpa_before: pyRound(cpaB, 2), cpa_after: pyRound(cpaA, 2), shift: pyRound(cpaA / cpaB - 1, 3), days_dropped_for_lag: cfg.lag_days } };
}

function testReadout(rows: Row[], ctx: Ctx) {
  const { cfg } = ctx;
  if (rows.length < 2) throw new MediaRuleError("test_arms.csv needs two arms (two rows)");
  const hours = Number(ctx.params.hours_live ?? 0);
  const [a, b] = [rows[0] as Row, rows[1] as Row];
  const arm = (r: Row, i: number) => ({ name: r.arm as string, imp: num(ctx, r.impressions, at(r, i, "impressions")), clicks: num(ctx, r.clicks, at(r, i, "clicks")), conv: num(ctx, r.conversions, at(r, i, "conversions")) });
  const [x, y] = [arm(a, 0), arm(b, 1)];
  const gates: string[] = [];
  for (const r of [x, y]) {
    if (r.conv < cfg.min_conversions) gates.push(`${r.name}: ${Math.trunc(r.conv)} conv < ${cfg.min_conversions}`);
    if (r.imp < cfg.impr_floor) gates.push(`${r.name}: ${Math.trunc(r.imp)} impressions < ${cfg.impr_floor}`);
  }
  if (!(hours >= cfg.hands_off_hours)) gates.push(`live ${Number.isFinite(hours) ? hours.toFixed(0) : "?"}h < ${cfg.hands_off_hours}h`);
  if (x.clicks === 0 || y.clicks === 0) {
    gates.push("an arm has no clicks, so no rate can be compared");
    return { rows: [], summary: { verdict: "REFUSED: NO WINNER YET", failed_gates: gates } };
  }
  const p1 = x.conv / x.clicks;
  const p2 = y.conv / y.clicks;
  const pool = (x.conv + y.conv) / (x.clicks + y.clicks);
  const se = Math.sqrt(pool * (1 - pool) * (1 / x.clicks + 1 / y.clicks)) || 1;
  const z = (p1 - p2) / se;
  if (Math.abs(z) < cfg.z_crit) gates.push(`|z| ${Math.abs(z).toFixed(2)} < ${cfg.z_crit}`);
  const summary: Record<string, unknown> = { [`cvr_${x.name}`]: pyRound(p1, 4), [`cvr_${y.name}`]: pyRound(p2, 4), z: pyRound(z, 2) };
  if (gates.length > 0) Object.assign(summary, { verdict: "REFUSED: NO WINNER YET", failed_gates: gates });
  else summary.verdict = `WINNER: ${z > 0 ? x.name : y.name}`;
  return { rows: [], summary };
}

// ---------- the registry (also the documentation: `mdj media explain <id>` prints it)

const D = RULE_DEFAULTS;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export const RULES: RuleDef[] = [
  {
    id: "near-copy-count", number: 1, platforms: "meta, tiktok", title: "Near-copy counter",
    description: "Counts genuinely different ad concepts launched in the last 30 days, treating near-copies as one concept the way Meta's Andromeda groups look-alike ads. Use when planning next month's creative or when more ads stop moving results.",
    file: "ads.csv", columns: ["ad_id", "launched", "angle", "format", "person"], optionalColumns: ["platform"], params: [],
    decision: ["Same angle + same format + same person on camera = one concept. Change any one of the three and it counts as new.", `Under ${D.concepts_min} concepts in 30 days = UNDER. ${D.concepts_min}-${D.concepts_max} = IN RANGE. Over ${D.concepts_max} = ABOVE RANGE.`, "If angle, format or person is blank, tag each ad from its primary text, first 3 seconds and thumbnail first (a person or an agent run does that; this check only counts)."],
    output: "verdict summary (concepts, ads, near-copies), then one row per concept group, biggest first.", guardrails: "Never groups ads by their names.", run: nearCopyCount,
  },
  {
    id: "unfunded-ads", number: 2, platforms: "meta, tiktok", title: "Unfunded ad finder",
    description: "Separates ads that never got funded from ads that got a real shot and lost. Use before killing ads with zero sales or before judging a creative batch.",
    file: "ads.csv", columns: ["ad_id", "spend_30d", "impressions", "purchases"], optionalColumns: ["platform"], params: [],
    decision: [`Under ${D.impr_floor} impressions OR under $${D.unfunded_spend} spend in 30 days = NEVER FUNDED. It has not been tested; it is not a loser.`, "Funded with 0 purchases = LEFT BEHIND. Meta already starves these; hand-killing them saves little.", "Everything else = FUNDED."],
    output: "verdict per ad, then never-funded count and the share of spend on left-behind ads. Move the never-funded ads you still believe in to the test campaign (fair-test).", guardrails: "Never calls a never-funded ad a loser.", run: unfundedAds,
  },
  {
    id: "leave-it-alone", number: 3, platforms: "meta, tiktok", title: "Leave-it-alone check",
    description: "Checks whether a few ads carrying most of your spend is a problem or the normal resting state, and says to leave them alone when their CPA holds.",
    file: "ads.csv", columns: ["ad_id", "purchases", "spend (or spend_30d)"], optionalColumns: [], params: [{ name: "target_cpa", required: true, note: "your target CPA" }],
    decision: [`The top 10% of ads taking about ${pct(D.top_decile_ref)} of spend is normal. Never force spend to spread.`, "Top ads' CPA at or under target = LEAVE ALONE.", `Up to ${pct(D.cpa_slack)} over target = WATCH (pack default).`, `More than ${pct(D.cpa_slack)} over = FEED NEW CREATIVE into a new ad set. The fix is new ads, never a forced split.`],
    output: "top-10% share next to the reference share, the top ads' CPA against target, and a verdict.", guardrails: "Never recommends pausing a top ad that holds target.", run: leaveItAlone,
  },
  {
    id: "thumbstop-check", number: 4, platforms: "meta, tiktok", title: "Thumbstop check",
    description: `Flags video ads whose hook is dead (thumbstop under ${pct(D.thumbstop_floor)}) even when today's ROAS still looks fine. hook_views = Meta 3-second video plays or TikTok 2-second video views.`,
    file: "ads_video.csv", columns: ["ad_id", "impressions", "hook_views"], optionalColumns: ["platform", "roas"], params: [],
    decision: [`Under ${D.impr_floor} impressions = TOO EARLY.`, `thumbstop = hook_views / impressions. Under ${D.thumbstop_floor} = HOOK DEAD, whatever the ROAS says.`, "At or above = HOOK OK."],
    output: "verdict per video ad. Keep the body and replace the first 3 seconds of HOOK DEAD ads.", guardrails: "The 25% line is a Meta benchmark; on TikTok it is applied as the same default.", run: thumbstopCheck,
  },
  {
    id: "fatigue-call", number: 5, platforms: "meta, tiktok", title: "Fatigue judge",
    description: `Calls creative fatigue only when ${D.fatigue_signals} of 3 signals fire at once (CPM up ${pct(D.fatigue_cpm_rise)}, CTR down ${pct(D.fatigue_ctr_drop)}, frequency over ${D.fatigue_freq}). "now" = last 7 days, "prev" = the 7 days before.`,
    file: "fatigue.csv", columns: ["ad_id", "cpm_prev", "cpm_now", "ctr_prev", "ctr_now", "frequency"], optionalColumns: [], params: [],
    decision: ["CPM up, CTR down or frequency over the line = one signal each.", "2 or 3 signals = FATIGUED. 1 = WATCH. 0 = FINE.", "A FATIGUED ad gets the same angle relaunched in a new format. Boosting the old ad is never the fix."],
    output: "ad, signals, verdict.", guardrails: "One signal alone is never fatigue.", run: fatigueCall,
  },
  {
    id: "72h-guard", number: 6, platforms: "meta, tiktok", title: "72-hour guard",
    description: "Lists ads younger than 72 hours so nobody edits, pauses or judges them yet. Run it first, before any check that recommends a change.",
    file: "launches.csv", columns: ["ad_id", "first_delivery"], optionalColumns: [], params: [{ name: "now", required: false, note: "the current time, YYYY-MM-DDTHH:MM (default: the clock)" }],
    decision: [`Under ${D.hands_off_hours} hours since first delivery = HANDS OFF: no pause, no budget change, no verdict.`, "72 hours or more = OPEN."],
    output: "ad, age in hours, verdict, and when it opens up.", guardrails: "If another check flags a HANDS OFF ad, strike that recommendation and say why.", run: handsOff,
  },
  {
    id: "tiktok-favourite", number: 7, platforms: "tiktok", title: "TikTok favourite check",
    description: "Finds TikTok ad groups where one video takes half or more of the spend and that video is more than 3 weeks old. Use weekly on every TikTok ad group with 3+ ads.",
    file: "tiktok_groups.csv", columns: ["ad_group", "ad_id", "spend", "launched"], optionalColumns: [], params: [{ name: "now", required: false, note: "today, YYYY-MM-DD (default: the clock)" }],
    decision: ["Favourite = the ad with the most spend in the group (spend over the last 7 days).", `Share under ${pct(D.favourite_share)} = SPREAD.`, `${pct(D.favourite_share)} or more and launched over ${D.rotate_days} days ago = OLD FAVOURITE: the newer videos in that group never got a real read.`, `${pct(D.favourite_share)} or more and ${D.rotate_days} days or younger = NEW FAVOURITE: fine.`],
    output: "ad group, favourite, share, age, verdict. Move an old-favourite group's newer videos to the test campaign (fair-test).", guardrails: "Never recommends pausing the favourite on this check alone.", run: tiktokFavourite,
  },
  {
    id: "top-slot-watch", number: 8, platforms: "meta, tiktok", title: "Top slot watch",
    description: "Watches the ads that carry your spend and flags the week one of them has lost half its peak budget share, so the next winner is already live when the top ad turns over. Needs 4+ weeks.",
    file: "weekly_share.csv", columns: ["ad_id", "week", "spend_share"], optionalColumns: [], params: [],
    decision: [`Only ads that ever held ${pct(D.turnover_min_peak)} or more of weekly spend are tracked (pack default).`, `This week's share at or under half its peak = TURNING OVER. Otherwise HOLDING.`, "A #1 ad stays #1 the next month only about 30% of the time, so a TURNING OVER flag means launch from the bench now."],
    output: "ad, peak share, this week's share, verdict.", guardrails: "Never recommends pausing the turning-over ad; the platform moves its budget on its own.", run: topSlotWatch,
  },
  {
    id: "bench-check", number: 9, platforms: "meta, tiktok", title: "Backup bench",
    description: `Counts approved-but-unlaunched ads against a bench of ${D.bench_min} and lists live ads older than 3 weeks that are due a refresh. Use every Friday.`,
    file: "bench.csv", columns: ["ad_id", "status", "launched"], optionalColumns: [], params: [{ name: "now", required: false, note: "today, YYYY-MM-DD (default: the clock)" }],
    decision: [`Fewer than ${D.bench_min} approved ads waiting = SHORT by the gap.`, `Live for more than ${D.rotate_days} days = due for rotation (refresh every 2-3 weeks, before the numbers fall).`],
    output: "bench count, shortfall, and the live ads due for rotation.", guardrails: "Never launches anything.", run: benchCheck,
  },
  {
    id: "fair-test", number: 10, platforms: "meta, tiktok", title: "Fair test planner",
    description: "Runs a small-budget test campaign so every creative gets 2,000-3,000 impressions before anyone judges it, and says when to pause each one by hand.",
    file: "test_ads.csv", columns: ["ad_id", "impressions"], optionalColumns: [], params: [{ name: "weekly_budget", required: false, note: "weekly test budget" }, { name: "cpm", required: false, note: "your CPM (with weekly_budget, gives the fair tests per week)" }],
    decision: [`Under ${D.impr_floor} impressions = KEEP RUNNING. Never judge.`, `${D.impr_floor}-${D.impr_read - 1} = EARLY READ: kill only on CTR, link CTR or CPM.`, `${D.impr_read}-${D.impr_pause - 1} = READ: judge on purchases or trials.`, `${D.impr_pause} or more = PAUSE BY HAND so the money moves to the next ad.`, `Fair tests per week = (weekly budget / CPM x 1,000) / ${D.impr_pause}.`, "Never turn the test campaign off. 3-4 winners move to the scaling campaign."],
    output: "impressions bought and fair tests per week (when budget and CPM are given), then a verdict per ad.", guardrails: "Recommends pauses; you make them.", run: fairTest,
  },
  {
    id: "batch-sizer", number: 11, platforms: "meta", title: "Batch size calculator",
    description: "How many ads to put in one Meta ad set for your budget. Two practitioners disagree, so both methods are shown and neither is chosen for you.",
    file: "-", columns: [], optionalColumns: [], params: [{ name: "daily_budget", required: true, note: "ad set daily budget" }, { name: "avg_cpa", required: true, note: "average CPA" }],
    decision: [`Method A (big batch): ${D.batch_big} ads per ad set, only funded when the daily budget is at least ${D.batch_cpa_multiple}x average CPA. Meta picks 1-2 favourites within about 2 days; pull them out and repeat.`, `Method B (small batch): ${D.batch_small} ads at most per ad set, fewer on a small budget, grouped by product, angle or concept.`, `Under ${D.batch_cpa_multiple}x CPA, Method A is "not funded".`],
    output: "budget, the CPA-multiple line, and both methods.", guardrails: "Never picks a method for you. Takes no file.", run: batchSizer,
  },
  {
    id: "scale-in-steps", number: 12, platforms: "meta, tiktok", title: "Scale stepper",
    description: "Scales winners in place, 15-20% at a time, and marks the ceiling when CPA stops holding. Use every 3 days on ad sets you are scaling.",
    file: "adsets.csv", columns: ["ad_set", "budget_now", "budget_prev", "cpa_3d", "target_cpa"], optionalColumns: [], params: [],
    decision: [`3-day CPA at or under target = STEP UP to budget x ${1 + D.step_low}-${1 + D.step_high}.`, "Over target right after a step up = CEILING: go back to the previous budget and leave it there.", "Over target with no recent step = HOLD.", "One great day never justifies tripling spend."],
    output: "ad set, budget, CPA, target, verdict, next budget.", guardrails: "Every budget change waits for a plan and an approval.", run: scaleInSteps,
  },
  {
    id: "is-ceiling", number: 13, platforms: "google", title: "Impression share ceiling",
    description: "Reads Google search impression share in the right order (Lost IS budget first, then exact vs overall, then rank) and computes each campaign's ceiling. Use before raising any search budget. Rates as decimals or with a % sign.",
    file: "google_is.csv", columns: ["campaign", "impressions", "search_is", "lost_is_budget", "lost_is_rank"], optionalColumns: ["exact_is", "avg_qs"], params: [],
    decision: ["Lost IS (Budget) above 0% = budget-capped: auctions you are eligible for and not entering.", "Exact match IS no higher than overall Search IS = you are probably losing the searches you want.", "Lost IS (Rank) above 0% = check Quality Score before touching bids or ads.", "Ceiling = impressions / Search IS (50,000 at 40% = 125,000 searches)."],
    output: "campaign, search IS, ceiling, flags.", guardrails: "Never recommends a budget raise on a campaign whose only flag is rank.", run: isCeiling,
  },
  {
    id: "pmax-split", number: 14, platforms: "google", title: "PMax splitter",
    description: "Blocks budget increases on an all-products Performance Max campaign that is under target ROAS and splits its products into winners, losers and no-spend.",
    file: "pmax_products.csv", columns: ["product", "spend", "conv_value"], optionalColumns: [], params: [{ name: "target_roas", required: true, note: "your target ROAS" }],
    decision: ["Campaign ROAS under target with more than 1 product = SPLIT BEFORE ADDING SPEND.", "Product ROAS at or above target = WINNER. Under = LOSER. No spend = NO SPEND.", "Proposed structure: winners in their own PMax, losers in a lower-budget PMax, no-spend products listed for a feed check."],
    output: "campaign ROAS against target with a verdict, then product, spend, ROAS, bucket.", guardrails: "Never recommends adding budget to an unsplit campaign under target.", run: pmaxSplit,
  },
  {
    id: "campaign-job", number: 15, platforms: "google", title: "Campaign job check",
    description: "Checks that every campaign has a written job, the signal it produces and the one metric that decides its fate, and flags PMax without brand exclusions. Use monthly and before any restructure.",
    file: "campaigns.csv", columns: ["campaign", "type"], optionalColumns: ["job", "signal", "metric", "brand_exclusions"], params: [],
    decision: ["Missing job, signal or metric = NO JOB. A campaign you cannot answer all 3 for should not be running.", "PMax without brand exclusions = FIX (set brand_exclusions to yes once they are in place).", "Reference jobs: branded search = protect the brand, judged on ROAS; non-branded shopping = new customers, judged on new-customer ROAS; PMax = remarketing for most brands, with brand exclusions and a high tROAS; non-branded search = demand clean-up; Demand Gen = create demand, launched only after the others are profitable."],
    output: "campaign, type, verdict, issues; a proposed job, signal and metric per NO JOB row is for a person to write.", guardrails: "Proposes jobs; you confirm them.", run: campaignJob,
  },
  {
    id: "brand-search-check", number: 16, platforms: "google", title: "Branded search check",
    description: `Checks branded search campaigns against a ROAS floor of ${D.brand_roas_floor} and flags automated bidding on brand terms.`,
    file: "brand.csv", columns: ["campaign", "bid_strategy", "roas"], optionalColumns: [], params: [],
    decision: [`ROAS under ${D.brand_roas_floor} = BELOW FLOOR. ${D.brand_roas_floor} to under ${D.brand_roas_ideal} = OK. ${D.brand_roas_ideal} or more = STRONG.`, "Any bid strategy other than manual CPC or target impression share is flagged: automated bidding on brand inflates CPCs for revenue you would likely get anyway."],
    output: "campaign, ROAS, band, issues.", guardrails: "The floor and ideal are one practitioner's ecommerce numbers; set your own in context/media-rules.yaml for your margin.", run: brandSearchCheck,
  },
  {
    id: "dsa-scout", number: 17, platforms: "google", title: "DSA keyword scout",
    description: "Uses dynamic search ad search terms as a keyword scout, promoting converting terms to keywords and listing proven non-converters as negatives. Use weekly.",
    file: "dsa_terms.csv", columns: ["search_term", "conversions", "cost", "in_keywords"], optionalColumns: [], params: [{ name: "avg_cpa", required: true, note: "average CPA" }],
    decision: [`${D.dsa_promote_conv}+ conversions and not already a keyword = PROMOTE to an exact-match keyword (pack default).`, "0 conversions and cost at or above 1x average CPA = NEGATIVE.", "Anything else = WAIT."],
    output: "search term, conversions, cost, verdict.", guardrails: "Never adds keywords or negatives itself; promoted and negated terms go into a plan.", run: dsaScout,
  },
  {
    id: "hook-page-match", number: 18, platforms: "all", title: "Hook-to-page match",
    description: "Compares each ad's hook with the landing page headline it sends to, and flags pages slower than 2 seconds. Use before scaling any ad.",
    file: "hook_pages.csv", columns: ["ad_id", "hook", "page_headline"], optionalColumns: ["load_s"], params: [],
    decision: ["Headline contains the hook exactly = WORD FOR WORD.", `${pct(D.match_min)}+ of the hook's content words in the headline = MATCH (pack default).`, "Anything less = MISMATCH: the promise breaks at the click.", `Load time over ${D.load_max_s} seconds = SLOW.`],
    output: "ad, overlap, verdict, load. For a MISMATCH, propose a headline that repeats the hook word for word.", guardrails: "Proposes headlines; never edits the page.", run: hookPageMatch,
  },
  {
    id: "anomaly-explainer", number: 19, platforms: "all", title: "Anomaly explainer",
    description: "Reads the change in cost per conversion around a date the account was changed, and REFUSES to name a cause when the data is too thin to carry one. Needs 30+ days of account totals.",
    file: "daily.csv", columns: ["date", "spend", "conversions"], optionalColumns: [], params: [{ name: "change_date", required: true, note: "the day the account was changed, YYYY-MM-DD" }],
    decision: [`The last ${D.lag_days} days are dropped (conversions are still being reported).`, `Both sides of the change need at least ${D.min_days} days and ${D.min_conversions} conversions.`, "If any gate fails the answer is REFUSED: NO CAUSE NAMED, the gates that failed, and the earliest date a read is possible.", "If the gates pass it reports CPA before and after and the shift. It describes a shift; it never claims the change caused it."],
    output: "a refusal with its reasons, or CPA before, CPA after and the shift.", guardrails: "Never names a cause.", run: anomalyExplainer,
  },
  {
    id: "test-readout", number: 20, platforms: "all", title: "Test readout",
    description: "Reads a two-arm test and REFUSES to name a winner the data cannot carry. The comparison is conversions per click.",
    file: "test_arms.csv", columns: ["arm", "impressions", "clicks", "conversions"], optionalColumns: [], params: [{ name: "hours_live", required: true, note: "hours the test has been live" }],
    decision: [`Each arm needs ${D.min_conversions}+ conversions and ${D.impr_floor}+ impressions, and the test must be live ${D.hands_off_hours}+ hours.`, `The difference in conversion rate must clear |z| ${D.z_crit} (two-proportion z-test).`, "Any gate failing = REFUSED: NO WINNER YET, with each failed gate listed. Otherwise WINNER: <arm>."],
    output: "each arm's rate, z, and a verdict or a refusal.", guardrails: "Never names a winner when a gate fails. The first two rows are the two arms.", run: testReadout,
  },
];

export const RULE_IDS = RULES.map((r) => r.id);
export const ruleById = (id: string): RuleDef | undefined => RULES.find((r) => r.id === id);

/** The order the guide runs them on a Monday: guards and judgements first, then the rest by number. */
export const MONDAY_ORDER = ["72h-guard", "leave-it-alone", "unfunded-ads", "fatigue-call", "thumbstop-check", "near-copy-count"];

export function runRule(def: RuleDef, rows: Row[], options: { cfg: RuleConfig; params?: Record<string, string>; now?: () => Date }): RuleResult {
  const warnings: string[] = [];
  const ctx: Ctx = { cfg: options.cfg, params: options.params ?? {}, now: options.now ?? (() => new Date()), warn: (m) => warnings.length < 20 && warnings.push(m) };
  if (def.file !== "-") {
    if (rows.length === 0) throw new MediaRuleError(`${def.file} has no rows`);
    const have = new Set(Object.keys(rows[0] as Row));
    const needs = def.columns.filter((c) => !c.includes("(")).filter((c) => !have.has(c));
    // a column written "spend (or spend_30d)" is satisfied by either name
    const alt = def.columns.filter((c) => c.includes("(")).filter(() => !have.has("spend") && !have.has("spend_30d"));
    if (needs.length > 0 || alt.length > 0) {
      throw new MediaRuleError(`${def.file} is missing column(s): ${[...needs, ...alt.map(() => "spend or spend_30d")].join(", ")}; found: ${[...have].join(", ")}`);
    }
  }
  const result = def.run(rows, ctx);
  return { ...result, warnings };
}

/** A markdown table, then the summary as one JSON line, then warnings. */
export function renderRule(result: RuleResult): string {
  const lines: string[] = [];
  if (result.rows.length > 0) {
    const cols = Object.keys(result.rows[0] as Record<string, Cell>);
    lines.push(`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
    for (const row of result.rows) lines.push(`| ${cols.map((c) => String(row[c] ?? "").replaceAll("|", "/")).join(" | ")} |`);
  }
  lines.push(`SUMMARY ${JSON.stringify(result.summary)}`);
  for (const w of result.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
