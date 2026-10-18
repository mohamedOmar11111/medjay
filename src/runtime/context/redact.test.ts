import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";

describe("Redactor: phone numbers and emails", () => {
  it("replaces phone numbers in common international and local formats", () => {
    const r = new Redactor();
    const cases = [
      ["Call +201000000000 now", "Call [PHONE_1] now"],
      ["Call +20 100 000 0000 now", "Call [PHONE_1] now"],
      ["Call +966 (55) 123-4567 now", "Call [PHONE_1] now"],
      ["Call 00201000000000 now", "Call [PHONE_1] now"],
      ["Call 01000000000 now", "Call [PHONE_1] now"],
      ["Call 0551234567 now", "Call [PHONE_1] now"],
    ] as const;
    for (const [input, expected] of cases) expect(new Redactor().redact(input).text, input).toBe(expected);
    expect(r.redact("x").text).toBe("x");
  });

  it("replaces emails", () => {
    expect(new Redactor().redact("Write to Omar.Hassan+ads@grow-digital.example.com today").text).toBe("Write to [EMAIL_1] today");
  });

  it("reads Arabic-Indic digits as digits and keeps the surrounding Arabic text", () => {
    expect(new Redactor().redact("اتصل على ٠١٠٠٠٠٠٠٠٠٠ الآن").text).toBe("اتصل على [PHONE_1] الآن");
    expect(new Redactor().redact("+٢٠١٠٠٠٠٠٠٠٠٠٠").text).toBe("[PHONE_1]");
  });

  it("gives the same value the same placeholder within a run and a new one for a new value", () => {
    const r = new Redactor();
    const out = r.redact("A +201000000000, B +966551234567, A again +201000000000, mail a@b.co and c@d.co and a@b.co");
    expect(out.text).toBe("A [PHONE_1], B [PHONE_2], A again [PHONE_1], mail [EMAIL_1] and [EMAIL_2] and [EMAIL_1]");
    expect(r.redact("later +966551234567").text).toBe("later [PHONE_2]");
  });

  it("counts what it replaced, by kind, and counts a repeated value each time it appears", () => {
    const r = new Redactor();
    r.redact("+201000000000 and +201000000000 and a@b.co");
    expect(r.counts()).toEqual({ phone: 2, email: 1, secret: 0 });
  });

  it("never keeps the original value anywhere it exposes", () => {
    const r = new Redactor();
    r.redact("+201000000000 a@b.co");
    expect(JSON.stringify(r.counts())).not.toMatch(/2010|a@b/);
  });
});

describe("Redactor: things that are not personal data are left alone", () => {
  it.each([
    "Ad set 23859102938 spent 640",
    "Campaign id 120210123456789012",
    "Budget 1,000,000 SAR",
    "Spend 1000000000 USD",
    "Date 2026-10-17 at 10:30",
    "ROAS 4.2x and +31% lift",
    "Order 12345 in season 2026",
    "Version 1.2.3-beta",
    "ratio 0.5 to 0.75",
  ])("keeps %j", (text) => {
    const r = new Redactor();
    expect(r.redact(text).text).toBe(text);
    expect(r.counts()).toEqual({ phone: 0, email: 0, secret: 0 });
  });
});

describe("Redactor: secrets", () => {
  it("replaces provider-key-shaped values as well", () => {
    const r = new Redactor();
    expect(r.redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end").text).toBe("key [REDACTED_SECRET] end");
    expect(r.counts().secret).toBe(1);
  });
});

describe("Redactor: robustness", () => {
  it("handles empty text and long text quickly", () => {
    const r = new Redactor();
    expect(r.redact("").text).toBe("");
    const big = "call +201000000000 or mail a@b.co, plain words here. ".repeat(5000);
    const started = Date.now();
    r.redact(big);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("does not mistake a long digit run inside a word or a URL for a phone number", () => {
    const r = new Redactor();
    expect(r.redact("https://x.example/path/0551234567890abc").text).toContain("0551234567890abc");
    expect(r.redact("sku-0551234567").text).toBe("sku-0551234567");
  });
});
