import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PolicySchema, hashE164 } from "../shield/policy.js";
import { authorizeSender, permissionFor } from "./auth.js";
import { parseCommand, voiceMayRun } from "./commands.js";
import { parseWebhook, WebhookParseError } from "./parse.js";
import { signButton, verifyButton } from "./buttons.js";
import { signBody, verifySignature } from "./signature.js";
import { buildWebhook } from "./simulator.js";
import { PRESETS, resolveWebhook, WebhookConfigError, type WebhookSpec } from "./webhook-spec.js";

const CLOUD = PRESETS.cloud_api as WebhookSpec;
const RESPOND = PRESETS.respond_io as WebhookSpec;

const OMAR = "+966551234567";
const policy = (approvers: unknown[]) => PolicySchema.parse({ whatsapp: { approvers } });
const approver = (over: Record<string, unknown> = {}) => ({ name: "omar", sender: { sha256: hashE164(OMAR) }, clients: ["*"], can: ["query", "strike", "hold", "drop", "cap"], ...over });

const cloud = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [message] } }] }],
});

describe("parseWebhook: WhatsApp Cloud API", () => {
  it("reads a text message and adds the + to the number", () => {
    const [m] = parseWebhook(CLOUD, cloud({ id: "wamid.1", from: "966551234567", timestamp: "1790000000", type: "text", text: { body: "STATUS" } }));
    expect(m).toEqual({ id: "wamid.1", from: "+966551234567", timestamp: "2026-09-21T14:13:20.000Z", via: "typed", text: "STATUS" });
  });
  it("treats audio as voice, with a transcript only when the provider supplied one", () => {
    const [plain] = parseWebhook(CLOUD, cloud({ id: "w2", from: "966551234567", type: "audio", audio: { id: "media1" } }));
    expect(plain).toMatchObject({ via: "voice" });
    expect(plain!.text).toBeUndefined();
    const [withTranscript] = parseWebhook(CLOUD, cloud({ id: "w3", from: "966551234567", type: "audio", audio: { id: "media1", transcript: "strike 4" } }));
    expect(withTranscript).toMatchObject({ via: "voice", text: "strike 4" });
  });
  it("a text message flagged as a transcription is voice, whatever its type says", () => {
    const [m] = parseWebhook(CLOUD, cloud({ id: "w4", from: "966551234567", type: "text", text: { body: "STRIKE 4 abcd1234" }, transcribed: true }));
    expect(m!.via).toBe("voice");
  });
  it("reads a button reply as a button with its id", () => {
    const [m] = parseWebhook(CLOUD, cloud({ id: "w5", from: "966551234567", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "STRIKE:4:abcd1234:sig", title: "STRIKE" } } }));
    expect(m).toMatchObject({ via: "button", buttonId: "STRIKE:4:abcd1234:sig" });
  });
  it("marks everything else (images, locations) as other, and ignores delivery statuses", () => {
    expect(parseWebhook(CLOUD, cloud({ id: "w6", from: "966551234567", type: "image", image: { id: "x" } }))[0]!.via).toBe("other");
    expect(parseWebhook(CLOUD, { entry: [{ changes: [{ value: { statuses: [{ id: "s1", status: "read" }] } }] }] })).toEqual([]);
  });
  it("rejects a body that is not a webhook, and a message without id or sender", () => {
    expect(() => parseWebhook(CLOUD, "nope")).toThrow(WebhookParseError);
    expect(() => parseWebhook(CLOUD, cloud({ type: "text", text: { body: "x" } }))).toThrow(/id/);
    expect(() => parseWebhook(CLOUD, cloud({ id: "z", from: "not a number", type: "text", text: { body: "x" } }))).toThrow(/sender/);
  });
});

describe("parseWebhook: Respond.io", () => {
  it("reads an inbound text and a voice message", () => {
    const body = (message: Record<string, unknown>) => ({ event_type: "message.received", contact: { phone: "+966551234567" }, message: { messageId: "r1", timestamp: 1790000000000, message: message } });
    expect(parseWebhook(RESPOND, body({ type: "text", text: "HOLD 4" }))[0]).toMatchObject({ id: "r1", from: "+966551234567", via: "typed", text: "HOLD 4" });
    expect(parseWebhook(RESPOND, body({ type: "attachment", attachment: { type: "audio", transcript: "scout" } }))[0]).toMatchObject({ via: "voice", text: "scout" });
  });
  it("ignores events that are not inbound messages", () => {
    expect(parseWebhook(RESPOND, { event_type: "message.sent", contact: { phone: "+1" }, message: {} })).toEqual([]);
  });
});

