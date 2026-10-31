// The words of the first minutes: how to get an AI model key, and the request that hands the setup to the
// model once there is one. The model, not a fixed script, then decides what is missing and tells the owner
// what to do next (see GUIDE_RULES in the system prompt). Commands and links stay ASCII in both languages.
// The key-page links are correct as far as we know and may move; the text says so.
import type { Language } from "./intent.js";

const pick = (lang: Language) => (en: string, ar: string) => (lang === "ar" ? ar : en);

/** True when `mdj auth status` shows a key for any provider (a keychain entry or an environment variable). */
export function hasModelKey(authStatus: string): boolean {
  return authStatus.split("\n").some((line) => {
    const m = /^(anthropic|openai|google|openai_compatible)\s+(\S.*)$/.exec(line.trim());
    return m !== null && !/^not set/i.test(m[2] ?? "");
  });
}

export function connectGuide(lang: Language): string {
  return pick(lang)(
    [
      "# One thing first: I need an AI model key to think with you",
      "It takes about two minutes:",
      "1. Pick one provider (Google's has a free tier and is the easiest start):",
      "     Google (Gemini)     https://aistudio.google.com/apikey            then Create API key, copy it",
      "     OpenAI              https://platform.openai.com/api-keys          then Create new secret key, copy it",
      "     Anthropic (Claude)  https://console.anthropic.com/settings/keys   then Create key, copy it",
      "   (Links are as of today and may move; search the provider's name plus \"API key\" if one does not open.)",
      "2. Come back here and type:  /connect google   (or /connect openai, /connect anthropic)",
      "   Paste the key and press Enter. It is hidden, and stored in your system keychain, never in a file.",
      "3. Then I take over: I look at your workspace and guide you step by step.",
    ].join("\n"),
    [
      "# أول شي: أحتاج مفتاح نموذج ذكاء اصطناعي عشان أفكر معك",
      "ياخذ دقيقتين تقريباً:",
      "1. اختر مزوداً واحداً (مزود Google عنده باقة مجانية وأسهل بداية):",
      "     Google (Gemini)     https://aistudio.google.com/apikey",
      "     OpenAI              https://platform.openai.com/api-keys",
      "     Anthropic (Claude)  https://console.anthropic.com/settings/keys",
      "   (الروابط حسب علمنا اليوم وقد تتغير؛ ابحث باسم المزود + API key لو ما فتح رابط.)",
      "2. ارجع هنا واكتب:  /connect google   (أو /connect openai أو /connect anthropic)",
      "   الصق المفتاح واضغط Enter. يبقى مخفياً ومحفوظاً في سلسلة مفاتيح نظامك، وليس في ملف.",
      "3. بعدها أستلم أنا: أراجع مساحة عملك وأرشدك خطوة خطوة.",
    ].join("\n"),
  );
}

export function readyText(dir: string, lang: Language): string {
  return pick(lang)(`# Your workspace is ready\n  ${dir}`, `# مساحة عملك جاهزة\n  ${dir}`);
}

/** The request that hands the setup to the model. It is sent as the owner's own message. */
export function kickoffPrompt(lang: Language): string {
  return pick(lang)(
    "I just created my workspace and I am new to this. Take over my setup. Call workspace_readiness first, then guide me one step at a time in plain words: where to go (which platform, which menu), what to look at or choose (which report, which date range, which columns), and what to save and where (the exact folder or file path, from the readiness result). Ask me for the business facts you need, two or three at a time, and save my answers as we go. Start with the single most useful first step and tell me when to come back to you.",
    "أنا لسا منشئ مساحة عملي وجديد على هذا. استلم أنت إعدادي. استدعِ workspace_readiness أولاً، ثم أرشدني خطوة خطوة بكلام بسيط: وين أروح (أي منصة وأي قائمة)، وايش أشوف أو أختار (أي تقرير وأي فترة وأي أعمدة)، وايش أحفظ وين (المجلد أو الملف بالضبط من نتيجة readiness). اسألني عن معلومات النشاط اللي تحتاجها، سؤالين أو ثلاثة كل مرة، واحفظ إجاباتي أولاً بأول. ابدأ بأنفع خطوة أولى واحدة وقل لي متى أرجع لك.",
  );
}
