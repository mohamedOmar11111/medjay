// Builds signed webhook requests locally, in the real provider formats, so the whole bridge can be
// exercised without a public tunnel: tests, `mdj bridge simulate-webhook`, and the demo.
import { signBody } from "./signature.js";
import type { Provider } from "./types.js";

export type SimKind = "text" | "voice" | "voice_text" | "button" | "image";

export interface SimSpec {
  provider: Provider;
  kind: SimKind;
  /** E.164, with the +. */
  from: string;
  /** text: the message. voice: the transcript, if the provider supplies one. voice_text: a text message flagged as a transcription. */
  text?: string;
  /** button: the button id from a card. */
  buttonId?: string;
  id?: string;
  /** Unix seconds. */
  timestamp?: number;
  secret: string;
  /** Sign with the wrong secret, to test rejection. */
  badSignature?: boolean;
}

let counter = 0;
const nextId = () => `sim-${Date.now().toString(36)}-${(counter += 1)}`;

function cloudMessage(spec: SimSpec, id: string): Record<string, unknown> {
  const base = { id, from: spec.from.replace(/^\+/, ""), timestamp: String(spec.timestamp ?? 1790000000) };
  switch (spec.kind) {
    case "text":
      return { ...base, type: "text", text: { body: spec.text ?? "" } };
    case "voice":
      return { ...base, type: "audio", audio: { id: "media-sim", ...(spec.text ? { transcript: spec.text } : {}) } };
    case "voice_text":
      return { ...base, type: "text", text: { body: spec.text ?? "" }, transcribed: true };
    case "button":
      return { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: { id: spec.buttonId ?? "", title: "button" } } };
    case "image":
      return { ...base, type: "image", image: { id: "media-sim" } };
  }
}

function respondMessage(spec: SimSpec): Record<string, unknown> {
  switch (spec.kind) {
    case "text":
      return { type: "text", text: spec.text ?? "" };
    case "voice":
      return { type: "attachment", attachment: { type: "audio", ...(spec.text ? { transcript: spec.text } : {}) } };
    case "voice_text":
      return { type: "text", text: spec.text ?? "", transcribed: true };
    default:
      return { type: "attachment", attachment: { type: "image" } };
  }
}

export function buildWebhook(spec: SimSpec): { rawBody: string; headers: Record<string, string> } {
  const id = spec.id ?? nextId();
  const body =
    spec.provider === "whatsapp_cloud_api"
      ? { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [cloudMessage(spec, id)] } }] }] }
      : { event_type: "message.received", contact: { phone: spec.from }, message: { messageId: id, timestamp: (spec.timestamp ?? 1790000000) * 1000, message: respondMessage(spec) } };
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { "content-type": "application/json", ...signBody(spec.provider, rawBody, spec.badSignature ? `${spec.secret}-wrong` : spec.secret) } };
}
