// Understanding what a marketer typed, in English or Arabic, without a model. This is deliberately a
// small, auditable router: a handful of questions that cover the day-to-day (how are my ads doing,
// what is wasting money, can I scale, what is waiting, is my data fresh), matched by plain patterns.
// Anything it does not recognize returns null and goes to the agent instead; it never guesses.

export type Language = "en" | "ar";
export type IntentName = "performance" | "waste" | "scale" | "plans" | "data" | "trust" | "approve" | "help" | "greet" | "language";

export interface Routed {
  intent: IntentName;
  params: { pct?: number; plan?: number; language?: Language };
}

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

export function detectLanguage(text: string): Language {
  const arabic = text.match(ARABIC)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  return arabic > 0 && arabic >= latin ? "ar" : "en";
}

/** Fold the spellings people use interchangeably (hamza forms, ya/alef maqsura, ta marbuta) and drop diacritics. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

export function toLatinDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const clean = (text: string): string => toLatinDigits(normalizeArabic(text)).toLowerCase().replace(/\s+/g, " ").trim();

interface Rule {
  intent: IntentName;
  patterns: RegExp[];
}

// Order matters: the first rule with a match wins, so the narrow ones (approve, language) come first.
const RULES: Rule[] = [
  { intent: "language", patterns: [/^(in )?(arabic|english)[.!؟?]*$/, /^(بال)?(عربي|عربيه|انجليزي|انجليزيه|انجلش)[.!؟?]*$/] },
  { intent: "approve", patterns: [/^(please )?(approve|strike|apply|execute|confirm)\b/, /go ahead|yes,? do it|do it now/, /^(وافق|اعتمد|نفذ|طبق|كمل)(\s|$)/, /ستراك/] },
  { intent: "scale", patterns: [/\bscal(e|ing)\b/, /(raise|increase|boost|grow|up)\b.{0,20}budget/, /more budget|spend more|invest more|\bdouble\b|\btwice\b|\bramp up/, /زود|ارفع|رفع الميزانيه|زياده (الميزانيه|الصرف)|ضاعف|اضاعف|وسع|توسع|سكيل/] },
  { intent: "plans", patterns: [/\bplans?\b|proposals?|\bwaiting\b|\bpending\b|awaiting|to approve|needs? my (ok|ok|approval|ap)/, /خطط|خطه|ينتظر|منتظر|معلق|مقترح|اقتراحات|موافقتي/] },
  { intent: "trust", patterns: [/tamper|ledger|audit|integrity|what did you (change|do)|history of changes|changes? (made|you made)/, /سجل|تدقيق|تلاعب|عبث|ايش غيرت|غيرت ايه|تغييرات/] },
  { intent: "data", patterns: [/up to date|fresh|stale|last updated|data (ok|status|quality|source)|\bfiles?\b|\bimports?\b|\bexports?\b|connected|did you (read|get|see|load)/, /بيانات|ملفات|ملف|محدث|قديم|اخر تحديث|قريت|قرات|استيراد|وصلت/] },
  { intent: "waste", patterns: [/wast|bleed|burn(ing)?\b|losing money|not working|underperform|worst|\bpause\b|\bstop\b|\bcut\b|problem|issue|anomal|what.?s wrong|why .*(up|down|high|expensive|drop|spik)/, /هدر|تضيع|ضايع|ضائع|ضياع|بيضيع|خسار|خساير|ما يشتغل|ما تشتغل|مش شغال|مو شغال|اسوا|اوقف|وقف|مشكل|غلط|استنزاف|تكلفه (عاليه|مرتفعه|زادت)|(ليه|ليش|لماذا).*(تكلف|غالي|ارتفع|زاد)/] },
  { intent: "performance", patterns: [/how (are|is|am)\b|\bdoing\b|performing|performance|results|summary|overview|report|snapshot|how much .*(spend|spent|made|earn)|\bspend\b|\bspent\b|\broas\b|revenue|\bsales\b/, /(كيف|ازاي|شلون|وش|ايش) (حال|حاله|اداء|الاعلانات|الحمله|حملاتي)|اداء|نتايج|نتائج|تقرير|ملخص|كم صرفت|كام صرفت|صرفت|مبيعات|ايراد|لمحه|عامل(ه)? ايه|ماشي(ه)? ازاي|(اعلاناتي|حملاتي|حملتي|الاعلانات|الحمله).*(عامل|ماشي|شغال)/] },
  { intent: "help", patterns: [/^(help|menu|options|commands)\b|what can you do|how (do|can) i (use|start)|get started/, /^(مساعده|ساعدني|المساعده|قائمه|اوامر|ابدا)|تقدر تعمل|ايش تقدر|كيف استخدم/] },
  { intent: "greet", patterns: [/^(hi|hello|hey|salam|salaam|good (morning|evening|afternoon))\b/, /^(مرحبا|اهلا|السلام|هلا|هاي|صباح|مساء|اهلين)/] },
];

const PERCENT = /(\d{1,4})(?:\.\d+)?\s*(?:%|٪|percent|pct|في الميه|في المئه|بالميه|بالمئه|في المية|بالمية)/;

function params(text: string, intent: IntentName): Routed["params"] {
  const out: Routed["params"] = {};
  if (intent === "scale") {
    const m = PERCENT.exec(text);
    const pct = m ? Number(m[1]) : /\bdouble\b|\btwice\b|ضاعف|اضاعف|ضعف/.test(text) ? 100 : undefined;
    if (pct !== undefined && pct >= 1 && pct <= 500) out.pct = pct;
  }
  if (intent === "approve" || intent === "plans") {
    const m = /(?:plan|خطه|#)\s*#?\s*(\d{1,6})/.exec(text);
    if (m) out.plan = Number(m[1]);
  }
  if (intent === "language") out.language = /arabic|عرب/.test(text) ? "ar" : "en";
  return out;
}

const MAX_QUICK_WORDS = 12;

export function routeIntent(raw: string): Routed | null {
  const text = clean(raw);
  if (text === "") return null;
  // A long, detailed question is about something specific that a canned answer cannot cover; only a
  // request to approve/apply stays routed, so it is always refused in chat.
  const detailed = text.split(" ").length > MAX_QUICK_WORDS;
  for (const rule of RULES) {
    if (detailed && rule.intent !== "approve") continue;
    if (rule.patterns.some((p) => p.test(text))) return { intent: rule.intent, params: params(text, rule.intent) };
  }
  return null;
}
