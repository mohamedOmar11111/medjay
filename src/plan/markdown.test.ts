import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown.js";

describe("markdownToHtml", () => {
  it("turns paragraphs, headings, lists, bold, italic and links into plain HTML", () => {
    const html = markdownToHtml(["# Umrah in Ramadan", "", "Plan **early** and *pack light*.", "Second line of the same paragraph.", "", "## Checklist", "", "- Passport", "- Visa", "", "1. Book", "2. Pray", "", "Read [our guide](https://example.com/guide?a=1&b=2)."].join("\n"));
    expect(html).toBe(
      [
        "<h1>Umrah in Ramadan</h1>",
        "<p>Plan <strong>early</strong> and <em>pack light</em>. Second line of the same paragraph.</p>",
        "<h2>Checklist</h2>",
        "<ul><li>Passport</li><li>Visa</li></ul>",
        "<ol><li>Book</li><li>Pray</li></ol>",
        '<p>Read <a href="https://example.com/guide?a=1&amp;b=2">our guide</a>.</p>',
      ].join("\n"),
    );
  });

  it("never lets raw HTML or script through: everything typed as markup is shown as text", () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\nHello <img src=x onerror=alert(1)> & "quotes"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp; &quot;quotes&quot;");
  });

  it("only makes web links from http and https addresses", () => {
    const html = markdownToHtml("[bad](javascript:alert(1)) and [data](data:text/html;base64,xx) and [ok](https://example.com)");
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toMatch(/href="data/i);
    expect(html).toContain('<a href="https://example.com">ok</a>');
    expect(html).toContain("bad");
  });

  it("keeps Arabic text and escapes a quote inside a link address", () => {
    expect(markdownToHtml("## رحلات العمرة\n\nاحجز مبكراً")).toBe("<h2>رحلات العمرة</h2>\n<p>احجز مبكراً</p>");
    expect(markdownToHtml('[x](https://example.com/"onmouseover="alert(1))')).not.toContain('onmouseover="');
  });

  it("is deterministic and handles empty and Windows line endings", () => {
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml("one\r\n\r\ntwo")).toBe("<p>one</p>\n<p>two</p>");
    const text = "# A\n\n- x\n- y\n\nend";
    expect(markdownToHtml(text)).toBe(markdownToHtml(text));
  });
});
