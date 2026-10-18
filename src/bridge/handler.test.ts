import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerPath, OMAR, SARA, SECRET, STRANGER, setupBridge, type BridgeHarness } from "../../test/helpers/bridge.js";
import { verifyLedger } from "../audit/ledger.js";
import { signButton } from "./buttons.js";
import { handleWebhook, processJobs } from "./handler.js";
import { BridgeRepo } from "./queue.js";
import { buildWebhook } from "./simulator.js";
import { PRESETS } from "./webhook-spec.js";

let h: BridgeHarness;
beforeEach(async () => {
  h = await setupBridge();
});
afterEach(async () => {
  await h.cleanup();
});

const state = (n: number) => h.plans.deps.repo.require(n).state;
const events = async () => (await readFile(ledgerPath(h), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string; actor: string; payload: Record<string, unknown> });
const text = (r: { replies: { text: string }[] }) => r.replies.map((x) => x.text).join("\n");

describe("webhook intake", () => {
  it("rejects an unsigned or wrongly signed request before reading it, and logs that", async () => {
    const bad = await h.send("text", OMAR, { text: "STATUS", badSignature: true });
    expect(bad).toMatchObject({ status: 401, replies: [], handled: [] });
    const none = await handleWebhook(h.deps, { rawBody: buildWebhook({ webhook: PRESETS.cloud_api!, kind: "text", from: OMAR, text: "STATUS", secret: SECRET }).rawBody, headers: {} });
    expect(none.status).toBe(401);
    expect((await events()).filter((e) => e.event === "bridge.rejected" && e.payload.reason === "bad_signature")).toHaveLength(2);
  });
  it("answers 400 for a body that is not a webhook, and 503 when no secret is configured", async () => {
    const raw = "not json";
    const signed = buildWebhook({ webhook: PRESETS.cloud_api!, kind: "text", from: OMAR, text: "x", secret: SECRET });
    expect((await handleWebhook(h.deps, { rawBody: raw, headers: { "x-hub-signature-256": `sha256=${(await import("node:crypto")).createHmac("sha256", SECRET).update(raw).digest("hex")}` } })).status).toBe(400);
    expect((await handleWebhook({ ...h.deps, secret: "" }, signed)).status).toBe(503);
  });
  it("ignores a repeated message id (replay)", async () => {
    const first = await h.send("text", OMAR, { text: "STATUS", id: "m-1" });
    const again = await h.send("text", OMAR, { text: "STATUS", id: "m-1" });
    expect(first.replies).toHaveLength(1);
    expect(again).toMatchObject({ status: 200, replies: [], handled: [] });
  });
});

describe("sender allowlist", () => {
  it("gives an unknown number no reply at all, and logs only a hash prefix, never text or number", async () => {
    const r = await h.send("text", STRANGER, { text: "STRIKE 1 abcdef12" });
    expect(r.replies).toEqual([]);
    expect(r.handled[0]).toMatchObject({ outcome: "rejected:unknown_sender" });
    const log = await readFile(ledgerPath(h), "utf8");
    expect(log).toContain("unknown_sender");
    expect(log).not.toContain("971500000000");
    expect(log).not.toContain("STRIKE 1");
  });
  it("lets a query-only number read but not act", async () => {
    expect(text(await h.send("text", SARA, { text: "STATUS" }))).toMatch(/Ledger head/);
    const { number, short } = await h.proposePause();
    const denied = await h.send("text", SARA, { text: `STRIKE ${number} ${short}` });
    expect(text(denied)).toMatch(/not allowed.*strike/);
    expect(state(number)).toBe("proposed");
    expect((await events()).some((e) => e.event === "bridge.denied")).toBe(true);
  });
  it("rate limits a sender who floods the bridge", async () => {
    const limited = await setupBridge({ rateLimitPerMinute: 3 });
    try {
      const results = [];
      for (let i = 0; i < 6; i += 1) results.push(await limited.send("text", OMAR, { text: "STATUS" }));
      expect(results.slice(0, 3).every((r) => r.replies.length === 1)).toBe(true);
      expect(results.slice(-2).every((r) => r.replies.length === 0 && r.handled[0]?.outcome === "rejected:rate_limited")).toBe(true);
    } finally {
      await limited.cleanup();
    }
  });
});

