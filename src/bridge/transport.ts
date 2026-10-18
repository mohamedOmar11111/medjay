// Outbound replies, behind one small interface so the engine is not tied to any messaging vendor:
//   console          prints (local use and tests)
//   cloud_api        Meta's WhatsApp Cloud API (Graph API)
//   generic_webhook  POSTs JSON { to, text, plan_id, short_hash, ledger_head } to a URL you configure
//                    (your CRM or relay then delivers it however it likes)
// A transport never throws: a failed send is a result, so a relay outage cannot undo a command that
// already ran. Tokens are never put in results or logs. NOT verified against live services: WhatsApp's
// 24-hour window and template rules still apply to business-initiated messages.
import type { OutboundMessage } from "./types.js";

export interface SendResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

export interface BridgeTransport {
  readonly kind: "console" | "cloud_api" | "generic_webhook";
  send(message: OutboundMessage): Promise<SendResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const scrub = (text: string, secret: string | undefined): string => (secret ? text.split(secret).join("[REDACTED]") : text);
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 160);

export class ConsoleTransport implements BridgeTransport {
  readonly kind = "console" as const;
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}
  async send(message: OutboundMessage): Promise<SendResult> {
    this.write(`--- reply to ${message.to.slice(0, 5)}...${message.to.slice(-2)} ---\n${message.text}`);
    if (message.buttons) this.write(`buttons: ${message.buttons.map((b) => `[${b.title}] ${b.id}`).join("  ")}`);
    return { ok: true, detail: "printed" };
  }
}

async function post(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, secret: string | undefined): Promise<SendResult> {
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, detail: short(scrub(await res.text().catch(() => ""), secret)) };
  } catch (error) {
    return { ok: false, detail: short(scrub(error instanceof Error ? error.message : String(error), secret)) };
  }
}

export class GenericWebhookTransport implements BridgeTransport {
  readonly kind = "generic_webhook" as const;
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly fetchFn: FetchLike;
  constructor(options: { url: string; token?: string; fetch: FetchLike }) {
    if (!/^https:\/\//i.test(options.url)) throw new Error("a generic webhook transport must use an https URL");
    this.url = options.url;
    this.token = options.token || undefined;
    this.fetchFn = options.fetch;
  }
  send(message: OutboundMessage): Promise<SendResult> {
    const body = {
      to: message.to,
      text: message.text,
      plan_id: message.meta?.plan_id ?? null,
      short_hash: message.meta?.short_hash ?? null,
      ledger_head: message.meta?.ledger_head ?? null,
      ...(message.buttons ? { buttons: message.buttons } : {}),
    };
    return post(this.fetchFn, this.url, this.token ? { authorization: `Bearer ${this.token}` } : {}, body, this.token);
  }
}

const TEXT_LIMIT = 4096;
const BUTTON_TITLE_LIMIT = 20;

export class CloudApiTransport implements BridgeTransport {
  readonly kind = "cloud_api" as const;
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;
  constructor(options: { phoneNumberId: string; token: string; version: string; fetch: FetchLike }) {
    if (!/^\d{5,20}$/.test(options.phoneNumberId)) throw new Error("the Cloud API phone number id must be digits only");
    if (options.token === "") throw new Error("the Cloud API transport needs an access token");
    this.url = `https://graph.facebook.com/${options.version}/${options.phoneNumberId}/messages`;
    this.token = options.token;
    this.fetchFn = options.fetch;
  }
  async send(message: OutboundMessage): Promise<SendResult> {
    const to = message.to.replace(/^\+/, "");
    const auth = { authorization: `Bearer ${this.token}` };
    const text = message.text.length > TEXT_LIMIT ? `${message.text.slice(0, TEXT_LIMIT - 40)}\n... continues on your computer.` : message.text;
    const first = await post(this.fetchFn, this.url, auth, { messaging_product: "whatsapp", to, type: "text", text: { body: text } }, this.token);
    if (!first.ok || !message.buttons?.length) return first;
    // A card is long, but a button message body is limited to 1024 characters: text first, buttons second.
    const second = await post(
      this.fetchFn,
      this.url,
      auth,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.meta?.short_hash ? `Choose for plan ${message.meta.short_hash}:` : "Choose:" },
          action: { buttons: message.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, BUTTON_TITLE_LIMIT) } })) },
        },
      },
      this.token,
    );
    return second;
  }
}

/** Send every reply. A failure on one does not stop the rest. */
export async function deliver(replies: OutboundMessage[], transport: Pick<BridgeTransport, "send">): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const reply of replies) results.push(await transport.send(reply));
  return results;
}