describe("signatures", () => {
  const secret = "s3cret";
  const body = '{"a":1}';
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  const sigB64 = createHmac("sha256", secret).update(body).digest("base64");
  it("accepts the Cloud API header form and rejects anything else", () => {
    expect(verifySignature(CLOUD, body, { "x-hub-signature-256": `sha256=${sig}` }, secret)).toBe(true);
    expect(verifySignature(CLOUD, body, { "X-Hub-Signature-256": `sha256=${sig}` }, secret)).toBe(true);
    expect(verifySignature(CLOUD, `${body} `, { "x-hub-signature-256": `sha256=${sig}` }, secret)).toBe(false);
    expect(verifySignature(CLOUD, body, {}, secret)).toBe(false);
    expect(verifySignature(CLOUD, body, { "x-hub-signature-256": sig }, secret)).toBe(false);
    expect(verifySignature(CLOUD, body, { "x-hub-signature-256": `sha256=${sig}` }, "")).toBe(false);
  });
  it("any header name and any of the three formats can be configured", () => {
    const hex = { signature_header: "x-crm-signature", signature_format: "hex" as const };
    const b64 = { signature_header: "X-Relay-Sig", signature_format: "base64" as const };
    expect(verifySignature(hex, body, { "X-CRM-Signature": sig }, secret)).toBe(true);
    expect(verifySignature(b64, body, { "x-relay-sig": sigB64 }, secret)).toBe(true);
    expect(verifySignature(hex, body, { "x-crm-signature": sigB64 }, secret)).toBe(false);
    expect(verifySignature(b64, body, { "x-relay-sig": sig }, secret)).toBe(false);
  });
  it("round-trips through signBody for every format and rejects a different secret", () => {
    for (const format of ["hex", "base64", "sha256_prefix"] as const) {
      const spec = { signature_header: "x-any", signature_format: format };
      expect(verifySignature(spec, body, signBody(spec, body, secret), secret)).toBe(true);
      expect(verifySignature(spec, body, signBody(spec, body, "other"), secret)).toBe(false);
    }
  });
});

describe("a generic relay, configured instead of coded", () => {
  const spec = resolveWebhook({
    provider: "generic_hmac",
    signature_header: "X-CRM-Signature",
    signature_format: "base64",
    messages_path: "data.messages",
    fields: { message_id: "id", sender_phone: "wa.number", message_type: "kind", text: "body", is_transcription: "asr", button_id: "choice", timestamp: "ts" },
    type_map: { text: ["chat"], audio: ["ptt"], button: ["choice"] },
  });
  const payload = (m: Record<string, unknown>) => ({ data: { messages: [m] } });
  it("reads typed text, voice, a transcription flag and a button through the pointers", () => {
    expect(parseWebhook(spec, payload({ id: "g1", wa: { number: "966551234567" }, kind: "chat", body: "STATUS", ts: 1790000000 }))[0]).toMatchObject({ id: "g1", from: "+966551234567", via: "typed", text: "STATUS" });
    expect(parseWebhook(spec, payload({ id: "g2", wa: { number: "966551234567" }, kind: "ptt" }))[0]!.via).toBe("voice");
    expect(parseWebhook(spec, payload({ id: "g3", wa: { number: "966551234567" }, kind: "chat", body: "STRIKE 4 abcd1234", asr: true }))[0]!.via).toBe("voice");
    expect(parseWebhook(spec, payload({ id: "g4", wa: { number: "966551234567" }, kind: "choice", choice: "STRIKE:4:abcd1234:sig" }))[0]).toMatchObject({ via: "button", buttonId: "STRIKE:4:abcd1234:sig" });
    expect(parseWebhook(spec, payload({ id: "g5", wa: { number: "966551234567" }, kind: "sticker" }))[0]!.via).toBe("other");
  });
  it("a body that lacks the messages array yields nothing, and a message without an id is an error", () => {
    expect(parseWebhook(spec, { data: {} })).toEqual([]);
    expect(() => parseWebhook(spec, payload({ wa: { number: "966551234567" }, kind: "chat", body: "x" }))).toThrow(WebhookParseError);
  });
  it("does not follow __proto__ pointers", () => {
    const evil = resolveWebhook({ provider: "generic_hmac", signature_header: "x-s", signature_format: "hex", fields: { message_id: "__proto__.id", sender_phone: "from", message_type: "type" } });
    expect(() => parseWebhook(evil, { from: "966551234567", type: "text" })).toThrow(WebhookParseError);
  });
  it("round-trips through the simulator and the signature check", () => {
    const req = buildWebhook({ webhook: spec, kind: "text", from: "+966551234567", text: "STATUS", secret: "k" });
    expect(verifySignature(spec, req.rawBody, req.headers, "k")).toBe(true);
    const parsed = parseWebhook(spec, JSON.parse(req.rawBody));
    expect(parsed[0]).toMatchObject({ from: "+966551234567", via: "typed", text: "STATUS" });
    const voice = parseWebhook(spec, JSON.parse(buildWebhook({ webhook: spec, kind: "voice_text", from: "+966551234567", text: "STRIKE 1 abcd1234", secret: "k" }).rawBody));
    expect(voice[0]!.via).toBe("voice");
  });
  it("needs its signature header, format and the three core pointers, or a preset", () => {
    expect(() => resolveWebhook({ provider: "generic_hmac" })).toThrow(WebhookConfigError);
    expect(() => resolveWebhook({ provider: "generic_hmac", signature_header: "x", signature_format: "hex" })).toThrow(/fields.message_id/);
    expect(() => resolveWebhook({ provider: "generic_hmac", preset: "nope" })).toThrow(/unknown webhook preset/);
    expect(resolveWebhook({ provider: "generic_hmac", preset: "respond_io" }).label).toBe("respond_io");
    expect(resolveWebhook({ provider: "generic_hmac", preset: "respond_io", signature_header: "X-Other" }).signature_header).toBe("x-other");
  });
});

