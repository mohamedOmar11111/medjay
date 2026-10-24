// Turning Medjay's analysis results into answers a marketer can act on, in English or Arabic: lead with
// the money, say what to do, no jargon (no MER, P50, calibration), and offer the next questions.
// Commands, plan numbers and hashes stay plain ASCII in both languages. The Arabic wording was written
// for this app and has not yet been reviewed by a native-speaking marketer.
import type { Diagnosis, Finding } from "../analysis/diagnose.js";
import type { PlatformSnapshot, Snapshot } from "../analysis/scout.js";
import type { SimulationResult } from "../analysis/simulate.js";
import type { PeriodSummary } from "../analysis/summary.js";
import type { Dashboard } from "./dashboard.js";
import type { IntentName, Language, Routed } from "./intent.js";
import type { ModelFailure } from "./model-errors.js";

export interface Suggestion {
  label: string;
  intent: IntentName;
  params?: Routed["params"];
}

export interface Answer {
  headline: string;
  body: string[];
  next: Suggestion[];
}

const pick = (lang: Language) => (en: string, ar: string) => (lang === "ar" ? ar : en);

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

export const money = (n: number, currency: string): string => `${currency} ${Math.round(n).toLocaleString("en-US")}`;
const signedMoney = (n: number, currency: string): string => `${n < 0 ? "-" : "+"}${money(Math.abs(n), currency)}`;
const x = (n: number): string => `${Number(n.toFixed(2))}×`;
const pct = (n: number): number => Math.round(n * 100);

function day(iso: string, lang: Language): { d: number; m: string } {
  const [, m, d] = iso.split("-").map(Number);
  return { d: d ?? 0, m: (lang === "ar" ? MONTHS_AR : MONTHS_EN)[(m ?? 1) - 1] ?? "" };
}

export function periodLabel(start: string, end: string, lang: Language): string {
  const a = day(start, lang);
  const b = day(end, lang);
  if (a.m === b.m) return lang === "ar" ? `${a.d}–${b.d} ${a.m}` : `${a.d}–${b.d} ${a.m}`;
  return `${a.d} ${a.m} – ${b.d} ${b.m}`;
}

