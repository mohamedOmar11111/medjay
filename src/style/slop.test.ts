import { describe, expect, it } from "vitest";
import { lintText, type SlopFinding } from "./slop.js";
import { slopPromptRules } from "./prompt.js";

const rules = (findings: SlopFinding[]) => findings.map((f) => f.rule);
const lint = (text: string, options: Parameters<typeof lintText>[1] = {}) => lintText(text, options);

describe("protocol vocabulary (the owner's Anti-AI Writing Protocol)", () => {
  it.each([
    ["We leverage our network", "vocab.leverage", "use"],
    ["They utilized a new tool", "vocab.utilize", "use"],
    ["A seamless booking flow", "vocab.seamless", "smooth"],
    ["Seamlessly connected", "vocab.seamless", "smooth"],
    ["A robust system", "vocab.robust", "strong"],
    ["Transformative results", "vocab.transformative", "change"],
    ["A pivotal moment", "vocab.pivotal", "main"],
    ["Embark on the trip", "vocab.embark", "start"],
    ["Let us delve into data", "vocab.delve", "look at"],
    ["Navigate the options", "vocab.navigate", "go through"],
    ["Unlock more bookings", "vocab.unlock", ""],
    ["A comprehensive guide", "vocab.comprehensive", ""],
  ])("flags %j as %s", (text, rule, suggestion) => {
    const report = lint(text);
    const hit = report.findings.find((f) => f.rule === rule);
    expect(hit, text).toBeDefined();
    expect(hit?.severity).toBe("error");
    if (suggestion) expect(hit?.suggestion?.toLowerCase()).toContain(suggestion);
  });

  it("matches inflections and any letter case but not other words", () => {
    expect(rules(lint("LEVERAGING data, leverages it, leveraged it").findings).filter((r) => r === "vocab.leverage")).toHaveLength(3);
    expect(lint("Our navigator and the delivery").findings.filter((f) => f.rule.startsWith("vocab."))).toEqual([]);
  });

  it("passes the owner's own example of evidence over inflation", () => {
    const report = lint("The Etlaala build made +1M SAR profit. No filler.");
    expect(report.findings.filter((f) => f.severity === "error" && !f.rule.startsWith("claims."))).toEqual([]);
  });

  it("honors an allow list and workspace extras", () => {
    expect(lint("Navigate to settings", { allow: ["navigate"] }).findings).toEqual([]);
    const extra = lint("A premium experience", { extraBanned: [{ phrase: "premium experience", suggestion: "say what is included" }] });
    expect(extra.findings[0]).toMatchObject({ rule: "brand.forbidden", severity: "error", suggestion: "say what is included" });
  });
});

describe("transitions, copula, politeness", () => {
  it("flags sentence-initial transitions the protocol kills", () => {
    expect(rules(lint("It worked. Moreover, it scaled. Furthermore, it paid. In conclusion, buy.").findings).filter((r) => r === "transition.kill")).toHaveLength(3);
    expect(lint("We did more over time and moreover nothing.").findings.some((f) => f.rule === "transition.kill")).toBe(false);
  });

  it("flags 'serves as' and 'boasts'", () => {
    const report = lint("The hotel boasts a pool. It serves as a base.");
    expect(rules(report.findings).filter((r) => r === "copula.fancy")).toHaveLength(2);
    expect(report.findings.find((f) => f.rule === "copula.fancy")?.suggestion).toMatch(/is|has/);
  });

  it("flags politeness openers", () => {
    for (const text of ["Certainly! Here is the plan.", "I hope this helps.", "Let's explore the options.", "Great question."]) {
      expect(lint(text).findings.some((f) => f.rule === "tone.polite"), text).toBe(true);
    }
  });

  it("handles curly apostrophes", () => {
    expect(lint("Let’s explore the options.").findings.some((f) => f.rule === "tone.polite")).toBe(true);
  });
});

