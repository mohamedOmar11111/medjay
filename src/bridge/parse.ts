// Webhook bodies to InboundMessage. The Cloud API shape follows Meta's documented webhook format.
// The Respond.io shape is MY READING of its message.received event and has not been checked against
// a live Respond.io workspace; treat it as a best-effort adapter until it has been.
import type { InboundMessage, Provider, Via } from "./types.js";

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookParseError";
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
const E164 = /^\+[1-9]\d{6,14}$/;

function sender(raw: unknown): string {
  const text = str(raw)?.trim() ?? "";
  const withPlus = text.startsWith("+") ? text : `+${text}`;
  if (!E164.test(withPlus)) throw new WebhookParseError("message has no valid sender number");
  return withPlus;
}

function when(raw: unknown): string | null {
  const n = typeof raw === "number" ? raw : Number(str(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;
  return new Date(ms).toISOString();
}

const TRANSCRIPT_FLAGS = ["transcribed", "is_transcript", "from_voice"];
const flaggedVoice = (m: Obj): boolean => TRANSCRIPT_FLAGS.some((k) => m[k] === true);

function fromCloud(body: Obj): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(obj(entry)?.changes) ? (obj(entry)!.changes as unknown[]) : []) {
      const value = obj(obj(change)?.value);
      for (const raw of Array.isArray(value?.messages) ? (value!.messages as unknown[]) : []) {
        const m = obj(raw);
        if (!m) continue;
        const id = str(m.id);
        if (!id) throw new WebhookParseError("message has no id");
        const type = str(m.type) ?? "";
        let via: Via = "other";
        let text: string | undefined;
        let buttonId: string | undefined;
        if (type === "text") {
          text = str(obj(m.text)?.body);
          via = flaggedVoice(m) ? "voice" : "typed";
        } else if (type === "audio" || type === "voice") {
          via = "voice";
          text = str(obj(m.audio)?.transcript);
        } else if (type === "interactive") {
          const reply = obj(obj(m.interactive)?.button_reply);
          buttonId = str(reply?.id);
          via = buttonId ? "button" : "other";
        }
        out.push({ id, from: sender(m.from), timestamp: when(m.timestamp), via, ...(text === undefined ? {} : { text }), ...(buttonId === undefined ? {} : { buttonId }) });
      }
    }
  }
  return out;
}

function fromRespond(body: Obj): InboundMessage[] {
  if (str(body.event_type) !== "message.received") return [];
  const outer = obj(body.message);
  const inner = obj(outer?.message);
  if (!outer || !inner) return [];
  const id = str(outer.messageId);
  if (!id) throw new WebhookParseError("message has no id");
  const type = str(inner.type) ?? "";
  const attachment = obj(inner.attachment);
  let via: Via = "other";
  let text: string | undefined;
  if (type === "text") {
    text = str(inner.text);
    via = flaggedVoice(inner) ? "voice" : "typed";
  } else if (type === "attachment" && ["audio", "voice"].includes(str(attachment?.type) ?? "")) {
    via = "voice";
    text = str(attachment?.transcript);
  }
  return [{ id, from: sender(obj(body.contact)?.phone), timestamp: when(outer.timestamp), via, ...(text === undefined ? {} : { text }) }];
}

export function parseWebhook(provider: Provider, body: unknown): InboundMessage[] {
  const root = obj(body);
  if (!root) throw new WebhookParseError("webhook body is not a JSON object");
  return provider === "whatsapp_cloud_api" ? fromCloud(root) : fromRespond(root);
}