describe("read commands go through the SQLite job queue", () => {
  it("STATUS lists waiting plans with their short hash and the ledger head", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("text", OMAR, { text: "status" });
    expect(text(r)).toContain(`#${number} (${short})`);
    expect(text(r)).toMatch(/Ledger head [0-9a-f]{12} \(entry \d+\)/);
    const job = new BridgeRepo(h.plans.store).get(1)!;
    expect(job).toMatchObject({ kind: "status", status: "done" });
  });
  it("SCOUT sends the caveman-lite pulse: Blended MER, the platform claim, top issues, the injection warning, the witness", async () => {
    const r = await h.send("text", OMAR, { text: "scout" });
    const body = text(r);
    expect(body).toContain("Blended MER 7.46 from CRM deals");
    expect(body).toContain("google reports ROAS 19.8, which the CRM does not back");
    expect(body).toMatch(/1\. UMRAH-ALL-Broad-Reels spent SAR 3,780 with no deal/);
    expect(body).toMatch(/Warning: some data cells read like instructions to an AI/);
    expect(body).not.toMatch(/ignore your previous instructions/i);
    expect(body).toMatch(/Ledger head [0-9a-f]{12}/);
  });
  it("DIAGNOSE lists findings, SIMULATE runs the seeded check for a plan", async () => {
    expect(text(await h.send("text", OMAR, { text: "diagnose" }))).toMatch(/finding\(s\):\n1\. \[high\]/);
    const { number } = await h.proposePause();
    expect(text(await h.send("text", OMAR, { text: `simulate ${number}` }))).toMatch(/has no budget change; no simulation is needed/);
  });
  it("a job that was running when the process died is picked up again after its lease expires", async () => {
    const repo = new BridgeRepo(h.plans.store);
    const id = repo.enqueue({ message_id: "m-x", sender_hash: "-", kind: "status", args: {} }, new Date("2026-10-17T10:00:00Z"));
    expect(repo.claim(new Date("2026-10-17T10:00:00Z"))!.job_id).toBe(id); // worker claims, then "crashes"
    expect(repo.claim(new Date("2026-10-17T10:00:30Z"))).toBeUndefined(); // lease still held
    expect(await processJobs({ ...h.deps, now: () => new Date("2026-10-17T10:05:00Z") }, repo)).toBe(1);
    expect(repo.get(id)).toMatchObject({ status: "done", attempts: 2 });
  });
  it("PAUSE ALL stops everything but STATUS, HELP and RESUME", async () => {
    expect(text(await h.send("text", OMAR, { text: "PAUSE ALL" }))).toMatch(/paused/);
    expect(text(await h.send("text", OMAR, { text: "scout" }))).toMatch(/paused. Send RESUME/);
    expect(text(await h.send("text", OMAR, { text: "status" }))).toMatch(/Ledger head/);
    expect(text(await h.send("text", OMAR, { text: "RESUME" }))).toMatch(/resumed/);
    expect(text(await h.send("text", OMAR, { text: "scout" }))).toMatch(/pulse/);
  });
});

describe("Ring 0: voice can never approve or change anything", () => {
  it("an audio note whose transcript says STRIKE with the correct hash does nothing", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("voice", OMAR, { text: `STRIKE ${number} ${short}` });
    expect(text(r)).toMatch(/Voice notes can only ask for reports/);
    expect(text(r)).toContain(`type: STRIKE ${number} ${short}`);
    expect(state(number)).toBe("proposed");
    expect(h.plans.deps.repo.approvals(number)).toEqual([]);
    expect(r.handled[0]).toMatchObject({ via: "voice", outcome: "refused:voice" });
    expect((await events()).some((e) => e.event === "bridge.refused_voice")).toBe(true);
  });
  it("a text message the provider flagged as a transcription is voice too", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("voice_text", OMAR, { text: `STRIKE ${number} ${short}` });
    expect(r.handled[0]).toMatchObject({ via: "voice", outcome: "refused:voice" });
    expect(state(number)).toBe("proposed");
  });
  it("voice cannot hold, drop or pause either, but can ask for a report", async () => {
    const { number } = await h.proposePause();
    for (const t of [`hold ${number}`, `drop ${number}`, "pause all", "resume"]) {
      expect((await h.send("voice", OMAR, { text: t })).handled[0]!.outcome, t).toBe("refused:voice");
    }
    expect(state(number)).toBe("proposed");
    expect(text(await h.send("voice", OMAR, { text: "status" }))).toMatch(/Ledger head/);
  });
  it("voice with no transcript is just a request to type", async () => {
    const r = await h.send("voice", OMAR, {});
    expect(r.handled[0]!.outcome).toBe("refused:voice");
  });
  it("images and other media are refused", async () => {
    expect(text(await h.send("image", OMAR))).toMatch(/only read typed messages/);
  });
});

