import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { checkPolicy, evaluateRules, type PolicyAction } from "./evaluate.js";
import { hashE164, loadPolicy, PolicyError, PolicySchema, type Policy } from "./policy.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-policy-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const policy = (over: Record<string, unknown> = {}): Policy =>
  PolicySchema.parse({
    defaults: { effect: "ask" },
    limits: { max_daily_budget_increase_pct: 20, max_daily_budget_decrease_pct: 100 },
    forbidden_actions: ["delete_campaign"],
    require_two_step_if: { daily_spend_delta_abs_gte: 500, irreversible: true },
    rules: [
      { action: "read.*", resource: "*", effect: "allow" },
      { action: "plan.strike", resource: "*", effect: "ask" },
    ],
    ...over,
  });

const budget = (id: string, from: number, to: number, over: Partial<PolicyAction> = {}): PolicyAction => ({
  id,
  type: "budget_change",
  target: { platform: "meta", kind: "adset", id: `as${id}` },
  from,
  to,
  currency: "USD",
  irreversible: false,
  ...over,
});

describe("loadPolicy and PolicySchema", () => {
  it("loads the policy that `mdj init` generates", async () => {
    const dir = join(root, "ws");
    await initWorkspace({ dir, id: "ws", businessType: "agency" });
    const loaded = await loadPolicy(dir);
    expect(loaded.limits.max_daily_budget_increase_pct).toBe(20);
    expect(loaded.whatsapp.approvers).toEqual([]);
    expect(loaded.forbidden_actions).toContain("send_message_to_customers");
  });

  it("rejects unknown keys, bad effects and a missing file", async () => {
    expect(PolicySchema.safeParse({ ...policy(), mystery: 1 }).success).toBe(false);
    expect(PolicySchema.safeParse({ defaults: { effect: "maybe" } }).success).toBe(false);
    await expect(loadPolicy(root)).rejects.toThrow(/shield\.policy\.yaml/);
  });

  it("rejects a raw phone number anywhere and keeps it out of the error text", async () => {
    const dir = join(root, "ws");
    await initWorkspace({ dir, id: "ws", businessType: "agency" });
    const path = join(dir, "shield.policy.yaml");
    const doc = parse(await readFile(path, "utf8"));
    doc.whatsapp.approvers = [{ name: "owner", sender: { sha256: "+201000000000" }, can: ["strike"] }];
    await writeFile(path, stringify(doc));
    const error = (await loadPolicy(dir).catch((e) => e)) as PolicyError;
    expect(error).toBeInstanceOf(PolicyError);
    expect(error.message).not.toContain("+201000000000");
    expect(error.issues.some((i) => /phone/i.test(i.message))).toBe(true);
  });

  it("identifies approvers by exactly one of sha256, env or keychain_ref", () => {
    const approver = (sender: unknown) =>
      PolicySchema.safeParse({ ...policy(), whatsapp: { approvers: [{ name: "o", sender, can: ["strike", "query"] }] } }).success;
    expect(approver({ sha256: "a".repeat(64) })).toBe(true);
    expect(approver({ env: "MEDJAY_OWNER_NUMBER" })).toBe(true);
    expect(approver({ keychain_ref: "owner_number" })).toBe(true);
    expect(approver({ sha256: "A".repeat(64) })).toBe(false);
    expect(approver({ sha256: "abc" })).toBe(false);
    expect(approver({ env: "OWNER_NUMBER" })).toBe(false);
    expect(approver({ sha256: "a".repeat(64), env: "MEDJAY_X" })).toBe(false);
    expect(approver({})).toBe(false);
  });

  it("limits approver permissions to known commands", () => {
    const can = (c: unknown) =>
      PolicySchema.safeParse({ ...policy(), whatsapp: { approvers: [{ name: "o", sender: { env: "MEDJAY_O" }, can: c }] } }).success;
    expect(can(["strike", "hold", "cap", "query", "drop"])).toBe(true);
    expect(can(["delete_everything"])).toBe(false);
    expect(can([])).toBe(false);
  });

  it("validates the spend cap currency and period", () => {
    const cap = (c: Record<string, unknown>) =>
      PolicySchema.safeParse({ ...policy(), limits: { max_total_spend_cap: { amount: 100, currency: "USD", period: "day", scope: "workspace", ...c } } }).success;
    expect(cap({})).toBe(true);
    expect(cap({ currency: "ZZZ" })).toBe(false);
    expect(cap({ period: "year" })).toBe(false);
    expect(cap({ amount: 0 })).toBe(false);
  });
});

describe("hashE164", () => {
  it("hashes a normalized E.164 number to a stable lowercase SHA-256", () => {
    const hash = hashE164("+201000000000");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashE164("+201000000000")).toBe(hash);
    expect(hashE164("+201000000001")).not.toBe(hash);
  });

  it("rejects anything that is not an E.164 number", () => {
    for (const bad of ["201000000000", "+0123456789", "+12", "01000000000", "+20 100 000 0000", ""]) {
      expect(() => hashE164(bad), bad).toThrow(/E\.164/);
    }
  });
});

