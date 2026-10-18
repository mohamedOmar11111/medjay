// Builds signed webhook requests locally, in the real provider format (Cloud API) or through the
// pointers of a generic webhook spec, so the whole bridge can be exercised without a public tunnel:
// tests, `mdj bridge simulate-webhook`, and the demo.
import { signBody } from "./signature.js";
import type { FieldPointers, WebhookSpec } from "./webhook-spec.js";

export type SimKind = "text" | "voice" | "voice_text" | "button" | "image";

export interface SimSpec {
  webhook: WebhookSpec;
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

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    node = typeof next === "object" && next !== null ? (next as Record<string, unknown>) : (node[part] = {});
  }
  node[parts[parts.length - 1] as string] = value;
}

/** A message in the shape the spec's pointers describe. */
function genericMessage(spec: SimSpec, id: string): Record<string, unknown> {
  const f = spec.webhook.fields as FieldPointers;
  const map = spec.webhook.type_map;
  const out: Record<string, unknown> = {};
  const set = (pointer: string | undefined, value: unknown) => {
    if (pointer !== undefined && value !== undefined) setPath(out, pointer, value);
  };
  if (spec.webhook.only_when) setPath(out, spec.webhook.only_when.path, spec.webhook.only_when.equals);
  set(f.message_id, id);
  set(f.sender_phone, spec.from);
  set(f.timestamp, (spec.timestamp ?? 1790000000) * 1000);
  switch (spec.kind) {
    case "text":
    case "voice_text":
      set(f.message_type, map.text[0]);
      set(f.text, spec.text ?? "");
      if (spec.kind === "voice_text") set(f.is_transcription, true);
      break;
    case "voice":
      // a relay with a separate media type sends the message as an attachment of audio type
      set(f.message_type, f.media_type ? "attachment" : map.audio[0]);
      set(f.media_type, map.audio[0]);
      set(f.transcript, spec.text);
      break;
    case "button":
      set(f.message_type, map.button[0]);
      set(f.button_id, spec.buttonId ?? "");
      break;
    case "image":
      set(f.message_type, f.media_type ? "attachment" : "image");
      set(f.media_type, "image");
      break;
  }
  return out;
}

export function buildWebhook(spec: SimSpec): { rawBody: string; headers: Record<string, string> } {
  const id = spec.id ?? nextId();
  const body =
    spec.webhook.provider === "cloud_api"
      ? { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [cloudMessage(spec, id)] } }] }] }
      : spec.webhook.messages_path
        ? (() => {
            const root: Record<string, unknown> = {};
            setPath(root, spec.webhook.messages_path, [genericMessage(spec, id)]);
            if (spec.webhook.only_when) setPath(root, spec.webhook.only_when.path, spec.webhook.only_when.equals);
            return root;
          })()
        : genericMessage(spec, id);
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { "content-type": "application/json", ...signBody(spec.webhook, rawBody, spec.badSignature ? `${spec.secret}-wrong` : spec.secret) } };
}