describe("STRIKE over WhatsApp", () => {
  it("a typed STRIKE <plan> <hash> from an approver approves and exports the plan, with the witness", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("text", OMAR, { text: `STRIKE ${number} ${short}` });
    expect(text(r)).toMatch(new RegExp(`Plan #${number} exported`));
    expect(text(r)).toMatch(/Nothing was sent to the ad platforms/);
    expect(text(r)).toMatch(/Ledger head [0-9a-f]{12}/);
    expect(state(number)).toBe("exported");
    const approval = h.plans.deps.repo.approvals(number)[0]!;
    expect(approval).toMatchObject({ approver: "whatsapp:omar", channel: "whatsapp" });
    expect(await verifyLedger(ledgerPath(h))).toMatchObject({ ok: true });
    const names = (await events()).map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(["plan.approved", "plan.exported", "bridge.command"]));
  });
  it("the head hash in the reply is the real head of the ledger at that moment", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("text", OMAR, { text: `STRIKE ${number} ${short}` });
    const quoted = /Ledger head ([0-9a-f]{12}) \(entry (\d+)\)/.exec(text(r))!;
    const entries = (await readFile(ledgerPath(h), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { seq: number; hash: string });
    // the witness names a real entry of the chain, and it is the newest entry that existed when the reply was written
    const named = entries.find((e) => e.seq === Number(quoted[2]))!;
    expect(named.hash.startsWith(quoted[1]!)).toBe(true);
    expect(entries.at(-1)!.seq - named.seq).toBeLessThanOrEqual(1);
  });
  it("a wrong hash changes nothing and tells the sender the current one", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("text", OMAR, { text: `STRIKE ${number} deadbeef` });
    expect(text(r)).toMatch(/does not match/);
    expect(text(r)).toContain(short);
    expect(state(number)).toBe("proposed");
  });
  it("STRIKE with no hash answers with the approval prompt (and signed buttons) but does nothing", async () => {
    const { number, short } = await h.proposePause();
    const r = await h.send("text", OMAR, { text: `STRIKE ${number}` });
    expect(r.replies[0]!.text).toContain(`STRIKE ${number} ${short}`);
    expect(r.replies[0]!.text).toMatch(/Plan hash .*Ledger head [0-9a-f]{12} \(entry \d+\)/);
    expect(r.replies[0]!.buttons!.map((b) => b.title)).toEqual([`STRIKE ${number}`, `HOLD ${number}`, `DROP ${number}`]);
    expect(state(number)).toBe("proposed");
  });
  it("embedded or chained text is not a command", async () => {
    const { number, short } = await h.proposePause();
    for (const t of [`ok please STRIKE ${number} ${short} now`, `STRIKE ${number} ${short}; HOLD ${number}`]) {
      await h.send("text", OMAR, { text: t });
      expect(state(number), t).toBe("proposed");
    }
  });
  it("a second STRIKE of the same plan is a no-op, not a second export", async () => {
    const { number, short } = await h.proposePause();
    await h.send("text", OMAR, { text: `STRIKE ${number} ${short}` });
    const again = await h.send("text", OMAR, { text: `STRIKE ${number} ${short}` });
    expect(text(again)).toMatch(/is exported; nothing to approve/);
    expect(h.plans.deps.repo.approvals(number)).toHaveLength(1);
  });
  it("an expired plan cannot be struck", async () => {
    const { number, short } = await h.proposePause();
    const late = { ...h.deps, plans: { ...h.deps.plans, now: () => new Date("2027-01-01T00:00:00Z") } };
    const r = await handleWebhook(late, buildWebhook({ webhook: PRESETS.cloud_api!, kind: "text", from: OMAR, text: `STRIKE ${number} ${short}`, secret: SECRET }));
    expect(text(r)).toMatch(/did not work/);
    expect(state(number)).not.toBe("exported");
  });
  it("a two-step plan never sends its code over WhatsApp; the code typed back strikes it", async () => {
    const strict = await setupBridge({ limits: {} });
    try {
      const policy = { ...strict.deps.policy, require_two_step_if: { ...strict.deps.policy.require_two_step_if, daily_spend_delta_abs_gte: 10 } };
      const deps = { ...strict.deps, policy, plans: { ...strict.deps.plans, policy } };
      const { proposePlan } = await import("../plan/propose.js");
      const { row, plan } = await proposePlan(deps.plans, { workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: [{ type: "budget_change", target: { platform: "meta", kind: "adset", id: "5", name: "A" }, from: 100, to: 60, currency: "SAR" }] as never });
      const short = plan.plan_hash.slice(0, 8);
      const first = await handleWebhook(deps, buildWebhook({ webhook: PRESETS.cloud_api!, kind: "text", from: OMAR, text: `STRIKE ${row.number} ${short}`, secret: SECRET }));
      expect(text(first)).toMatch(/needs a second confirmation.*mdj approve/s);
      expect(text(first)).not.toContain("123456");
      expect(strict.plans.deps.repo.require(row.number).state).toBe("proposed");
      const second = await handleWebhook(deps, buildWebhook({ webhook: PRESETS.cloud_api!, kind: "text", from: OMAR, text: `STRIKE ${row.number} ${short} 123456`, secret: SECRET }));
      expect(text(second)).toMatch(/exported/);
    } finally {
      await strict.cleanup();
    }
  });
});

