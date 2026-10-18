import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PolicySchema, hashE164 } from "../shield/policy.js";
import { authorizeSender, permissionFor } from "./auth.js";
import { parseCommand } from "./commands.js";
import { parseWebhook, WebhookParseError } from "./parse.js";
import { signButton, verifyButton } from "./buttons.js";
import { signBody, verifySignature } from "./signature.js";

const OMAR = "+966551234567";
const policy = (approvers: unknown[]) => PolicySchema.parse({ whatsapp: { approvers } });
const approver = (over: Record<string, unknown> = {}) => ({ name: "omar", sender: { sha256: hashE164(OMAR) }, clients: ["*"], can: ["query", "strike", "hold", "drop", "cap"], ...over });

const cloud = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [message] } }] }],
});

describe("parseWebhook: WhatsApp Cloud API", () => {
  it("reads a text message and adds the + to the number", () => {
    const [m] = parseWebhook("whatsapp_cloud_api", cloud({ id: "wamid.1", from: "966551234567", timestamp: "1790000000", type: "text", text: { body: "STATUS" } }));
    expect(m).toEqual({ id: "wamid.1", from: "+966551234567", timestamp: "2026-09-21T14:13:20.000Z", via: "typed", text: "STATUS" });
  });
  it("treats audio as voice, with a transcript only when the provider supplied one", () => {
    const [plain] = parseWebhook("whatsapp_cloud_api", cloud({ id: "w2", from: "966551234567", type: "audio", audio: { id: "media1" } }));
    expect(plain).toMatchObject({ via: "voice" });
    expect(plain!.text).toBeUndefined();
    const [withTranscript] = parseWebhook("whatsapp_cloud_api", cloud({ id: "w3", from: "966551234567", type: "audio", audio: { id: "media1", transcript: "strike 4" } }));
    expect(withTranscript).toMatchObject({ via: "voice", text: "strike 4" });
  });
  it("a text message flagged as a transcription is voice, whatever its type says", () => {
    const [m] = parseWebhook("whatsapp_cloud_api", cloud({ id: "w4", from: "966551234567", type: "text", text: { body: "STRIKE 4 abcd1234" }, transcribed: true }));
    expect(m!.via).toBe("voice");
  });
  it("reads a button reply as a button with its id", () => {
    const [m] = parseWebhook("whatsapp_cloud_api", cloud({ id: "w5", from: "966551234567", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "STRIKE:4:abcd1234:sig", title: "STRIKE" } } }));
    expect(m).toMatchObject({ via: "button", buttonId: "STRIKE:4:abcd1234:sig" });
  });
  it("marks everything else (images, locations) as other, and ignores delivery statuses", () => {
    expect(parseWebhook("whatsapp_cloud_api", cloud({ id: "w6", from: "966551234567", type: "image", image: { id: "x" } }))[0]!.via).toBe("other");
    expect(parseWebhook("whatsapp_cloud_api", { entry: [{ changes: [{ value: { statuses: [{ id: "s1", status: "read" }] } }] }] })).toEqual([]);
  });
  it("rejects a body that is not a webhook, and a message without id or sender", () => {
    expect(() => parseWebhook("whatsapp_cloud_api", "nope")).toThrow(WebhookParseError);
    expect(() => parseWebhook("whatsapp_cloud_api", cloud({ type: "text", text: { body: "x" } }))).toThrow(/id/);
    expect(() => parseWebhook("whatsapp_cloud_api", cloud({ id: "z", from: "not a number", type: "text", text: { body: "x" } }))).toThrow(/sender/);
  });
});

describe("parseWebhook: Respond.io", () => {
  it("reads an inbound text and a voice message", () => {
    const body = (message: Record<string, unknown>) => ({ event_type: "message.received", contact: { phone: "+966551234567" }, message: { messageId: "r1", timestamp: 1790000000000, message: message } });
    expect(parseWebhook("respond_io_webhook", body({ type: "text", text: "HOLD 4" }))[0]).toMatchObject({ id: "r1", from: "+966551234567", via: "typed", text: "HOLD 4" });
    expect(parseWebhook("respond_io_webhook", body({ type: "attachment", attachment: { type: "audio", transcript: "scout" } }))[0]).toMatchObject({ via: "voice", text: "scout" });
  });
  it("ignores events that are not inbound messages", () => {
    expect(parseWebhook("respond_io_webhook", { event_type: "message.sent", contact: { phone: "+1" }, message: {} })).toEqual([]);
  });
});

describe("signatures", () => {
  const secret = "s3cret";
  const body = '{"a":1}';
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  it("accepts the Cloud API header form and rejects anything else", () => {
    expect(verifySignature("whatsapp_cloud_api", body, { "x-hub-signature-256": `sha256=${sig}` }, secret)).toBe(true);
    expect(verifySignature("whatsapp_cloud_api", body, { "X-Hub-Signature-256": `sha256=${sig}` }, secret)).toBe(true);
    expect(verifySignature("whatsapp_cloud_api", `${body} `, { "x-hub-signature-256": `sha256=${sig}` }, secret)).toBe(false);
    expect(verifySignature("whatsapp_cloud_api", body, {}, secret)).toBe(false);
    expect(verifySignature("whatsapp_cloud_api", body, { "x-hub-signature-256": sig }, secret)).toBe(false);
    expect(verifySignature("whatsapp_cloud_api", body, { "x-hub-signature-256": `sha256=${sig}` }, "")).toBe(false);
  });
  it("round-trips through signBody for both providers", () => {
    for (const provider of ["whatsapp_cloud_api", "respond_io_webhook"] as const) {
      expect(verifySignature(provider, body, signBody(provider, body, secret), secret)).toBe(true);
      expect(verifySignature(provider, body, signBody(provider, body, "other"), secret)).toBe(false);
    }
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
