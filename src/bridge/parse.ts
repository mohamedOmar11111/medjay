// Webhook bodies to InboundMessage. cloud_api follows Meta's documented webhook format. Everything
// else is read through the pointers in the webhook spec, so a new CRM or relay needs configuration,
// not code. Only the Cloud API and the generic pointer reader exist; the Respond.io preset is a guess
// at its payload and has not been checked against a live workspace.
import type { InboundMessage, Via } from "./types.js";
import type { FieldPointers, WebhookSpec } from "./webhook-spec.js";

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

/** Own-property dotted lookup (no __proto__ or constructor tricks). */
export function pointer(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (typeof current === "object" && current !== null && Object.hasOwn(current, part)) current = (current as Obj)[part];
    else return undefined;
  }
  return current;
}

function sender(raw: unknown): string {
  const text = str(raw)?.trim() ?? "";
  const withPlus = text.startsWith("+") ? text : `+${text}`;
  if (!E164.test(withPlus)) throw new WebhookParseError("message has no valid sender number");
  return withPlus;
}

function when(raw: unknown): string | null {
  const n = typeof raw === "number" ? raw : Number(str(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e11 ? n : n * 1000).toISOString();
}

const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && /^(true|1|yes)$/i.test(v));
const TRANSCRIPT_FLAGS = ["transcribed", "is_transcript", "from_voice"];
const flaggedVoice = (m: Obj): boolean => TRANSCRIPT_FLAGS.some((k) => truthy(m[k]));

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
          buttonId = str(obj(obj(m.interactive)?.button_reply)?.id);
          via = buttonId ? "button" : "other";
        }
        out.push({ id, from: sender(m.from), timestamp: when(m.timestamp), via, ...(text === undefined ? {} : { text }), ...(buttonId === undefined ? {} : { buttonId }) });
      }
    }
  }
  return out;
}

function fromGeneric(spec: WebhookSpec, body: Obj): InboundMessage[] {
  const f = spec.fields as FieldPointers;
  if (spec.only_when && str(pointer(body, spec.only_when.path)) !== spec.only_when.equals) return [];
  const raw = spec.messages_path ? pointer(body, spec.messages_path) : [body];
  if (!Array.isArray(raw)) return [];
  const out: InboundMessage[] = [];
  for (const item of raw) {
    if (obj(item) === undefined) continue;
    const id = str(pointer(item, f.message_id));
    if (!id) throw new WebhookParseError("message has no id");
    const kind = (str(pointer(item, f.media_type)) ?? str(pointer(item, f.message_type)) ?? "").toLowerCase();
    const isIn = (list: string[]) => list.some((t) => t.toLowerCase() === kind);
    const typedText = str(pointer(item, f.text));
    const buttonId = str(pointer(item, f.button_id));
    let via: Via = "other";
    let text: string | undefined;
    if (isIn(spec.type_map.audio)) {
      via = "voice";
      text = str(pointer(item, f.transcript)) ?? typedText;
    } else if (isIn(spec.type_map.button)) {
      via = buttonId ? "button" : "other";
    } else if (isIn(spec.type_map.text)) {
      via = "typed";
      text = typedText;
    }
    // a transcript is never a typed command, whatever type the relay gave it
    if (truthy(pointer(item, f.is_transcription))) via = "voice";
    out.push({ id, from: sender(pointer(item, f.sender_phone)), timestamp: when(pointer(item, f.timestamp)), via, ...(text === undefined ? {} : { text }), ...(buttonId === undefined ? {} : { buttonId }) });
  }
  return out;
}

export function parseWebhook(spec: WebhookSpec, body: unknown): InboundMessage[] {
  const root = obj(body);
  if (!root) throw new WebhookParseError("webhook body is not a JSON object");
  return spec.provider === "cloud_api" ? fromCloud(root) : fromGeneric(spec, root);
}
