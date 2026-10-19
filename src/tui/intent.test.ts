import { describe, expect, it } from "vitest";
import { detectLanguage, normalizeArabic, routeIntent, toLatinDigits } from "./intent.js";

const intent = (text: string) => routeIntent(text)?.intent ?? null;

describe("detectLanguage", () => {
  it("is Arabic when Arabic letters make up a real share of the letters", () => {
    expect(detectLanguage("كيف حال الإعلانات هذا الأسبوع؟")).toBe("ar");
    expect(detectLanguage("ايش اللي ضايع في Meta؟")).toBe("ar");
  });
  it("is English for English and for a lone brand name inside Arabic-free text", () => {
    expect(detectLanguage("how are my ads doing?")).toBe("en");
    expect(detectLanguage("Meta vs Google")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });
});

describe("normalizers", () => {
  it("folds Arabic spelling variants and strips diacritics", () => {
    expect(normalizeArabic("أَداءُ الإعلانات؟")).toBe("اداء الاعلانات؟");
    expect(normalizeArabic("مدرسة ى")).toBe("مدرسه ي");
  });
  it("turns Arabic-Indic digits into Latin ones", () => {
    expect(toLatinDigits("زود ٢٠٪ و۳۰")).toBe("زود 20٪ و30");
  });
});

describe("routeIntent in English", () => {
  const cases: [string, string][] = [
    ["how are my ads doing?", "performance"],
    ["give me a summary of this week", "performance"],
    ["how much did I spend", "performance"],
    ["what's wasting money?", "waste"],
    ["which campaign is bleeding", "waste"],
    ["what should I pause", "waste"],
    ["why is my cost per lead up", "waste"],
    ["can I safely raise the budget?", "scale"],
    ["should I scale up Riyadh Family by 30%", "scale"],
    ["can we spend more", "scale"],
    ["what plans are waiting for me", "plans"],
    ["anything to approve?", "plans"],
    ["is my data up to date?", "data"],
    ["did you read my files", "data"],
    ["has anything been tampered with", "trust"],
    ["what did you change", "trust"],
    ["approve plan 1", "approve"],
    ["go ahead and apply it", "approve"],
    ["help", "help"],
    ["what can you do", "help"],
    ["hi", "greet"],
    ["hello there", "greet"],
    ["arabic", "language"],
  ];
  it.each(cases)("%s -> %s", (text, expected) => expect(intent(text)).toBe(expected));

  it("returns null for an open question the router should not guess at", () => {
    expect(intent("write me three headline ideas for umrah packages")).toBeNull();
    expect(intent("")).toBeNull();
  });
});

describe("routeIntent in Arabic (MSA, Gulf and Egyptian phrasing)", () => {
  const cases: [string, string][] = [
    ["كيف حال الإعلانات؟", "performance"],
    ["إعلاناتي عامل إيه الأسبوع ده؟", "performance"],
    ["الحملة ماشية ازاي", "performance"],
    ["إيه اللي بيضيع الفلوس؟", "waste"],
    ["ليه الاعلانات مش شغالة", "waste"],
    ["ايه نتايج الحملة النهاردة", "performance"],
    ["كم صرفت هذا الأسبوع", "performance"],
    ["كام صرفت الأسبوع ده", "performance"],
    ["وين تضيع فلوسي", "waste"],
    ["ايش اللي ما يشتغل", "waste"],
    ["ايه اللي مش شغال", "waste"],
    ["ليه التكلفة عالية", "waste"],
    ["هل أقدر أزود الميزانية؟", "scale"],
    ["ابي ازود الميزانية 20%", "scale"],
    ["عايز اضاعف الصرف", "scale"],
    ["ايش الخطط اللي تنتظر موافقتي", "plans"],
    ["في خطط معلقة؟", "plans"],
    ["هل البيانات محدثة؟", "data"],
    ["قريت الملفات؟", "data"],
    ["هل في تلاعب بالسجل", "trust"],
    ["وافق على الخطة 1", "approve"],
    ["ساعدني", "help"],
    ["مرحبا", "greet"],
    ["اهلا", "greet"],
    ["english", "language"],
    ["بالانجليزي", "language"],
  ];
  it.each(cases)("%s -> %s", (text, expected) => expect(intent(text)).toBe(expected));
});

describe("parameters", () => {
  it("reads a scale percentage in either language and either digit set", () => {
    expect(routeIntent("raise the budget by 25%")).toMatchObject({ intent: "scale", params: { pct: 25 } });
    expect(routeIntent("can I scale 30 percent")).toMatchObject({ params: { pct: 30 } });
    expect(routeIntent("ابي ازود ٢٠٪")).toMatchObject({ intent: "scale", params: { pct: 20 } });
    expect(routeIntent("زود الميزانية 50 في المية")).toMatchObject({ params: { pct: 50 } });
    expect(routeIntent("can I double the budget")).toMatchObject({ params: { pct: 100 } });
  });
  it("ignores an absurd percentage rather than passing it on", () => {
    expect(routeIntent("scale by 5000%")?.params.pct).toBeUndefined();
  });
  it("reads a plan number and the language to switch to", () => {
    expect(routeIntent("approve plan 3")).toMatchObject({ intent: "approve", params: { plan: 3 } });
    expect(routeIntent("وافق على الخطة ٢")).toMatchObject({ params: { plan: 2 } });
    expect(routeIntent("arabic")).toMatchObject({ params: { language: "ar" } });
    expect(routeIntent("english")).toMatchObject({ params: { language: "en" } });
  });
});
