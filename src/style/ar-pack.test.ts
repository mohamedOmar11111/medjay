import { describe, expect, it } from "vitest";
import { slopPromptRules } from "./prompt.js";
import { lintText } from "./slop.js";

const lint = (text: string, options: Parameters<typeof lintText>[1] = {}) => lintText(text, options);
const hit = (text: string, rule: string, options: Parameters<typeof lintText>[1] = {}) => lint(text, options).findings.find((f) => f.rule === rule);

describe("Arabic pack: banned openings and transitions (errors)", () => {
  it.each([
    "في عالمنا اليوم أصبح السفر أسهل",
    "في عصرنا الحالي يبحث الناس عن العروض",
    "في ظل التطور المتسارع تغيرت الرحلات",
    "علاوة على ذلك، الحجز سهل",
    "بالإضافة إلى ذلك، نوفر النقل",
    "ومن الجدير بالذكر أن السعر ثابت",
    "من الجدير بالذكر أن السعر ثابت",
    "في الختام، احجز الآن",
    "وفي الختام نشكركم",
  ])("flags %j", (text) => {
    const finding = hit(text, "ar.transition");
    expect(finding, text).toBeDefined();
    expect(finding?.severity).toBe("error");
  });

  it("includes the conjunction prefix in the reported match so the replacement reads right", () => {
    expect(hit("وفي الختام نشكركم", "ar.transition")?.match).toBe("وفي الختام");
  });
});

describe("Arabic pack: banned translated cliches (errors)", () => {
  it.each([
    "أطلق العنان لخيالك",
    "أطلقي العنان لإبداعك",
    "أطلقوا العنان لرحلتكم",
    "نطلق العنان للتجربة",
    "إطلاق العنان للمتعة",
    "ارتقِ بتجربتك",
    "ارتقي بعملك",
    "سواء كنت تبحث عن عطلة عائلية",
    "سواء كنتِ تبحثين عن هدوء",
    "سواء كنتم تبحثون عن مغامرة",
  ])("flags %j", (text) => {
    const finding = hit(text, "ar.cliche");
    expect(finding, text).toBeDefined();
    expect(finding?.severity).toBe("error");
  });

  it("matches through diacritics, tatweel and alef variants", () => {
    expect(hit("أَطْلِقِ الْعِنَانَ", "ar.cliche")).toBeDefined();
    expect(hit("ارتــقِ بـتجربتك", "ar.cliche")).toBeDefined();
  });
});

describe("Arabic pack: travel and marketing inflation (errors, unless allowed)", () => {
  it.each(["رحلة لا تُنسى تنتظرك", "رحلة لا تنسى", "تجربة استثنائية لا مثيل لها"])("flags %j", (text) => {
    const finding = hit(text, "ar.inflation");
    expect(finding, text).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.suggestion).toMatch(/price|dates?|included|offer/i);
  });

  it("can be allowed when the workspace backs it with a concrete offer", () => {
    expect(hit("رحلة لا تُنسى", "ar.inflation", { allow: ["رحلة لا تنسى"] })).toBeUndefined();
  });
});

describe("Arabic pack: starter list that still needs native review (warnings)", () => {
  it.each(["في عالم اليوم", "تجربة فريدة من نوعها", "لا شك أن العرض مميز"])("warns on %j", (text) => {
    const finding = hit(text, "ar.starter");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toMatch(/native/i);
  });
});

describe("Arabic pack: clean copy, switches and positions", () => {
  it("does not flag plain, concrete Arabic copy", () => {
    expect(lint("احجز ٧ ليالٍ في المالديف بسعر ثابت. تشمل الرحلة الإقامة والفطور.").findings).toEqual([]);
  });

  it("can be switched off with the packs setting", () => {
    expect(lint("في عالمنا اليوم رحلة لا تنسى", { packs: ["protocol", "extended"] }).findings).toEqual([]);
  });

  it("reports line, column and exact original text", () => {
    const text = "مرحبا\nرحـلة لا تُنسى";
    const finding = hit(text, "ar.inflation")!;
    expect(finding.line).toBe(2);
    expect(finding.column).toBe(1);
    expect(finding.match).toBe("رحـلة لا تُنسى");
    expect(text.slice(finding.index, finding.index + finding.match.length)).toBe(finding.match);
  });
});

describe("Arabic dialect drift (warning)", () => {
  it("warns when Egyptian and Khaleeji vocabulary share a block, naming both", () => {
    const finding = hit("احجز دلوقتي وخلك مرتاح، الحين الأسعار وايد حلوة", "ar.dialect_drift");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toMatch(/Egyptian/);
    expect(finding?.message).toMatch(/Khaleeji/);
    expect(finding?.message).toContain("دلوقتي");
    expect(finding?.message).toContain("الحين");
  });

  it.each(["كدا", "كده", "إزاي", "أوي", "برضو", "مفيش", "دلوقتي"])("treats %s as Egyptian", (marker) => {
    expect(hit(`احجز ${marker} واحنا نرتب. الحين نحجز`, "ar.dialect_drift")).toBeDefined();
  });

  it.each(["الحين", "وايد", "توك", "شلون", "أبشر", "يبيلك"])("treats %s as Khaleeji", (marker) => {
    expect(hit(`احجز ${marker} ونرتب. دلوقتي يلا`, "ar.dialect_drift")).toBeDefined();
  });

  it("does not warn for one dialect on its own", () => {
    expect(hit("احجز دلوقتي كدا أحسن ومفيش مشكلة", "ar.dialect_drift")).toBeUndefined();
    expect(hit("احجز الحين، الأسعار وايد حلوة، أبشر", "ar.dialect_drift")).toBeUndefined();
  });

  it("treats عشان and عشانك as shared words: they never signal a dialect on their own", () => {
    expect(hit("عشان الحين وايد", "ar.dialect_drift")).toBeUndefined();
    expect(hit("عشانك الحين وايد", "ar.dialect_drift")).toBeUndefined();
    expect(hit("عشان دلوقتي كدا", "ar.dialect_drift")).toBeUndefined();
    expect(hit("عشانك دلوقتي ومفيش مشكلة", "ar.dialect_drift")).toBeUndefined();
  });

  it("judges each paragraph separately", () => {
    expect(hit("احجز دلوقتي عشان كدا.\n\nالحين الأسعار وايد حلوة.", "ar.dialect_drift")).toBeUndefined();
    expect(hit("احجز دلوقتي عشان كدا.\n\nالحين وايد، و دلوقتي كمان.", "ar.dialect_drift")).toBeDefined();
  });

  it("reports the position of the first marker in the original text", () => {
    const text = "سطر\nاحجز دلوقتي والحين";
    const finding = hit(text, "ar.dialect_drift")!;
    expect(finding.line).toBe(2);
    expect(text.slice(finding.index, finding.index + finding.match.length)).toBe(finding.match);
  });

  it("is off when the Arabic pack is off", () => {
    expect(hit("احجز دلوقتي والحين", "ar.dialect_drift", { packs: ["protocol", "extended"] })).toBeUndefined();
  });
});

describe("prompt guidance includes the Arabic bans", () => {
  it("lists the banned Arabic phrases and the one-dialect rule", () => {
    const text = slopPromptRules().join("\n");
    for (const phrase of ["في عالمنا اليوم", "علاوة على ذلك", "أطلق العنان", "رحلة لا تُنسى"]) expect(text).toContain(phrase);
    expect(text).toMatch(/one dialect/i);
  });
});