export const platformName = (id: string): string => ({ meta: "Meta", google: "Google", tiktok: "TikTok", snapchat: "Snapchat", linkedin: "LinkedIn" })[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

const SOURCE_NAMES: Record<string, [string, string]> = {
  meta_ads: ["Meta Ads", "إعلانات Meta"],
  google_ads: ["Google Ads", "إعلانات Google"],
  tiktok_ads: ["TikTok Ads", "إعلانات TikTok"],
  snapchat_ads: ["Snapchat Ads", "إعلانات Snapchat"],
  linkedin_ads: ["LinkedIn Ads", "إعلانات LinkedIn"],
  ga4: ["Website analytics", "تحليلات الموقع"],
  web_analytics: ["Website analytics", "تحليلات الموقع"],
  crm: ["Your CRM", "نظام العملاء (CRM)"],
};
export function sourceName(sourceId: string, lang: Language): string {
  const base = sourceId.split(":")[0] ?? sourceId;
  const known = SOURCE_NAMES[base];
  return known ? known[lang === "ar" ? 1 : 0] : base;
}

const NEXT = {
  performance: (lang: Language): Suggestion => ({ label: pick(lang)("How are my ads doing?", "كيف حال الإعلانات؟"), intent: "performance" }),
  waste: (lang: Language): Suggestion => ({ label: pick(lang)("What's wasting money?", "وين تضيع الفلوس؟"), intent: "waste" }),
  scale: (lang: Language, p = 20): Suggestion => ({ label: pick(lang)(`Can I safely raise spend by ${p}%?`, `هل أقدر أزود الصرف ${p}%؟`), intent: "scale", params: { pct: p } }),
  plans: (lang: Language): Suggestion => ({ label: pick(lang)("What's waiting for my approval?", "ايش ينتظر موافقتي؟"), intent: "plans" }),
  data: (lang: Language): Suggestion => ({ label: pick(lang)("Is my data up to date?", "هل البيانات محدثة؟"), intent: "data" }),
  trust: (lang: Language): Suggestion => ({ label: pick(lang)("Has anything been changed behind my back?", "هل تغيّر شيء من ورا ظهري؟"), intent: "trust" }),
};

export const noDataAnswer = (lang: Language, dropzone: string): Answer => {
  const t = pick(lang);
  return {
    headline: t("I don't have any ad numbers yet.", "ما عندي أرقام إعلانات للحين."),
    body: [t(`Export your reports (Meta, Google, website analytics, CRM) into ${dropzone} and ask me again. I'll read them straight away.`, `صدّر تقاريرك (Meta وGoogle وتحليلات الموقع والـ CRM) إلى ${dropzone} ثم اسألني من جديد، وأقراها فوراً.`)],
    next: [NEXT.data(lang)],
  };
};

export function performanceAnswer(snapshot: Snapshot, lang: Language, dropzone: string): Answer {
  if (snapshot.status === "no_data" || !snapshot.period) return noDataAnswer(lang, dropzone);
  const t = pick(lang);
  const cur = snapshot.currency;
  const { spend, revenue, blended_mer: mer, cost_per_lead: cpl, cost_per_deal: cpd } = snapshot.totals;
  const when = periodLabel(snapshot.period.start, snapshot.period.end, lang);
  const body: string[] = [];
  if (mer !== null && spend > 0) body.push(t(`That is ${x(mer)} back for every 1 ${cur} spent.`, `يعني ${x(mer)} راجع لكل 1 ${cur} صرفتها.`));
  if (cpl !== null && cpd !== null) body.push(t(`A lead costs about ${money(cpl, cur)} and a sale about ${money(cpd, cur)}.`, `العميل المحتمل يكلفك حوالي ${money(cpl, cur)} والبيعة حوالي ${money(cpd, cur)}.`));
  else if (cpl !== null) body.push(t(`A lead costs about ${money(cpl, cur)}.`, `العميل المحتمل يكلفك حوالي ${money(cpl, cur)}.`));
  for (const p of snapshot.platforms as PlatformSnapshot[]) {
    if (p.calibration_ratio === null || p.calibration_ratio < 1.3 || p.platform_roas === null || p.spend <= 0) continue;
    const name = platformName(p.platform);
    body.push(t(`${name} says it returned ${x(p.platform_roas)} its spend, but your CRM only confirms ${x(p.revenue / p.spend)}. Trust the CRM.`, `${name} يقول إنه رجّع ${x(p.platform_roas)} من الصرف، لكن الـ CRM يؤكد ${x(p.revenue / p.spend)} فقط. اعتمد على الـ CRM.`));
  }
  if (snapshot.match.rate !== null && snapshot.match.rate < 0.9) {
    body.push(t(`Only ${pct(snapshot.match.rate)}% of your leads can be tied to an ad, so some of these numbers are understated.`, `${pct(snapshot.match.rate)}% فقط من العملاء المحتملين يمكن ربطهم بإعلان، فبعض الأرقام أقل من الواقع.`));
  }
  const headline =
    revenue > 0
      ? t(`Between ${when} you spent ${money(spend, cur)}, and your CRM confirms ${money(revenue, cur)} in sales.`, `خلال ${when} صرفت ${money(spend, cur)}، والـ CRM يؤكد مبيعات بقيمة ${money(revenue, cur)}.`)
      : t(`Between ${when} you spent ${money(spend, cur)}, and your CRM shows no sales from it yet.`, `خلال ${when} صرفت ${money(spend, cur)}، والـ CRM ما يظهر مبيعات منها للحين.`);
  return { headline, body, next: [NEXT.waste(lang), NEXT.scale(lang), NEXT.plans(lang)] };
}

function findingLine(f: Finding, cur: string, lang: Language): string {
  const t = pick(lang);
  const subject = f.subject ?? {};
  const platform = subject.platform ? platformName(subject.platform) : "";
  const facts = (i: number) => f.evidence[i]?.facts ?? {};
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  switch (f.kind) {
    case "bleeding_adset":
      return t(
        `${subject.adset} on ${platform} spent ${money(num(facts(0).spend), cur)} over ${num(facts(0).active_days)} days and your CRM shows no sale. Suggestion: pause it or cut its budget (I can prepare that for your approval).`,
        `${subject.adset} على ${platform} صرفت ${money(num(facts(0).spend), cur)} خلال ${num(facts(0).active_days)} أيام والـ CRM ما يظهر أي بيعة. اقتراحي: أوقفها أو قلّل ميزانيتها (وأجهّز لك الخطة لتوافق عليها).`,
      );
    case "over_attribution":
      if (subject.adset) {
        return t(
          `${subject.campaign} reports ${num(facts(0).platform_conversions)} results, but your CRM matched only ${num(facts(1).crm_leads)} leads to it.`,
          `${subject.campaign} تسجّل ${num(facts(0).platform_conversions)} نتيجة، لكن الـ CRM ربط ${num(facts(1).crm_leads)} عميل محتمل فقط بها.`,
        );
      }
      return t(
        `${platform} claims ${x(num(facts(1).calibration_ratio))} more results than your CRM can confirm (${money(f.spend_at_risk ?? 0, cur)} of spend rides on that number). Judge it by leads and sales in your CRM, not by its own report.`,
        `${platform} يدّعي نتائج أكثر بـ ${x(num(facts(1).calibration_ratio))} مما يؤكده الـ CRM (${money(f.spend_at_risk ?? 0, cur)} من الصرف مبني على هذا الرقم). احكم عليه بالعملاء والمبيعات في الـ CRM مو بتقريره.`,
      );
    case "mer_vs_roas":
      return t(
        `${platform} reports a return of ${x(num(facts(0).platform_roas))}, but across all channels your sales per ad dollar is ${x(num(facts(1).blended_mer))}. Its value numbers are not real revenue.`,
        `${platform} يعرض عائد ${x(num(facts(0).platform_roas))}، لكن مبيعاتك لكل دولار إعلان على كل القنوات ${x(num(facts(1).blended_mer))}. أرقام القيمة عنده مو إيراد حقيقي.`,
      );
    case "low_match_rate":
      return t(
        `Only ${pct(num(facts(0).match_rate))}% of your leads can be tied to a campaign, so per-campaign numbers undercount. Add tracking tags to your WhatsApp and landing-page links.`,
        `${pct(num(facts(0).match_rate))}% فقط من العملاء المحتملين مربوطين بحملة، فأرقام الحملات أقل من الواقع. أضف وسوم التتبع لروابط الواتساب وصفحات الهبوط.`,
      );
    case "slow_first_response":
      return t(
        `Half of your leads wait more than ${Math.round(num(facts(0).median_first_response_seconds) / 60)} minutes for a first reply, and cold leads fade fast. An instant auto-reply would help.`,
        `نصف العملاء ينتظرون أكثر من ${Math.round(num(facts(0).median_first_response_seconds) / 60)} دقيقة للرد الأول، والعميل البارد يبرد بسرعة. رد تلقائي فوري يساعد.`,
      );
    case "conversation_drop_off":
      return t(
        `${pct(num(facts(0).ghost_rate))}% of leads go quiet once they see the price. Try showing payment options up front and following up after 24 hours.`,
        `${pct(num(facts(0).ghost_rate))}% من العملاء يسكتون بعد ما يشوفون السعر. جرّب تعرض خيارات الدفع من البداية وتتابع بعد 24 ساعة.`,
      );
    case "instruction_like_text":
      return t("Some cells in your files read like instructions to an AI. I ignored them; check who can edit your campaign names and tracking tags.", "بعض الخلايا في ملفاتك تبدو كتعليمات لذكاء اصطناعي. تجاهلتها؛ راجع من يقدر يعدّل أسماء الحملات ووسوم التتبع.");
    case "stale_data":
      return t(`${sourceName(subject.source ?? "", lang)} is ${num(facts(0).age_days)} days old, so numbers that depend on it describe the past.`, `${sourceName(subject.source ?? "", lang)} عمره ${num(facts(0).age_days)} أيام، فالأرقام المعتمدة عليه تصف الماضي.`);
  }
}

export function wasteAnswer(d: Diagnosis, lang: Language, dropzone: string): Answer {
  if (d.status === "no_data" || !d.period) return noDataAnswer(lang, dropzone);
  const t = pick(lang);
  const cur = d.currency;
  const when = periodLabel(d.period.start, d.period.end, lang);
  if (d.findings.length === 0) {
    return { headline: t("Nothing alarming this period.", "ما في شي مقلق في هذي الفترة."), body: [t(`I checked spend, tracking and follow-up for ${when} and found no big problems.`, `فحصت الصرف والتتبع والمتابعة لـ ${when} وما لقيت مشاكل كبيرة.`)], next: [NEXT.performance(lang), NEXT.scale(lang)] };
  }
  const wasted = d.findings.reduce((sum, f) => sum + (f.wasted_spend ?? 0), 0);
  const headline =
    wasted > 0
      ? t(`${money(wasted, cur)} went to ads that bought nothing your CRM can see (${when}).`, `${money(wasted, cur)} راحت على إعلانات ما اشترى منها أحد حسب الـ CRM (${when}).`)
      : t(`I found ${d.findings.length} thing(s) worth your attention (${when}).`, `لقيت ${d.findings.length} أمور تستاهل انتباهك (${when}).`);
  const top = d.top.length > 0 ? d.top.map((id) => d.findings.find((f) => f.id === id)).filter((f): f is Finding => f !== undefined) : [];
  const shown = (top.length > 0 ? top : d.findings).slice(0, 3);
  const body = shown.map((f, i) => `${i + 1}. ${findingLine(f, cur, lang)}`);
  if (d.findings.length > shown.length) body.push(t(`…and ${d.findings.length - shown.length} smaller item(s).`, `…و${d.findings.length - shown.length} أمور أصغر.`));
  return { headline, body, next: [NEXT.scale(lang), NEXT.plans(lang), NEXT.performance(lang)] };
}

export function scaleAnswer(result: SimulationResult, scalePct: number | null, lang: Language, minChance: number, currency: string): Answer {
  const t = pick(lang);
  if (result.status === "insufficient_inputs") {
    return {
      headline: t("I can't judge a budget increase yet: I'm missing a few numbers about your business.", "ما أقدر أحكم على زيادة الميزانية للحين: ينقصني بعض أرقام نشاطك."),
      body: [
        ...result.problems.map((p) => `• ${p.input.replace(/_/g, " ")}`),
        t("Fill these in context/unit-economics.md (your usual rates and average sale, each with a low and high), then ask me again.", "عبّئها في context/unit-economics.md (نسبك المعتادة ومتوسط البيعة، كل واحدة بحد أدنى وأعلى) ثم اسألني من جديد."),
      ],
      next: [NEXT.performance(lang)],
    };
  }
  const mc = result.monte_carlo;
  const chance = pct(mc.p_positive);
  const pass = mc.p50 > 0 && mc.p_positive >= minChance;
  const cur = result.currency || currency;
  const headline =
    scalePct === null
      ? t(`At your current spend there's about a ${chance}% chance you come out ahead.`, `بصرفك الحالي في حدود ${chance}% احتمال تطلع رابح.`)
      : pass
        ? t(`Raising spend by ${scalePct}% looks worth trying: about a ${chance}% chance of coming out ahead.`, `زيادة الصرف ${scalePct}% تستاهل التجربة: في حدود ${chance}% احتمال تطلع رابح.`)
        : t(`Not yet. Raising spend by ${scalePct}% has only about a ${chance}% chance of paying off, and my safety rule needs ${pct(minChance)}%.`, `مو الحين. زيادة الصرف ${scalePct}% احتمال تعويضها في حدود ${chance}% فقط، وقاعدة الأمان عندي تطلب ${pct(minChance)}%.`);
  const body = [
    t(`Most likely result: ${signedMoney(mc.p50, cur)} profit over the period (realistic range ${signedMoney(mc.p10, cur)} to ${signedMoney(mc.p90, cur)}).`, `النتيجة الأرجح: ربح ${signedMoney(mc.p50, cur)} خلال الفترة (المدى الواقعي من ${signedMoney(mc.p10, cur)} إلى ${signedMoney(mc.p90, cur)}).`),
    t(`You break even at ${money(result.break_even.cost_per_deal, cur)} per sale.`, `تتعادل عند ${money(result.break_even.cost_per_deal, cur)} للبيعة الواحدة.`),
    t("This is a model built from the ranges in your unit-economics file, not a forecast. A budget increase is only approved after a check like this passes.", "هذا نموذج مبني على المدى في ملف unit-economics، وليس توقعاً. زيادة الميزانية ما تُعتمد إلا بعد نجاح فحص مثل هذا."),
  ];
  return { headline, body, next: pass ? [NEXT.plans(lang), NEXT.performance(lang)] : [NEXT.waste(lang), NEXT.data(lang)] };
}

const PLAN_STATE: Record<string, [string, string]> = {
  proposed: ["waiting for your approval", "تنتظر موافقتك"],
  held: ["on hold", "معلّقة"],
  approved: ["approved, not applied yet", "معتمدة ولم تُطبّق بعد"],
  executing: ["being applied", "قيد التطبيق"],
  executed: ["applied", "طُبّقت"],
  exported: ["applied (files exported)", "طُبّقت (تم تصدير الملفات)"],
  partial: ["partly applied", "طُبّقت جزئياً"],
  failed: ["failed", "فشلت"],
  verified: ["applied and checked", "طُبّقت وتم التحقق"],
  rejected: ["rejected", "مرفوضة"],
  expired: ["expired", "منتهية الصلاحية"],
  rolled_back: ["rolled back", "تم التراجع عنها"],
};

export function plansAnswer(d: Dashboard, lang: Language, now: Date = new Date()): Answer {
  const t = pick(lang);
  const waiting = d.plans.filter((p) => p.state === "proposed" || p.state === "held");
  if (d.plans.length === 0) return { headline: t("Nothing is waiting for you.", "ما في شي ينتظرك."), body: [t("No plans yet. When I find something worth changing, I'll prepare a plan for you to review.", "ما في خطط للحين. لما ألقى شي يستاهل التغيير أجهّز لك خطة تراجعها.")], next: [NEXT.waste(lang), NEXT.performance(lang)] };
  const body = d.plans.slice(-5).map((p) => {
    const expired = p.state === "proposed" && Date.parse(p.expires_at) < now.getTime();
    const [en, ar] = PLAN_STATE[expired ? "expired" : p.state] ?? [p.state, p.state];
    return `#${p.number}: ${t(en, ar)}`;
  });
  if (waiting.length > 0) {
    const n = waiting[0]!.number;
    body.push(t(`To review a plan in a terminal: mdj diff ${n}. To approve it: mdj approve ${n}, then mdj strike ${n}. I can't do that part for you, on purpose.`, `لمراجعة خطة في الطرفية: mdj diff ${n}. وللموافقة: mdj approve ${n} ثم mdj strike ${n}. هذا الجزء ما أسويه عنك، وبقصد.`));
  }
  const headline = waiting.length > 0 ? t(`${waiting.length} plan(s) waiting for your decision.`, `${waiting.length} خطط تنتظر قرارك.`) : t("Nothing needs your decision right now.", "ما في شي يحتاج قرارك الحين.");
  return { headline, body, next: [NEXT.performance(lang), NEXT.waste(lang)] };
}

export function dataAnswer(d: Dashboard, lang: Language, dropzone: string): Answer {
  const t = pick(lang);
  if (d.data.status !== "ok" || !d.data.period) {
    return { headline: t("I haven't read any ad data yet.", "ما قريت أي بيانات إعلانات للحين."), body: [t(`Export your reports into ${dropzone}, then ask "How are my ads doing?" and I'll read them.`, `صدّر تقاريرك إلى ${dropzone} ثم اسأل "كيف حال الإعلانات؟" وأقراها.`)], next: [NEXT.performance(lang)] };
  }
  const old = d.data.sources.filter((s) => s.stale || s.errors > 0);
  const headline = old.length === 0 ? t(`Your data is up to date (${periodLabel(d.data.period.start, d.data.period.end, lang)}).`, `بياناتك محدثة (${periodLabel(d.data.period.start, d.data.period.end, lang)}).`) : t(`${old.length} of your files need attention.`, `${old.length} من ملفاتك تحتاج انتباه.`);
  const body = d.data.sources.map((s) => {
    const age = s.ageDays === null ? "" : s.ageDays === 0 ? t("today", "اليوم") : t(`${s.ageDays} day(s) old`, `عمره ${s.ageDays} يوم`);
    const problem = s.errors > 0 ? t(`, ${s.errors} problem(s) reading it`, `، ${s.errors} مشاكل في قراءته`) : "";
    return `${s.stale || s.errors > 0 ? "✗" : "✓"} ${sourceName(s.id, lang)}${age ? `: ${age}` : ""}${problem}`;
  });
  return { headline, body, next: [NEXT.performance(lang), NEXT.waste(lang)] };
}

export function trustAnswer(ledgerOutput: string, lang: Language): Answer {
  const t = pick(lang);
  const ok = /:\s*OK,\s*(\d+) entr/i.exec(ledgerOutput);
  if (ok) {
    return { headline: t(`Your activity log is intact: ${ok[1]} entries, none altered.`, `سجل النشاط سليم: ${ok[1]} إدخال، ولا شي تغيّر.`), body: [t("Every action I take is written to a tamper-evident log, so you can always check what happened and when.", "كل إجراء أسويه يُسجَّل في سجل يكشف أي تلاعب، فتقدر تراجع دايماً ايش صار ومتى.")], next: [NEXT.plans(lang), NEXT.performance(lang)] };
  }
  const first = ledgerOutput.trim().split("\n")[0] ?? "";
  return { headline: t("The activity log did not verify. Treat recent changes with suspicion.", "سجل النشاط ما اجتاز التحقق. تعامل مع التغييرات الأخيرة بحذر."), body: [first], next: [NEXT.data(lang)] };
}

export function approveAnswer(plan: number | undefined, lang: Language): Answer {
  const t = pick(lang);
  const n = plan ?? "<number>";
  return {
    headline: t("I can't approve or apply changes from here, on purpose.", "ما أقدر أوافق أو أطبّق تغييرات من هنا، وهذا بقصد."),
    body: [
      t("Approvals stay in a terminal where you type them yourself, so nothing (not me, not a mistaken click) can change your ad spend.", "الموافقات تبقى في الطرفية وتكتبها بنفسك، فما في شي (لا أنا ولا ضغطة بالغلط) يقدر يغيّر صرفك الإعلاني."),
      `1) mdj diff ${n}`,
      `2) mdj approve ${n}`,
      `3) mdj strike ${n}`,
    ],
    next: [NEXT.plans(lang)],
  };
}

export function helpAnswer(lang: Language, greeting: boolean): Answer {
  const t = pick(lang);
  return {
    headline: greeting ? t("Hi! I'm Medjay. Ask me in your own words.", "أهلاً! أنا Medjay. اسألني بكلامك العادي.") : t("Ask me in your own words, for example:", "اسألني بكلامك العادي، مثلاً:"),
    body: [t("I can tell you how your ads are doing, what's wasting money, whether it's safe to spend more, what needs your approval, and whether your data is current.", "أقدر أخبرك كيف حال إعلاناتك، وين تضيع الفلوس، وهل من الآمن تزيد الصرف، وايش ينتظر موافقتك، وهل بياناتك محدثة.")],
    next: [NEXT.performance(lang), NEXT.waste(lang), NEXT.scale(lang), NEXT.plans(lang), NEXT.data(lang), NEXT.trust(lang)],
  };
}

export const languageAnswer = (lang: Language): Answer => ({ headline: pick(lang)("Okay, I'll answer in English.", "حسناً، سأجيبك بالعربية."), body: [], next: [NEXT.performance(lang), NEXT.waste(lang)] });

/** "How are my ads doing?" when all there is are the platform's period reports (no CRM check yet). */
export function summaryPerformanceAnswer(s: PeriodSummary, lang: Language): Answer {
  const L = pick(lang);
  const cur = s.currency;
  const platform = s.platform.charAt(0).toUpperCase() + s.platform.slice(1);
  const when = periodLabel(s.period.start, s.period.end, lang);
  const each = s.totals.cost_per_conversion === null ? "" : L(`, about ${money(s.totals.cost_per_conversion, cur)} each`, `، بمتوسط ${money(s.totals.cost_per_conversion, cur)} للواحد`);
  const headline = L(`Between ${when} you spent ${money(s.totals.spend, cur)} and ${platform} reports ${Math.round(s.totals.conversions)} conversions${each}.`, `بين ${when} صرفت ${money(s.totals.spend, cur)} و${platform} يسجل ${Math.round(s.totals.conversions)} تحويل${each}.`);
  const body: string[] = [];
  const top = s.campaigns[0];
  if (top) body.push(L(`${top.name} took ${Math.round(top.share_of_spend * 100)}% of the budget${top.cost_per_conversion === null ? "." : ` at ${money(top.cost_per_conversion, cur)} per conversion.`}`, `${top.name} أخذت ${Math.round(top.share_of_spend * 100)}% من الميزانية${top.cost_per_conversion === null ? "." : ` بتكلفة ${money(top.cost_per_conversion, cur)} للتحويل.`}`));
  const priced = s.campaigns.filter((c) => c.cost_per_conversion !== null).sort((a, b) => (a.cost_per_conversion as number) - (b.cost_per_conversion as number));
  if (priced.length >= 2) {
    const cheapest = priced[0]!;
    const dearest = priced[priced.length - 1]!;
    body.push(L(`${cheapest.name} is your cheapest at ${money(cheapest.cost_per_conversion as number, cur)} per conversion. ${dearest.name} is the dearest at ${money(dearest.cost_per_conversion as number, cur)}.`, `${cheapest.name} الأرخص بتكلفة ${money(cheapest.cost_per_conversion as number, cur)} للتحويل. ${dearest.name} الأغلى بتكلفة ${money(dearest.cost_per_conversion as number, cur)}.`));
  }
  if (s.zero_conversion_total.terms > 0) {
    body.push(L(`${s.zero_conversion_total.terms} search terms spent ${money(s.zero_conversion_total.spend, cur)} and never converted.`, `${s.zero_conversion_total.terms} كلمة بحث صرفت ${money(s.zero_conversion_total.spend, cur)} وما جابت أي تحويل.`));
  }
  body.push(L(`These are ${platform}'s own numbers; I haven't checked them against your CRM yet, so treat them as the platform's claim.`, `هذي أرقام ${platform} نفسه؛ ما قارنتها مع الـ CRM للحين، فاعتبرها كلام المنصة.`));
  return { headline, body, next: [NEXT.waste(lang), NEXT.data(lang)] };
}

/** "What's wasting money?" from the platform's period reports: search terms that never converted. */
export function summaryWasteAnswer(s: PeriodSummary, lang: Language): Answer {
  const L = pick(lang);
  const cur = s.currency;
  const z = s.zero_conversion_total;
  if (z.terms === 0) return { headline: L("No search terms spent money without converting.", "ما في كلمات بحث صرفت فلوس بدون تحويل."), body: s.notes, next: [NEXT.performance(lang), NEXT.data(lang)] };
  const biggest = s.zero_conversion_terms.slice(0, 3).map((t) => `• ${t.term}: ${money(t.spend, cur)} (${t.clicks} ${L("clicks", "نقرة")})`);
  return {
    headline: L(`${money(z.spend, cur)} went to ${z.terms} search terms that never turned into a conversion.`, `${money(z.spend, cur)} راحت لـ ${z.terms} كلمة بحث ما جابت أي تحويل.`),
    body: [L("Biggest:", "الأكبر:"), ...biggest, L("Add them as negative keywords (I can prepare that for your approval).", "أضفها ككلمات سلبية (أقدر أجهّز ذلك لموافقتك)."), ...s.notes],
    next: [NEXT.performance(lang), NEXT.data(lang)],
  };
}

export const noModelAnswer = (lang: Language): Answer => ({
  headline: pick(lang)("I'm not connected to an AI model yet, so I can only answer the questions I know.", "ما أنا متصل بنموذج ذكاء اصطناعي للحين، فأقدر أجاوب على الأسئلة اللي أعرفها فقط."),
  body: [pick(lang)("To ask me anything else, connect an AI model with your own key: type /connect anthropic, /connect openai or /connect google.", "عشان تسألني أي شي ثاني اربط نموذج ذكاء اصطناعي بمفتاحك: اكتب /connect anthropic أو /connect openai أو /connect google.")],
  next: helpAnswer(lang, false).next.slice(0, 4),
});

/** Say what is actually wrong with the model connection, and the one thing to do about it. */
export function modelErrorAnswer(f: ModelFailure, lang: Language): Answer {
  const p = f.provider ?? "anthropic";
  const L = pick(lang);
  const next = helpAnswer(lang, false).next.slice(0, 4);
  const connect = L(`Type /connect ${p} to paste a fresh key (it is hidden and stored in your system keychain).`, `اكتب /connect ${p} وألصق مفتاحاً جديداً (يبقى مخفياً ويُحفظ في مفاتيح النظام).`);
  switch (f.kind) {
    case "no_key":
      return { headline: L(`I don't have a key for ${p} yet.`, `ما عندي مفتاح لـ ${p} للحين.`), body: [connect], next };
    case "key_rejected":
      return { headline: L(`${p} rejected the saved key.`, `${p} رفض المفتاح المحفوظ.`), body: [L("It may be expired, revoked, or copied wrong.", "ممكن انتهت صلاحيته أو انلغى أو انسخ غلط."), connect], next };
    case "key_malformed":
      return { headline: L("The saved key has stray characters from pasting, so it can't be sent.", "المفتاح المحفوظ فيه رموز زيادة من اللصق، فما ينفع يُرسل."), body: [connect], next };
    case "quota":
      return { headline: L(`${p} says your spending limit is reached.`, `${p} يقول إنك وصلت حد الصرف.`), body: [f.detail, L("Raise the limit on your provider's billing page, or connect another provider with /connect.", "ارفع الحد من صفحة الفوترة عند المزود، أو اربط مزوداً ثانياً بـ /connect.")], next };
    case "model_not_found":
      return { headline: L("That model name isn't available on your account.", "اسم النموذج هذا مو متاح في حسابك."), body: [L("Pick another model in workspace.yaml (the models: slots section).", "اختر نموذجاً ثانياً في workspace.yaml (قسم models: slots).")], next };
    case "network":
      return { headline: L(`I couldn't reach ${p}.`, `ما قدرت أوصل لـ ${p}.`), body: [L("Check your internet connection and try again.", "تأكد من الإنترنت وجرّب مرة ثانية.")], next };
    default:
      return { headline: L("The AI model call failed.", "فشل الاتصال بنموذج الذكاء."), body: [f.detail], next };
  }
}

export const errorAnswer = (lang: Language, detail: string): Answer => ({
  headline: pick(lang)("I couldn't finish that.", "ما قدرت أكمل هذا."),
  body: detail.trim() === "" ? [] : [detail.trim().split("\n").slice(0, 4).join("\n")],
  next: [NEXT.data(lang)],
});

/** Plain text for the feed: first line is the headline, the last block is the numbered next steps. */
export function renderAnswer(a: Answer, lang: Language): string {
  const lines = [`# ${a.headline}`, ...a.body.map((l) => (l.startsWith("•") || /^\d\)/.test(l) ? `  ${l}` : l))];
  if (a.next.length > 0) {
    lines.push("", `> ${pick(lang)("What next? Type a number:", "وبعدين؟ اكتب رقم:")}`);
    a.next.forEach((s, i) => lines.push(`>   ${i + 1}. ${s.label}`));
  }
  return lines.join("\n");
}