describe("parseCommand", () => {
  it("reads the read commands, case and spacing insensitive", () => {
    expect(parseCommand(" status ")).toEqual({ kind: "status" });
    expect(parseCommand("Pulse")).toEqual({ kind: "pulse" });
    expect(parseCommand("scout")).toEqual({ kind: "scout" });
    expect(parseCommand("DIAGNOSE")).toEqual({ kind: "diagnose" });
    expect(parseCommand("simulate 4")).toEqual({ kind: "simulate", plan: 4 });
    expect(parseCommand("help")).toEqual({ kind: "help" });
  });
  it("strike needs the plan number AND a hash of at least 8 hex characters, and only that", () => {
    expect(parseCommand("STRIKE 4 9162c895")).toEqual({ kind: "strike", plan: 4, hash: "9162c895" });
    expect(parseCommand("strike #04 9162C895")).toEqual({ kind: "strike", plan: 4, hash: "9162c895" });
    expect(parseCommand("STRIKE 4 9162c895 123456")).toEqual({ kind: "strike", plan: 4, hash: "9162c895", code: "123456" });
    expect(parseCommand("STRIKE 4")).toEqual({ kind: "strike_incomplete", plan: 4 });
    expect(parseCommand("STRIKE 4 9162c89")).toMatchObject({ kind: "strike_incomplete" });
    expect(parseCommand("please STRIKE 4 9162c895 thanks")).toMatchObject({ kind: "unknown" });
    expect(parseCommand("STRIKE 4 9162c895; DROP 5")).toMatchObject({ kind: "unknown" });
  });
  it("reads Arabic-Indic digits in plan numbers", () => {
    expect(parseCommand("simulate ٤")).toEqual({ kind: "simulate", plan: 4 });
  });
  it("reads the Arabic read and status aliases, with or without diacritics and hamza forms", () => {
    expect(parseCommand("حالة")).toEqual({ kind: "status" });
    expect(parseCommand("نبض")).toEqual({ kind: "pulse" });
    expect(parseCommand("فحص")).toEqual({ kind: "scout" });
    expect(parseCommand("تشخيص")).toEqual({ kind: "diagnose" });
    expect(parseCommand("إيقاف الكل")).toEqual({ kind: "pause_all" });
    expect(parseCommand("ايقاف  الكل")).toEqual({ kind: "pause_all" });
    expect(parseCommand("حَالَة")).toEqual({ kind: "status" });
    expect(parseCommand("  تشخيص ")).toEqual({ kind: "diagnose" });
  });
  it("the Arabic aliases carry the same permissions as their English commands", () => {
    expect(permissionFor(parseCommand("حالة"))).toBe("query");
    expect(permissionFor(parseCommand("إيقاف الكل"))).toBe("cap");
    expect(voiceMayRun(parseCommand("حالة"))).toBe(true);
    expect(voiceMayRun(parseCommand("إيقاف الكل"))).toBe(false);
  });
  it("STRIKE, HOLD and DROP are strictly ASCII-typed: look-alike letters and Arabic-Indic digits are not commands", () => {
    expect(parseCommand("ＳＴＲＩＫＥ 4 9162c895").kind).toBe("unknown");
    expect(parseCommand("STRIKE ٤ 9162c895").kind).toBe("unknown");
    expect(parseCommand("STRIKE 4 ٩١٦٢c895").kind).toBe("unknown");
    expect(parseCommand("HOLD ٤").kind).toBe("unknown");
    expect(parseCommand("ضربة 4 9162c895").kind).toBe("unknown");
    expect(parseCommand("STRIKE 4 9162c895")).toEqual({ kind: "strike", plan: 4, hash: "9162c895" });
  });
  it("hold, drop, pause and resume", () => {
    expect(parseCommand("HOLD 4")).toEqual({ kind: "hold", plan: 4 });
    expect(parseCommand("DROP 4")).toEqual({ kind: "drop", plan: 4 });
    expect(parseCommand("PAUSE ALL")).toEqual({ kind: "pause_all" });
    expect(parseCommand("RESUME")).toEqual({ kind: "resume" });
  });
  it("anything else is unknown, including empty text and policy-sounding requests", () => {
    for (const t of ["", "   ", "hello", "set max_daily_budget_increase_pct 500", "CAP 4 50"]) expect(parseCommand(t).kind).toMatch(/unknown|cap_unsupported/);
  });
  it("maps each command to the policy permission it needs", () => {
    expect(permissionFor({ kind: "status" })).toBe("query");
    expect(permissionFor({ kind: "simulate", plan: 1 })).toBe("query");
    expect(permissionFor({ kind: "strike", plan: 1, hash: "a".repeat(8) })).toBe("strike");
    expect(permissionFor({ kind: "hold", plan: 1 })).toBe("hold");
    expect(permissionFor({ kind: "drop", plan: 1 })).toBe("drop");
    expect(permissionFor({ kind: "pause_all" })).toBe("cap");
  });
});

