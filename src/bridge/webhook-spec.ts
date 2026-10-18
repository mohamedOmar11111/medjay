// How inbound webhooks look, declared instead of hard-coded. Two providers:
//   cloud_api     Meta's WhatsApp Cloud API: fixed, documented shape and signature scheme.
//   generic_hmac  any CRM or WhatsApp relay that signs its requests with an HMAC-SHA256 of the raw
//                 body: you name the signature header and format, and point at the fields in its JSON.
// A preset fills in a known relay's pointers; anything in the config overrides the preset.
export type SignatureFormat = "hex" | "base64" | "sha256_prefix";

export interface FieldPointers {
  /** Dotted paths into one message object. */
  message_id: string;
  sender_phone: string;
  message_type: string;
  text?: string;
  /** For relays that send attachments as one type with a media type inside. Wins over message_type when present. */
  media_type?: string;
  transcript?: string;
  /** Truthy means the text is a speech-to-text transcript, which makes the message voice. */
  is_transcription?: string;
  button_id?: string;
  timestamp?: string;
}

export interface TypeMap {
  text: string[];
  audio: string[];
  button: string[];
}

export interface WebhookSpec {
  /** Shown in logs: the preset name, or the provider. */
  label: string;
  provider: "cloud_api" | "generic_hmac";
  signature_header: string;
  signature_format: SignatureFormat;
  /** generic: dotted path to an array of messages; absent means the body itself is one message. */
  messages_path?: string;
  /** generic: ignore the request unless the body has this value at this path (for event filters). */
  only_when?: { path: string; equals: string };
  fields?: FieldPointers;
  type_map: TypeMap;
}

export const DEFAULT_TYPE_MAP: TypeMap = {
  text: ["text", "chat", "message"],
  audio: ["audio", "voice", "ptt"],
  button: ["button", "interactive", "button_reply"],
};

export const PRESETS: Record<string, WebhookSpec> = {
  cloud_api: { label: "cloud_api", provider: "cloud_api", signature_header: "x-hub-signature-256", signature_format: "sha256_prefix", type_map: DEFAULT_TYPE_MAP },
  // ASSUMED shape of a Respond.io message.received event; not checked against a live workspace.
  respond_io: {
    label: "respond_io",
    provider: "generic_hmac",
    signature_header: "x-webhook-signature",
    signature_format: "hex",
    only_when: { path: "event_type", equals: "message.received" },
    fields: {
      message_id: "message.messageId",
      sender_phone: "contact.phone",
      message_type: "message.message.type",
      text: "message.message.text",
      media_type: "message.message.attachment.type",
      transcript: "message.message.attachment.transcript",
      is_transcription: "message.message.transcribed",
      timestamp: "message.timestamp",
    },
    type_map: DEFAULT_TYPE_MAP,
  },
};

export interface WebhookConfig {
  provider: "cloud_api" | "generic_hmac";
  preset?: string | undefined;
  signature_header?: string | undefined;
  signature_format?: SignatureFormat | undefined;
  messages_path?: string | undefined;
  only_when?: { path: string; equals: string } | undefined;
  fields?: Partial<FieldPointers> | undefined;
  type_map?: Partial<TypeMap> | undefined;
}

export class WebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

/** Merge a preset (if any) with explicit config into a complete spec, or say what is missing. */
export function resolveWebhook(config: WebhookConfig): WebhookSpec {
  if (config.provider === "cloud_api") {
    const base = PRESETS.cloud_api as WebhookSpec;
    return { ...base, signature_header: config.signature_header ?? base.signature_header, signature_format: config.signature_format ?? base.signature_format };
  }
  const preset = config.preset === undefined ? undefined : PRESETS[config.preset];
  if (config.preset !== undefined && (!preset || preset.provider !== "generic_hmac")) {
    throw new WebhookConfigError(`unknown webhook preset "${config.preset}"; known generic presets: ${Object.keys(PRESETS).filter((k) => PRESETS[k]?.provider === "generic_hmac").join(", ")}`);
  }
  const header = config.signature_header ?? preset?.signature_header;
  const format = config.signature_format ?? preset?.signature_format;
  const fields = { ...(preset?.fields ?? {}), ...(config.fields ?? {}) } as Partial<FieldPointers>;
  const missing = [header ? "" : "signature_header", format ? "" : "signature_format", ...(["message_id", "sender_phone", "message_type"] as const).map((k) => (fields[k] ? "" : `fields.${k}`))].filter(Boolean);
  if (missing.length > 0) throw new WebhookConfigError(`a generic_hmac webhook needs ${missing.join(", ")} (set them, or choose a preset)`);
  const onlyWhen = config.only_when ?? preset?.only_when;
  const messagesPath = config.messages_path ?? preset?.messages_path;
  return {
    label: config.preset ?? "generic_hmac",
    provider: "generic_hmac",
    signature_header: (header as string).toLowerCase(),
    signature_format: format as SignatureFormat,
    ...(messagesPath === undefined ? {} : { messages_path: messagesPath }),
    ...(onlyWhen === undefined ? {} : { only_when: onlyWhen }),
    fields: fields as FieldPointers,
    type_map: { ...DEFAULT_TYPE_MAP, ...(preset?.type_map ?? {}), ...(config.type_map ?? {}) } as TypeMap,
  };
}

type Block = Omit<WebhookConfig, "provider">;

/** The workspace.yaml `command_bridge.whatsapp` provider and webhook block, as one resolved spec. */
export function webhookFromWorkspace(wa: { provider: string; webhook?: Block | undefined }): WebhookSpec {
  const block = wa.webhook ?? {};
  switch (wa.provider) {
    case "cloud_api":
    case "whatsapp_cloud_api":
      return resolveWebhook({ ...block, provider: "cloud_api" });
    case "respond_io_webhook":
      return resolveWebhook({ ...block, provider: "generic_hmac", preset: block.preset ?? "respond_io" });
    case "generic_hmac":
      return resolveWebhook({ ...block, provider: "generic_hmac" });
    default:
      throw new WebhookConfigError(`the provider "${wa.provider}" is not supported by the command bridge`);
  }
}
