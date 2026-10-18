import { describe, expect, it } from "vitest";
import { CloudApiTransport, ConsoleTransport, deliver, GenericWebhookTransport, type FetchLike } from "./transport.js";
import type { OutboundMessage } from "./types.js";

const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({ to: "+966551234567", text: "Plan #4 needs your approval.", meta: { plan_id: "pl_0123456789ab", short_hash: "9162c895", ledger_head: "53aa353a1991" }, ...over });

function fakeFetch(status = 200, body = "{}") {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fn, calls };
}

describe("ConsoleTransport", () => {
  it("prints the message and the buttons, and succeeds", async () => {
    const out: string[] = [];
    const r = await new ConsoleTransport((s) => out.push(s)).send(msg({ buttons: [{ id: "STRIKE:4:9162c895:abc", title: "STRIKE 4" }] }));
    expect(r).toEqual({ ok: true, detail: "printed" });
    expect(out.join("\n")).toMatch(/Plan #4 needs your approval/);
    expect(out.join("\n")).toMatch(/\[STRIKE 4\]/);
  });
});

describe("GenericWebhookTransport", () => {
  it("POSTs { to, text, plan_id, short_hash, ledger_head } as JSON to the configured URL", async () => {
    const f = fakeFetch();
    const r = await new GenericWebhookTransport({ url: "https://relay.example.com/hook", fetch: f.fn }).send(msg());
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://relay.example.com/hook");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0]!.init.body)).toEqual({ to: "+966551234567", text: "Plan #4 needs your approval.", plan_id: "pl_0123456789ab", short_hash: "9162c895", ledger_head: "53aa353a1991" });
  });
  it("sends null for fields a message does not have, includes buttons when present, and adds a bearer token only when given", async () => {
    const f = fakeFetch();
    await new GenericWebhookTransport({ url: "https://relay.example.com/hook", token: "tok", fetch: f.fn }).send({ to: "+201000000000", text: "hi", buttons: [{ id: "x", title: "OK" }] });
    expect(f.calls[0]!.init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(f.calls[0]!.init.body)).toMatchObject({ plan_id: null, short_hash: null, ledger_head: null, buttons: [{ id: "x", title: "OK" }] });
    const g = fakeFetch();
    await new GenericWebhookTransport({ url: "https://relay.example.com/hook", fetch: g.fn }).send(msg());
    expect(g.calls[0]!.init.headers.authorization).toBeUndefined();
  });
  it("refuses a non-https URL", () => {
    expect(() => new GenericWebhookTransport({ url: "http://relay.example.com/hook", fetch: fakeFetch().fn })).toThrow(/https/);
  });
  it("reports a failure instead of throwing, without echoing the token", async () => {
    const down: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED while using token tok-secret");
    };
    const r = await new GenericWebhookTransport({ url: "https://relay.example.com/hook", token: "tok-secret", fetch: down }).send(msg());
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain("tok-secret");
    const bad = await new GenericWebhookTransport({ url: "https://relay.example.com/hook", fetch: fakeFetch(500).fn }).send(msg());
    expect(bad).toMatchObject({ ok: false, status: 500 });
  });
});

describe("CloudApiTransport", () => {
  const make = (f: ReturnType<typeof fakeFetch>) => new CloudApiTransport({ phoneNumberId: "1234567890", token: "EAAtoken", version: "v21.0", fetch: f.fn });
  it("sends a text message to the Graph API with a bearer token and the number without +", async () => {
    const f = fakeFetch();
    const r = await make(f).send(msg());
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.url).toBe("https://graph.facebook.com/v21.0/1234567890/messages");
    expect(f.calls[0]!.init.headers.authorization).toBe("Bearer EAAtoken");
    expect(JSON.parse(f.calls[0]!.init.body)).toEqual({ messaging_product: "whatsapp", to: "966551234567", type: "text", text: { body: "Plan #4 needs your approval." } });
  });
  it("sends the card as text, then the buttons as a second interactive message, with titles cut to 20 characters", async () => {
    const f = fakeFetch();
    await make(f).send(msg({ buttons: [{ id: "STRIKE:4:9162c895:aaaaaaaaaaaaaaaa", title: "STRIKE 4" }, { id: "HOLD:4:9162c895:bbbbbbbbbbbbbbbb", title: "A very long button title here" }] }));
    expect(f.calls).toHaveLength(2);
    const second = JSON.parse(f.calls[1]!.init.body);
    expect(second.type).toBe("interactive");
    expect(second.interactive.action.buttons).toEqual([
      { type: "reply", reply: { id: "STRIKE:4:9162c895:aaaaaaaaaaaaaaaa", title: "STRIKE 4" } },
      { type: "reply", reply: { id: "HOLD:4:9162c895:bbbbbbbbbbbbbbbb", title: "A very long button t" } },
    ]);
  });
  it("cuts a text longer than the 4096-character limit and says so", async () => {
    const f = fakeFetch();
    await make(f).send(msg({ text: "x".repeat(5000) }));
    const body = JSON.parse(f.calls[0]!.init.body).text.body as string;
    expect(body.length).toBeLessThanOrEqual(4096);
    expect(body).toMatch(/continues on your computer/);
  });
  it("returns ok false with the Graph error status, and never the token", async () => {
    const r = await make(fakeFetch(401, '{"error":{"message":"Invalid OAuth access token EAAtoken"}}')).send(msg());
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(r.detail).not.toContain("EAAtoken");
  });
  it("validates its configuration", () => {
    expect(() => new CloudApiTransport({ phoneNumberId: "abc", token: "t", version: "v21.0", fetch: fakeFetch().fn })).toThrow(/phone number id/);
    expect(() => new CloudApiTransport({ phoneNumberId: "1234567890", token: "", version: "v21.0", fetch: fakeFetch().fn })).toThrow(/token/);
  });
});

describe("deliver", () => {
  it("sends every reply, stops nobody on a failure, and returns the results", async () => {
    const sent: string[] = [];
    let n = 0;
    const flaky = { kind: "console" as const, send: async (m: OutboundMessage) => (sent.push(m.text), (n += 1) === 1 ? { ok: false, detail: "boom" } : { ok: true }) };
    const results = await deliver([msg({ text: "a" }), msg({ text: "b" })], flaky);
    expect(sent).toEqual(["a", "b"]);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
  });
});