describe("inflation, vague authority, false ranges", () => {
  it("flags inflation words and tells the writer to show the number", () => {
    const hit = lint("A game-changing offer").findings.find((f) => f.rule === "inflation.word");
    expect(hit?.severity).toBe("error");
    expect(hit?.suggestion).toMatch(/number|ROI|show/i);
    expect(lint("A game changer").findings.some((f) => f.rule === "inflation.word")).toBe(true);
  });

  it("flags unattributed authority", () => {
    expect(lint("Experts believe this works").findings.some((f) => f.rule === "authority.vague")).toBe(true);
    expect(lint("Studies show a lift").findings.some((f) => f.rule === "authority.vague")).toBe(true);
    expect(lint("Booking.com data from Oct 2026 shows a lift").findings.some((f) => f.rule === "authority.vague")).toBe(false);
  });

  it("warns about false ranges", () => {
    const hit = lint("From villas to flights, we cover it").findings.find((f) => f.rule === "range.false");
    expect(hit?.severity).toBe("warn");
    expect(lint("Open from 9 to 5").findings.some((f) => f.rule === "range.false")).toBe(false);
  });
});

describe("structure", () => {
  it("warns on uniform sentence rhythm but not on varied rhythm or short text", () => {
    const uniform = Array.from({ length: 6 }, (_, i) => `This is sentence number ${i} of text.`).join(" ");
    expect(lint(uniform).findings.some((f) => f.rule === "rhythm.uniform")).toBe(true);
    const varied = "Booked. We lost 40% of leads at the price reply, and nobody noticed for three weeks. Why? Speed. The fix took one afternoon and a rule. Done.";
    expect(lint(varied).findings.some((f) => f.rule === "rhythm.uniform")).toBe(false);
    expect(lint("Short one. Another short one.").findings.some((f) => f.rule === "rhythm.uniform")).toBe(false);
  });

  it("warns on 'not just X but Y' and on em-dash density", () => {
    expect(lint("It is not just a tool, but a movement.").findings.some((f) => f.rule === "pattern.not_just")).toBe(true);
    const dashy = `${"word ".repeat(30)}— x — y — z ${"word ".repeat(30)}`;
    expect(lint(dashy).findings.some((f) => f.rule === "punct.em_dash")).toBe(true);
    expect(lint("One dash — only once in a long enough sentence of plain words here.").findings.some((f) => f.rule === "punct.em_dash")).toBe(false);
  });

  it("warns on repeated rule-of-three lists", () => {
    const threes = "We cut cost, time, and risk. We add speed, trust, and reach. We bring data, craft, and focus.";
    expect(lint(threes).findings.some((f) => f.rule === "pattern.triplet")).toBe(true);
    expect(lint("We cut cost, time, and risk.").findings.some((f) => f.rule === "pattern.triplet")).toBe(false);
  });

  it("applies opener rules by kind: posts must not open soft, ads may ask a question", () => {
    expect(lint("Excited to announce our new package.", { kind: "post" }).findings.some((f) => f.rule === "opener.soft")).toBe(true);
    expect(lint("Hello everyone, today we share.", { kind: "post" }).findings.some((f) => f.rule === "opener.soft")).toBe(true);
    expect(lint("Hello everyone, today we share.").findings.some((f) => f.rule === "opener.soft")).toBe(false);
    expect(lint("Looking for a Maldives deal?", { kind: "general" }).findings.some((f) => f.rule === "opener.question")).toBe(true);
    expect(lint("Looking for a Maldives deal?", { kind: "ad" }).findings.some((f) => f.rule === "opener.question")).toBe(false);
  });
});

describe("extended pack (common AI-isms, warnings)", () => {
  it("warns by default and can be switched off", () => {
    const text = "Elevate your holiday and unleash a holistic experience in today's fast-paced world.";
    const on = lint(text);
    expect(on.findings.filter((f) => f.rule.startsWith("ai."))).not.toHaveLength(0);
    expect(on.findings.filter((f) => f.rule.startsWith("ai.")).every((f) => f.severity === "warn")).toBe(true);
    expect(lint(text, { packs: ["protocol"] }).findings.filter((f) => f.rule.startsWith("ai."))).toEqual([]);
  });
});

