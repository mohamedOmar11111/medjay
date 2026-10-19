// The activity feed as plain styled lines, so wrapping and scrolling are testable without a terminal.
import { TAGLINE, WORDMARK } from "./splash.js";
import { wrapText } from "./text.js";

export type FeedTone = "normal" | "dim" | "accent" | "err" | "user";
export interface FeedLine {
  text: string;
  tone: FeedTone;
}

export type EntryKind = "splash" | "user" | "out" | "err" | "info" | "answer";
export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
}

export const splashText = (): string =>
  [...WORDMARK, "", TAGLINE, "", "Ask me anything about your ads, in English or Arabic. Type / for shortcuts.", "اسألني عن إعلاناتك بالعربي أو الإنجليزي. اكتب / للاختصارات."].join("\n");

export function buildFeedLines(entries: Entry[], width: number): FeedLine[] {
  const out: FeedLine[] = [];
  for (const entry of entries) {
    const text = entry.text.replace(/\s+$/, "");
    if (entry.kind === "splash") {
      text.split("\n").forEach((line, i) => (i < WORDMARK.length ? out.push({ text: line, tone: "accent" }) : wrapText(line, width).forEach((l) => out.push({ text: l, tone: "dim" }))));
    } else if (entry.kind === "answer") {
      // "# " marks the headline, "> " the what-next block, everything else is the body
      for (const raw of text.split("\n")) {
        const tone: FeedTone = raw.startsWith("# ") ? "accent" : raw.startsWith("> ") ? "dim" : "normal";
        for (const l of wrapText(tone === "normal" ? raw : raw.slice(2), width)) out.push({ text: l, tone });
      }
    } else if (entry.kind === "user") {
      for (const l of wrapText(`❯ ${text}`, width)) out.push({ text: l, tone: "user" });
    } else {
      const tone: FeedTone = entry.kind === "err" ? "err" : entry.kind === "info" ? "dim" : "normal";
      const body = entry.kind === "err" ? `! ${text}` : text;
      for (const l of wrapText(body, width)) out.push({ text: l, tone });
    }
    out.push({ text: "", tone: "normal" });
  }
  return out;
}