describe("authorizeSender", () => {
  const none = { resolve: async () => undefined };
  it("matches a sender by the SHA-256 of the E.164 number", async () => {
    const r = await authorizeSender(policy([approver()]), OMAR, "etlaala", none);
    expect(r).toMatchObject({ ok: true, approver: { name: "omar" } });
  });
  it("rejects an unknown number and a malformed one without throwing", async () => {
    expect(await authorizeSender(policy([approver()]), "+966559999999", "etlaala", none)).toEqual({ ok: false, reason: "unknown_sender" });
    expect(await authorizeSender(policy([approver()]), "00966551234567", "etlaala", none)).toEqual({ ok: false, reason: "malformed_sender" });
  });
  it("respects the client list", async () => {
    const p = policy([approver({ clients: ["etlaala"] })]);
    expect((await authorizeSender(p, OMAR, "etlaala", none)).ok).toBe(true);
    expect(await authorizeSender(p, OMAR, "someone-else", none)).toEqual({ ok: false, reason: "client_not_allowed" });
  });
  it("resolves env and keychain references through the resolver, never from a raw number in a file", async () => {
    const p = policy([approver({ sender: { env: "MEDJAY_OMAR_PHONE" } }), approver({ name: "sara", sender: { keychain_ref: "sara-phone" } })]);
    const resolver = { resolve: async (ref: { env?: string; keychain_ref?: string }) => (ref.env === "MEDJAY_OMAR_PHONE" ? OMAR : ref.keychain_ref === "sara-phone" ? "+201000000000" : undefined) };
    expect(await authorizeSender(p, OMAR, "x", resolver)).toMatchObject({ ok: true, approver: { name: "omar" } });
    expect(await authorizeSender(p, "+201000000000", "x", resolver)).toMatchObject({ ok: true, approver: { name: "sara" } });
  });
  it("an approver whose reference does not resolve matches nobody", async () => {
    expect((await authorizeSender(policy([approver({ sender: { env: "MEDJAY_UNSET" } })]), OMAR, "x", none)).ok).toBe(false);
  });
});

describe("signed buttons", () => {
  const key = "bridge-secret";
  it("verifies a button for the same action, plan and hash", () => {
    const id = signButton(key, "STRIKE", 4, "9162c895");
    expect(verifyButton(key, id)).toEqual({ action: "STRIKE", plan: 4, hash: "9162c895" });
  });
  it("rejects a forged, edited or re-keyed button", () => {
    const id = signButton(key, "STRIKE", 4, "9162c895");
    expect(verifyButton(key, id.replace(":4:", ":5:"))).toBeNull();
    expect(verifyButton(key, id.replace("STRIKE", "DROP"))).toBeNull();
    expect(verifyButton("other", id)).toBeNull();
    expect(verifyButton(key, "STRIKE:4:9162c895:0000000000000000")).toBeNull();
    expect(verifyButton(key, "garbage")).toBeNull();
  });
});
