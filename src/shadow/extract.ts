// Structural, deterministic extraction of a competitor's offer architecture from a saved page or ad
// export. No model is involved: the same file always gives the same result, and nothing in the file is
// ever interpreted as an instruction. Instruction-like text is only flagged. What it reads:
//   headline promise, price anchor (and was/now), BNPL presence and providers, the call-to-action
//   channel (WhatsApp, web checkout, phone, form), and trust signals with a short evidence snippet.
import { cleanLabel, looksLikeInstruction, toNumber } from "../ingest/values.js";

export type Channel = "whatsapp" | "web_checkout" | "phone" | "form";
export const CHANNELS: readonly Channel[] = ["whatsapp", "web_checkout", "phone", "form"];
export type TrustKey = "rating" | "licence" | "guarantee" | "customer_count" | "secure_payment" | "press";

export interface Price {
  amount: number;
  /** An ISO code when the page wrote one; the literal word otherwise (a bare riyal is not assumed to be SAR). */
  currency: string;
  qualifier: "from" | "was" | "per_person" | "unqualified";
}

export interface Offer {
  headline: string | null;
  price_anchor: { amount: number; currency: string; qualifier: Price["qualifier"] } | null;
  prices: Price[];
  lowest: { amount: number; currency: string } | null;
  was_now: { was: number; now: number; discount_pct: number; currency: string } | null;
  bnpl: { present: boolean; providers: string[] };
  cta: { primary: Channel | "none"; counts: Partial<Record<Channel, number>> };
  trust: Partial<Record<TrustKey, string>>;
  /** Ads in an ad-library export. */
  ads: number | null;
  /** Excerpts of text that reads like an instruction to an AI. Never acted on. */
  instruction_like: string[];
}

const WAS_OPEN = "\u0001";
const WAS_CLOSE = "\u0002";

const decode = (t: string) =>
  t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(Number.parseInt(n, 16), 0x10ffff)));
const strip = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const arabicKey = (t: string) => t.replace(/[ً-ٰٟـ]/g, "");

// ---------- prices

const CODES = "SAR|AED|EGP|QAR|USD|EUR|GBP|KWD|BHD|OMR|JOD";
const WORDS = "ريال|درهم|دينار|جنيه|دولار|﷼";
const AMT = "[\\d\\u0660-\\u0669\\u06F0-\\u06F9][\\d\\u0660-\\u0669\\u06F0-\\u06F9,\\u066C.\\u066B]*";
const PRICE = new RegExp(`(?:\\b(${CODES})\\s?(${AMT}))|(?:(${AMT})\\s?(${CODES}|${WORDS})(?![\\p{L}]))|(?:([$€£])\\s?(${AMT}))`, "giu");
const SYMBOL: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

function findPrices(text: string): Price[] {
  const out: Price[] = [];
  let open = false;
  let last = 0;
  for (const m of text.matchAll(PRICE)) {
    const at = m.index ?? 0;
    for (const ch of text.slice(last, at)) if (ch === WAS_OPEN) open = true;
    else if (ch === WAS_CLOSE) open = false;
    last = at;
    const rawAmount = m[2] ?? m[3] ?? m[6] ?? "";
    const word = m[1] ?? m[4];
    const currency = word ? (/^[A-Za-z]+$/.test(word) ? word.toUpperCase() : word === "﷼" ? "ريال" : word) : (SYMBOL[m[5] ?? ""] ?? "");
    const amount = toNumber(rawAmount.replace(/[.,٫٬]$/, ""));
    if (amount === undefined || amount < 1 || amount >= 1e8 || currency === "") continue;
    const before = arabicKey(text.slice(Math.max(0, at - 28), at)).toLowerCase();
    const after = arabicKey(text.slice(at + m[0].length, at + m[0].length + 22)).toLowerCase();
    let qualifier: Price["qualifier"] = "unqualified";
    if (open) qualifier = "was";
    else if (/(?:\bfrom|starting (?:at|from)|starts? (?:at|from)|ابتداء من|يبدأ من|تبدأ من|تبدا من)\s*$/.test(before)) qualifier = "from";
    else if (/^\s*(?:per person|\/\s*person|pp\b|per pax|للشخص|للفرد)/.test(after)) qualifier = "per_person";
    out.push({ amount, currency, qualifier });
  }
  return out;
}

function priceFacts(prices: Price[]): Pick<Offer, "price_anchor" | "lowest" | "was_now"> {
  const live = prices.filter((p) => p.qualifier !== "was");
  const anchor = live.find((p) => p.qualifier === "from") ?? live[0];
  if (!anchor) return { price_anchor: null, lowest: null, was_now: null };
  const sameCurrency = live.filter((p) => p.currency === anchor.currency);
  const lowest = sameCurrency.reduce((a, b) => (b.amount < a.amount ? b : a));
  let was_now: Offer["was_now"] = null;
  const was = prices.find((p) => p.qualifier === "was");
  if (was) {
    const now = prices.slice(prices.indexOf(was) + 1).find((p) => p.qualifier !== "was" && p.currency === was.currency && p.amount < was.amount);
    if (now) was_now = { was: was.amount, now: now.amount, discount_pct: Math.round(((was.amount - now.amount) / was.amount) * 1000) / 10, currency: was.currency };
  }
  return { price_anchor: { amount: anchor.amount, currency: anchor.currency, qualifier: anchor.qualifier }, lowest: { amount: lowest.amount, currency: lowest.currency }, was_now };
}

