// First run with no workspace: a short conversation instead of `mdj init` flags. It only collects
// answers and hands back the exact init command line; the app runs that command like any other.
import { join } from "node:path";
import { isIsoCurrency } from "../constants.js";
import { BUSINESS_TYPES, type BusinessType } from "../pillars/catalog.js";
import { detectLanguage, normalizeArabic, type Language } from "./intent.js";

export type OnboardStep = "name" | "business" | "currency" | "confirm" | "creating";

export interface OnboardState {
  step: OnboardStep;
  lang: Language;
  name?: string;
  business?: BusinessType;
  currency?: string;
}

export interface CreateRequest {
  dir: string;
  argv: string[];
  name: string;
}

export interface OnboardResult {
  state: OnboardState;
  say: string;
  create?: CreateRequest;
}

const pick = (lang: Language) => (en: string, ar: string) => (lang === "ar" ? ar : en);

const TIMEZONES: Record<string, string> = { SAR: "Asia/Riyadh", AED: "Asia/Dubai", EGP: "Africa/Cairo", KWD: "Asia/Kuwait", QAR: "Asia/Qatar", BHD: "Asia/Bahrain", OMR: "Asia/Muscat", JOD: "Asia/Amman" };
const QUICK_CURRENCIES = ["SAR", "AED", "EGP", "USD"];

export function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return slug === "" ? "workspace" : slug;
}

const askName = (lang: Language) => pick(lang)("Welcome! Let's set up your workspace. What's your business or brand called?", "أهلاً! خلّنا نجهّز مساحة عملك. ايش اسم نشاطك أو علامتك التجارية؟");
const askBusiness = (lang: Language) =>
  pick(lang)(
    "What best describes you?\n  1) Online store\n  2) B2B software\n  3) High-ticket or consultative sales (travel packages, property, clinics)\n  4) Marketing agency\n  5) Local business getting leads from ads",
    "ايش يوصف نشاطك أفضل؟\n  1) متجر إلكتروني\n  2) برمجيات لقطاع الأعمال (B2B)\n  3) مبيعات عالية القيمة أو استشارية (باقات سفر، عقارات، عيادات)\n  4) وكالة تسويق\n  5) نشاط محلي يجلب عملاء من الإعلانات",
  );
const askCurrency = (lang: Language) =>
  pick(lang)(`Which currency do you spend in?\n${QUICK_CURRENCIES.map((c, i) => `  ${i + 1}) ${c}`).join("\n")}\nOr type another code, like KWD.`, `بأي عملة تصرف على الإعلانات؟\n${QUICK_CURRENCIES.map((c, i) => `  ${i + 1}) ${c}`).join("\n")}\nأو اكتب رمزاً آخر مثل KWD.`);

export function startOnboarding(lang: Language): { state: OnboardState; say: string } {
  return { state: { step: "name", lang }, say: askName(lang) };
}

const YES = /^(y|yes|yeah|yep|ok|okay|sure|نعم|ايوه|ايوا|اه|تمام|اكيد|ايه)$/;
const NO = /^(n|no|nope|لا|لأ|لاه|كلا)$/;

export function stepOnboarding(state: OnboardState, raw: string, baseDir: string): OnboardResult {
  const input = raw.trim();
  const lang: Language = detectLanguage(input) === "ar" ? "ar" : state.lang;
  const t = pick(lang);
  const next = (patch: Partial<OnboardState>, say: string): OnboardResult => ({ state: { ...state, lang, ...patch }, say });

  switch (state.step) {
    case "name": {
      const name = input.replace(/^[-/\\.\s]+/, "").replace(/\s+/g, " ").slice(0, 120);
      if (name === "") return next({}, t("What would you like to call it? A name is enough, you can change it later.", "ايش تحب تسميه؟ يكفي اسم، وتقدر تغيّره بعدين."));
      return next({ step: "business", name }, askBusiness(lang));
    }
    case "business": {
      const n = Number(normalizeArabic(input).replace(/[)\s.]/g, ""));
      const business = BUSINESS_TYPES[n - 1];
      if (!Number.isInteger(n) || business === undefined) return next({}, `${t("Please answer with a number from 1 to 5.", "اختر رقماً من 1 إلى 5.")}\n${askBusiness(lang)}`);
      return next({ step: "currency", business }, askCurrency(lang));
    }
    case "currency": {
      const typed = input.toUpperCase().replace(/[)\s.]/g, "");
      const code = /^[1-4]$/.test(typed) ? QUICK_CURRENCIES[Number(typed) - 1] : typed;
      if (code === undefined || !isIsoCurrency(code)) return next({}, `${t("I didn't recognise that currency.", "ما عرفت هذي العملة.")}\n${askCurrency(lang)}`);
      const dir = join(baseDir, slugify(state.name ?? ""));
      return next({ step: "confirm", currency: code }, t(`Create "${state.name}" (${code}) in the folder ${dir}? (yes / no)`, `أنشئ "${state.name}" (${code}) في المجلد ${dir}؟ (نعم / لا)`));
    }
    case "confirm": {
      const answer = normalizeArabic(input.toLowerCase());
      if (NO.test(answer)) return { state: { step: "name", lang }, say: askName(lang) };
      if (!YES.test(answer)) return next({}, t("Please answer yes or no.", "جاوب بنعم أو لا."));
      const slug = slugify(state.name ?? "");
      const dir = join(baseDir, slug);
      const create: CreateRequest = {
        dir,
        name: state.name ?? slug,
        argv: ["init", dir, "--id", slug, "--name", state.name ?? slug, "--business-type", state.business ?? "ecom", "--currency", state.currency ?? "USD", "--timezone", TIMEZONES[state.currency ?? ""] ?? "UTC", "--language", lang],
      };
      return { state: { ...state, lang, step: "creating" }, say: t("Setting up your workspace…", "أجهّز مساحة عملك…"), create };
    }
    case "creating":
      return { state, say: t("One moment, I'm still setting things up.", "لحظة، للحين أجهّز الأمور.") };
  }
}

export const onboardingDone = (dir: string, lang: Language): string =>
  pick(lang)(
    `Your workspace is ready.\nNext: export your reports (Meta, Google, website analytics, CRM) into\n  ${join(dir, "data", "imports")}\nthen ask me "How are my ads doing?"
To have me answer in my own words, type /connect and paste your AI model key (it is hidden and stays in your system keychain).`,
    `مساحة عملك جاهزة.\nالخطوة الجاية: صدّر تقاريرك (Meta وGoogle وتحليلات الموقع والـ CRM) إلى\n  ${join(dir, "data", "imports")}\nثم اسألني "كيف حال الإعلانات؟"\nعشان أجاوبك بكلامي، اكتب /connect والصق مفتاح نموذج الذكاء الاصطناعي (يبقى مخفياً ومحفوظاً في سلسلة مفاتيح نظامك).`,
  );