describe("claims: every public number needs a verified claim", () => {
  const register = {
    claims: [
      { id: "CLM-001", values: ["+31%"], text: "Lead-to-qualified-chat lift", source: "EXP-088", date: "2026-10-01", status: "verified" as const },
      { id: "CLM-002", values: ["1M SAR"], text: "Profit", source: "client report", date: "2026-09-01", status: "verified" as const },
      { id: "CLM-003", values: ["4.2x"], text: "Blended MER", source: "scout", date: "2026-10-10", status: "pending" as const },
    ],
  };

  it("does nothing about numbers when no register is supplied", () => {
    expect(lint("We saw +31% and 5x more").findings.some((f) => f.rule.startsWith("claims."))).toBe(false);
  });

  it("passes numbers that match a verified claim, in any common form", () => {
    expect(lint("Up 31% in chats.", { claims: register }).findings.filter((f) => f.rule.startsWith("claims."))).toEqual([]);
    expect(lint("Profit: SAR 1,000,000 last year.", { claims: register }).findings.filter((f) => f.rule.startsWith("claims."))).toEqual([]);
    expect(lint("+1M SAR profit.", { claims: register }).findings.filter((f) => f.rule.startsWith("claims."))).toEqual([]);
  });

  it("errors on a number that is not in the register, and says to add it as awaiting evidence", () => {
    const hit = lint("We grew bookings by 55%.", { claims: register }).findings.find((f) => f.rule === "claims.unverified");
    expect(hit).toMatchObject({ severity: "error", match: "55%" });
    expect(hit?.suggestion).toMatch(/register|evidence/i);
    expect(lint("A 3x return.", { claims: register }).findings.some((f) => f.rule === "claims.unverified")).toBe(true);
  });

  it("flags a pending claim as not publishable", () => {
    const hit = lint("MER is 4.2x.", { claims: register }).findings.find((f) => f.rule === "claims.pending");
    expect(hit).toMatchObject({ severity: "error" });
    expect(hit?.message).toContain("CLM-003");
  });

  it("reads Arabic-Indic digits and the Arabic percent sign", () => {
    expect(lint("ارتفعت ٣١٪ من المحادثات", { claims: register }).findings.filter((f) => f.rule.startsWith("claims."))).toEqual([]);
    expect(lint("ارتفعت ٥٥٪ من المحادثات", { claims: register }).findings.some((f) => f.rule === "claims.unverified")).toBe(true);
  });

  it("ignores years, dates, times, ids and phone numbers", () => {
    const text = "Call +20 100 000 0000 at 10:30 on 2026-10-17. Order 12345, season 2026.";
    expect(lint(text, { claims: register }).findings.filter((f) => f.rule.startsWith("claims."))).toEqual([]);
  });
});

describe("positions, ordering and reporting", () => {
  it("gives 1-based line and column and the exact matched text", () => {
    const text = "Plain line.\nWe leverage it.";
    const hit = lint(text).findings.find((f) => f.rule === "vocab.leverage")!;
    expect(hit).toMatchObject({ line: 2, column: 4, match: "leverage" });
    expect(text.slice(hit.index, hit.index + hit.match.length)).toBe("leverage");
  });

  it("sorts findings by position and counts severities", () => {
    const report = lint("Moreover, we leverage a game-changing, holistic tool.");
    const indexes = report.findings.map((f) => f.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(report.counts.error).toBeGreaterThanOrEqual(3);
    expect(report.counts.warn).toBeGreaterThanOrEqual(1);
  });

  it("passes on clean text and fails on errors; warnings fail only when asked", () => {
    expect(lint("Booked 40 trips in March. Price replies lost most leads.").pass).toBe(true);
    expect(lint("We leverage data.").pass).toBe(false);
    const warnOnly = "A holistic plan.";
    expect(lint(warnOnly).pass).toBe(true);
    expect(lint(warnOnly, { failOn: "warn" }).pass).toBe(false);
  });

  it("reports basic stats", () => {
    const report = lint("One two three. Four five.");
    expect(report.stats).toMatchObject({ words: 5, sentences: 2 });
  });

  it("stays fast on large input", () => {
    const text = "We booked a trip, then another trip, and a third trip. ".repeat(3000);
    const started = Date.now();
    lint(text);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("slopPromptRules: the same rules, written as guidance for the model", () => {
  it("lists every protocol word with its replacement and the evidence rule", () => {
    const text = slopPromptRules().join("\n");
    for (const word of ["leverage", "utilize", "seamless", "robust", "transformative", "pivotal", "embark", "delve", "navigate", "unlock"]) {
      expect(text.toLowerCase()).toContain(word);
    }
    expect(text).toMatch(/Moreover|Furthermore/);
    expect(text).toMatch(/number|ROI/i);
    expect(text).toMatch(/serves as|boasts/);
  });

  it("is deterministic and includes workspace-forbidden phrases", () => {
    expect(slopPromptRules().join("\n")).toBe(slopPromptRules().join("\n"));
    expect(slopPromptRules({ extraBanned: [{ phrase: "premium experience" }] }).join("\n")).toContain("premium experience");
  });
});