// ---------- BNPL

const PROVIDERS: [string, RegExp][] = [
  ["tabby", /tabby|تابي/i],
  ["tamara", /tamara|تمارا/i],
  ["postpay", /postpay|بوست ?باي/i],
  ["spotii", /spotii|سبوتي/i],
  ["madfu", /madfu|مدفو/i],
  ["valu", /\bvalu\b/i],
  ["klarna", /klarna/i],
  ["affirm", /\baffirm\b/i],
  ["afterpay", /afterpay/i],
];
const BNPL_PHRASES = /buy now,? pay later|pay later|pay in (?:3|4|6)\b|split (?:it )?in (?:3|4|6)|instal+ments?|installments?|تقسيط|قسّم|قسم مشترياتك|اشتر[يى] الآن وادفع لاحق|ادفع على دفعات/i;

function bnpl(text: string): Offer["bnpl"] {
  const providers = PROVIDERS.filter(([, re]) => re.test(text)).map(([name]) => name).sort();
  return { present: providers.length > 0 || BNPL_PHRASES.test(text), providers };
}

// ---------- trust

const TRUST: [TrustKey, RegExp][] = [
  ["rating", /\b[0-5](?:\.\d)?\s*(?:\/\s*5|out of 5|stars?|★)|★/i],
  ["licence", /licen[cs]ed|licen[cs]e\b|\bIATA\b|ministry of (?:hajj|tourism)|وزارة الحج|وزارة السياحة|مرخص|ترخيص/i],
  ["guarantee", /money[- ]back|guarantee|refund|ضمان|استرداد/i],
  ["customer_count", /[\d,٬٠-٩]{3,}\+?\s*(?:travell?ers|customers|clients|guests|pilgrims|معتمر|عميل|مسافر)/i],
  ["secure_payment", /secure (?:payment|checkout)|\bSSL\b|256-bit|دفع آمن/i],
  ["press", /as seen (?:on|in)|featured in/i],
];

function trust(text: string): Offer["trust"] {
  const out: Offer["trust"] = {};
  for (const [key, re] of TRUST) {
    const m = re.exec(text);
    if (m) out[key] = cleanLabel(text.slice(Math.max(0, m.index - 36), m.index + m[0].length + 36), 100);
  }
  return out;
}

// ---------- calls to action