describe("evaluateRules", () => {
  const rules = [
    { action: "read.*", resource: "*", effect: "allow" as const },
    { action: "write.*", resource: "client:read-only", effect: "deny" as const },
    { action: "write.budget_change", resource: "meta:*", effect: "ask" as const },
  ];

  it("applies the last matching rule", () => {
    expect(evaluateRules(rules, "read.metrics", "meta:adset/1", "ask")).toBe("allow");
    expect(evaluateRules(rules, "write.budget_change", "meta:adset/1", "deny")).toBe("ask");
  });

  it("falls back to the default effect when nothing matches", () => {
    expect(evaluateRules(rules, "plan.strike", "x", "ask")).toBe("ask");
    expect(evaluateRules([], "anything", "anything", "deny")).toBe("deny");
  });

  it("matches wildcards on both action and resource without treating other characters as patterns", () => {
    expect(evaluateRules(rules, "write.status_change", "client:read-only", "allow")).toBe("deny");
    expect(evaluateRules([{ action: "a.b", resource: "x+y", effect: "deny" }], "aXb", "x+y", "allow")).toBe("allow");
    expect(evaluateRules([{ action: "a.b", resource: "x+y", effect: "deny" }], "a.b", "x+y", "allow")).toBe("deny");
  });
});

describe("checkPolicy: budget limits", () => {
  it("allows an increase exactly at the limit and blocks one just above it", () => {
    expect(checkPolicy(policy(), { actions: [budget("1", 100, 120)] }).status).toBe("pass");
    const over = checkPolicy(policy(), { actions: [budget("1", 100, 121)] });
    expect(over.status).toBe("fail");
    expect(over.checks.find((c) => !c.ok)).toMatchObject({ rule: "max_daily_budget_increase_pct", action_id: "1", limit: 20 });
  });

  it("is not fooled by floating point at the boundary", () => {
    expect(checkPolicy(policy(), { actions: [budget("1", 95.5, 114.6)] }).status).toBe("pass");
  });

  it("allows large decreases by default and enforces a decrease limit when set", () => {
    expect(checkPolicy(policy(), { actions: [budget("1", 95, 35)] }).status).toBe("pass");
    const strict = policy({ limits: { max_daily_budget_increase_pct: 20, max_daily_budget_decrease_pct: 50 } });
    expect(checkPolicy(strict, { actions: [budget("1", 100, 40)] }).status).toBe("fail");
    expect(checkPolicy(strict, { actions: [budget("1", 100, 50)] }).status).toBe("pass");
  });

  it("blocks raising a zero budget (the percentage is unbounded)", () => {
    expect(checkPolicy(policy(), { actions: [budget("1", 0, 10)] }).status).toBe("fail");
  });
});

describe("checkPolicy: forbidden actions and rules", () => {
  it("blocks forbidden action types", () => {
    const result = checkPolicy(policy(), { actions: [{ id: "1", type: "delete_campaign", target: { platform: "google_ads", kind: "campaign", id: "1" }, irreversible: true }] });
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => !c.ok)?.rule).toBe("forbidden_actions");
  });

  it("blocks an action denied by a rule on its resource or client", () => {
    const p = policy({ rules: [{ action: "write.*", resource: "client:read-only", effect: "deny" }] });
    const result = checkPolicy(p, { client: "read-only", actions: [budget("1", 100, 90)] });
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => !c.ok)?.rule).toBe("rules");
  });
});

describe("checkPolicy: spend cap", () => {
  const capped = (extra: Record<string, unknown> = {}) =>
    policy({ limits: { max_daily_budget_increase_pct: 100, max_total_spend_cap: { amount: 1000, currency: "USD", period: "day", scope: "workspace", ...extra } } });

  it("blocks a plan whose projected daily spend exceeds the cap", () => {
    const result = checkPolicy(capped(), { actions: [budget("1", 100, 160)] }, { baselineDailySpend: { amount: 950, currency: "USD" } });
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.rule === "max_total_spend_cap")).toMatchObject({ ok: false, actual: 1010, limit: 1000 });
  });

  it("passes when the projection stays within the cap", () => {
    const result = checkPolicy(capped(), { actions: [budget("1", 100, 160)] }, { baselineDailySpend: { amount: 900, currency: "USD" } });
    expect(result.checks.find((c) => c.rule === "max_total_spend_cap")).toMatchObject({ ok: true, actual: 960 });
  });

  it("reports unknown, never silently passing, without a baseline, for other periods, or across currencies", () => {
    const noBaseline = checkPolicy(capped(), { actions: [budget("1", 100, 120)] });
    expect(noBaseline.checks.find((c) => c.rule === "max_total_spend_cap")).toMatchObject({ ok: null });
    expect(noBaseline.status).toBe("pass");
    const month = checkPolicy(capped({ period: "month" }), { actions: [budget("1", 100, 120)] }, { baselineDailySpend: { amount: 1, currency: "USD" } });
    expect(month.checks.find((c) => c.rule === "max_total_spend_cap")).toMatchObject({ ok: null });
    const sar = checkPolicy(capped(), { actions: [budget("1", 100, 120)] }, { baselineDailySpend: { amount: 1, currency: "SAR" } });
    expect(sar.checks.find((c) => c.rule === "max_total_spend_cap")).toMatchObject({ ok: null });
  });
});

describe("checkPolicy: two-step approval", () => {
  it("requires it when the gross daily change reaches the threshold", () => {
    expect(checkPolicy(policy(), { actions: [budget("1", 1000, 1200), budget("2", 300, 100)] }).two_step_required).toBe(false);
    expect(checkPolicy(policy(), { actions: [budget("1", 1000, 1200), budget("2", 700, 400)] }).two_step_required).toBe(true);
  });

  it("requires it for any irreversible action", () => {
    const irreversible = { id: "1", type: "status_change", target: { platform: "meta", kind: "campaign", id: "1" }, irreversible: true };
    expect(checkPolicy(policy(), { actions: [irreversible] }).two_step_required).toBe(true);
  });

  it("reports the gross and net daily change", () => {
    const result = checkPolicy(policy(), { actions: [budget("1", 100, 120), budget("2", 200, 150)] });
    expect(result.daily_delta).toEqual({ gross: 70, net: -30 });
  });
});