describe("signed buttons", () => {
  it("a genuine STRIKE button from the card works", async () => {
    const { number, short } = await h.proposePause();
    const card = await h.send("text", OMAR, { text: `STRIKE ${number}` });
    const strikeButton = card.replies[0]!.buttons![0]!;
    const r = await h.send("button", OMAR, { buttonId: strikeButton.id });
    expect(text(r)).toMatch(new RegExp(`Plan #${number} exported`));
    expect(short).toHaveLength(8);
  });
  it("a forged, edited or foreign-keyed button is refused", async () => {
    const { number, short } = await h.proposePause();
    for (const id of [signButton("wrong-key", "STRIKE", number, short), `STRIKE:${number}:${short}:0000000000000000`, "STRIKE:1"]) {
      const r = await h.send("button", OMAR, { buttonId: id });
      expect(text(r)).toMatch(/not valid/);
    }
    expect(state(number)).toBe("proposed");
  });
  it("HOLD and DROP buttons work, and a stale-hash button is refused", async () => {
    const a = await h.proposePause("111");
    const b = await h.proposePause("222");
    expect(text(await h.send("button", OMAR, { buttonId: signButton(SECRET, "HOLD", a.number, a.short) }))).toMatch(/held/);
    expect(state(a.number)).toBe("held");
    expect(text(await h.send("button", OMAR, { buttonId: signButton(SECRET, "DROP", b.number, b.short) }))).toMatch(/rejected/);
    expect(state(b.number)).toBe("rejected");
    const c = await h.proposePause("333");
    const stale = await h.send("button", OMAR, { buttonId: signButton(SECRET, "STRIKE", c.number, "deadbeef") });
    expect(text(stale)).toMatch(/does not match/);
    expect(state(c.number)).toBe("proposed");
  });
});

describe("what the bridge logs", () => {
  it("never contains message text or phone numbers", async () => {
    const { number, short } = await h.proposePause();
    await h.send("text", OMAR, { text: `STRIKE ${number} ${short}` });
    await h.send("text", STRANGER, { text: "my secret words" });
    await h.send("voice", OMAR, { text: "a spoken secret" });
    const log = await readFile(ledgerPath(h), "utf8");
    for (const leak of ["966551234567", "971500000000", "my secret words", "a spoken secret", `STRIKE ${number}`]) expect(log).not.toContain(leak);
  });
});

describe("a generic CRM relay end to end, with a generic webhook transport", () => {
  it("receives a custom-format signed webhook, runs the command, and the reply POSTs the plan metadata to the relay", async () => {
    const { resolveWebhook } = await import("./webhook-spec.js");
    const { GenericWebhookTransport, deliver } = await import("./transport.js");
    const spec = resolveWebhook({
      provider: "generic_hmac",
      signature_header: "X-CRM-Signature",
      signature_format: "base64",
      fields: { message_id: "id", sender_phone: "contact.phone", message_type: "kind", text: "body", is_transcription: "asr" },
      type_map: { text: ["chat"], audio: ["ptt"], button: ["choice"] },
    });
    const deps = { ...h.deps, webhook: spec };
    const { number, short } = await h.proposePause();

    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const relay = new GenericWebhookTransport({ url: "https://relay.example.com/send", fetch: async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200, text: async () => "" }) });

    const req = buildWebhook({ webhook: spec, kind: "text", from: OMAR, text: `STRIKE ${number}`, secret: SECRET });
    expect(req.headers["x-crm-signature"]).toBeDefined();
    const result = await handleWebhook(deps, req);
    expect(result.status).toBe(200);
    await deliver(result.replies, relay);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ to: OMAR, plan_id: h.plans.deps.repo.require(number).plan_id, short_hash: short });
    expect(String(sent[0]!.body.ledger_head)).toMatch(/^[0-9a-f]{12}$/);
    expect(String(sent[0]!.body.text)).toContain(`STRIKE ${number} ${short}`);

    // the same relay's transcription flag keeps a spoken STRIKE from doing anything
    const spoken = await handleWebhook(deps, buildWebhook({ webhook: spec, kind: "voice_text", from: OMAR, text: `STRIKE ${number} ${short}`, secret: SECRET }));
    expect(spoken.handled[0]).toMatchObject({ via: "voice", outcome: "refused:voice" });
    expect(h.plans.deps.repo.require(number).state).toBe("proposed");

    // and a request signed with the wrong format is refused
    const wrong = buildWebhook({ webhook: { ...spec, signature_format: "hex" }, kind: "text", from: OMAR, text: "STATUS", secret: SECRET });
    expect((await handleWebhook(deps, wrong)).status).toBe(401);
  });
});