function classify(href: string, label: string): Channel | null {
  const text = arabicKey(label).toLowerCase();
  if (/wa\.me|api\.whatsapp\.com|whatsapp:\/\//i.test(href) || /whatsapp|واتساب|واتس اب/i.test(text)) return "whatsapp";
  if (/^tel:/i.test(href) || /\bcall (?:us|now)\b|اتصل/i.test(text)) return "phone";
  if (/checkout|\/cart|\/book(?:ing)?\b|reserve/i.test(href) || /(?:book|buy|reserve|order) now|add to cart|checkout|احجز الآن|احجز الان|اشتر[يى] الآن|أضف إلى السلة/i.test(text)) return "web_checkout";
  if (/get (?:a )?quote|request (?:a )?quote|اطلب عرض|سجل الآن|sign up/i.test(text)) return "form";
  return null;
}

function ctaFrom(counts: Partial<Record<Channel, number>>): Offer["cta"] {
  const clean: Partial<Record<Channel, number>> = {};
  for (const c of CHANNELS) if ((counts[c] ?? 0) > 0) clean[c] = counts[c] as number;
  let primary: Channel | "none" = "none";
  let best = 0;
  for (const c of CHANNELS) if ((clean[c] ?? 0) > best) [primary, best] = [c, clean[c] as number];
  return { primary, counts: clean };
}

// ---------- formats

const kindOf = (file: string) => (/\.(?:html?)$/i.test(file) ? "html" : /\.json$/i.test(file) ? "json" : "text");

function instructionLike(segments: string[]): string[] {
  const out: string[] = [];
  for (const s of segments) if (out.length < 5 && s.trim() !== "" && looksLikeInstruction(s)) out.push(cleanLabel(s, 80));
  return out;
}

function fromHtml(raw: string): Offer {
  const comments = [...raw.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1] as string);
  let html = raw.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ");
  const head = /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? "";
  html = html.replace(/<head\b[\s\S]*?<\/head>/i, " ");
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(head)?.[1];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const headlineRaw = h1 ? strip(h1) : og ? decode(og) : title ? strip(title) : "";

  const counts: Partial<Record<Channel, number>> = {};
  const bump = (c: Channel | null) => c && (counts[c] = (counts[c] ?? 0) + 1);
  for (const a of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) bump(classify(/href\s*=\s*["']([^"']*)["']/i.exec(a[1] as string)?.[1] ?? "", strip(a[2] as string)));
  for (const b of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) bump(classify("", strip(b[1] as string)));
  if (/<form\b/i.test(html) && /<input\b[^>]*(?:type=["']?(?:tel|email)|name=["']?(?:phone|email))/i.test(html)) bump("form");

  const marked = html.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => ` ${WAS_OPEN}${inner}${WAS_CLOSE} `);
  const withMarks = decode(marked.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  const text = withMarks.replaceAll(WAS_OPEN, "").replaceAll(WAS_CLOSE, "");
  const prices = findPrices(withMarks);
  return {
    headline: headlineRaw ? cleanLabel(headlineRaw, 160) : null,
    ...priceFacts(prices),
    prices,
    bnpl: bnpl(text),
    cta: ctaFrom(Object.keys(counts).length ? counts : textCtas(text)),
    trust: trust(text),
    ads: null,
    instruction_like: instructionLike([...comments, ...text.split(/(?<=[.!?])\s+/)]),
  };
}

function textCtas(text: string): Partial<Record<Channel, number>> {
  const counts: Partial<Record<Channel, number>> = {};
  const add = (c: Channel, re: RegExp) => {
    const n = (text.match(re) ?? []).length;
    if (n > 0) counts[c] = n;
  };
  add("whatsapp", /whatsapp|واتساب/gi);
  add("phone", /\bcall (?:us|now)\b|اتصل/gi);
  add("web_checkout", /(?:book|buy|reserve|order) now|add to cart|checkout|احجز الآن/gi);
  return counts;
}

function fromText(raw: string): Offer {
  const heading = /^\s*#{1,3}\s+(.+)$/m.exec(raw)?.[1] ?? raw.split(/\r?\n/).find((l) => l.trim() !== "");
  const counts: Partial<Record<Channel, number>> = {};
  for (const link of raw.matchAll(/\[([^\]]*)\]\(([^)\s]*)\)/g)) {
    const c = classify(link[2] as string, link[1] as string);
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  }
  const text = raw.replace(/\s+/g, " ").trim();
  const prices = findPrices(text);
  return {
    headline: heading ? cleanLabel(heading, 160) : null,
    ...priceFacts(prices),
    prices,
    bnpl: bnpl(text),
    cta: ctaFrom(Object.keys(counts).length ? counts : textCtas(text)),
    trust: trust(text),
    ads: null,
    instruction_like: instructionLike(raw.split(/\r?\n/)),
  };
}

const AD_CTA: Record<string, Channel> = {
  WHATSAPP_MESSAGE: "whatsapp",
  SHOP_NOW: "web_checkout",
  BOOK_NOW: "web_checkout",
  BOOK_TRAVEL: "web_checkout",
  BUY_NOW: "web_checkout",
  ORDER_NOW: "web_checkout",
  GET_OFFER: "web_checkout",
  CALL_NOW: "phone",
  SIGN_UP: "form",
  APPLY_NOW: "form",
  GET_QUOTE: "form",
  CONTACT_US: "form",
};

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

function fromAds(raw: string): Offer {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty();
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown } | null)?.data) ? ((data as { data: unknown[] }).data) : Array.isArray((data as { ads?: unknown } | null)?.ads) ? ((data as { ads: unknown[] }).ads) : [];
  const ads = list.filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null);
  const counts: Partial<Record<Channel, number>> = {};
  const pieces: string[] = [];
  let headline: string | null = null;
  for (const ad of ads) {
    const titles = [...asStrings(ad.ad_creative_link_titles), ...asStrings(ad.headline), ...asStrings(ad.title)];
    const bodies = [...asStrings(ad.ad_creative_bodies), ...asStrings(ad.body), ...asStrings(ad.text), ...asStrings(ad.ad_creative_link_descriptions)];
    headline ??= titles.find((t) => t.trim() !== "") ?? bodies.map((b) => b.split(/\r?\n/)[0] ?? "").find((t) => t.trim() !== "") ?? null;
    pieces.push(...titles, ...bodies);
    const channel = AD_CTA[String(ad.call_to_action_type ?? "").toUpperCase()];
    if (channel) counts[channel] = (counts[channel] ?? 0) + 1;
  }
  const text = pieces.join(". ").replace(/\s+/g, " ");
  const prices = findPrices(text);
  return {
    headline: headline ? cleanLabel(headline, 160) : null,
    ...priceFacts(prices),
    prices,
    bnpl: bnpl(text),
    cta: ctaFrom(counts),
    trust: trust(text),
    ads: ads.length,
    instruction_like: instructionLike(pieces),
  };
}

function empty(): Offer {
  return { headline: null, price_anchor: null, prices: [], lowest: null, was_now: null, bnpl: { present: false, providers: [] }, cta: { primary: "none", counts: {} }, trust: {}, ads: null, instruction_like: [] };
}

export function extractOffer(file: string, text: string): Offer {
  const kind = kindOf(file);
  if (text.trim() === "") return empty();
  return kind === "html" ? fromHtml(text) : kind === "json" ? fromAds(text) : fromText(text);
}
