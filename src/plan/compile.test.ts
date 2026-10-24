import { describe, expect, it } from "vitest";
import { canonicalJsonPretty } from "../audit/canonical.js";
import { PolicySchema, type Policy } from "../shield/policy.js";
import { compilePlan, PlanInputError, serializePlan, verifyPlanHash, type CompileInput } from "./compile.js";

/** Most tests are about other rules, so they run with the simulation gate off unless they say otherwise. */
const withoutSimulationGate = (over: Record<string, unknown>, raw: Record<string, unknown>): Policy => {
  const parsed = PolicySchema.parse(raw);
  const wanted = (over.limits as { require_simulation_for_scale?: boolean } | undefined)?.require_simulation_for_scale;
  return PolicySchema.parse({ ...parsed, limits: { ...parsed.limits, require_simulation_for_scale: wanted ?? false } });
};

const policy = (over: Record<string, unknown> = {}): Policy => withoutSimulationGate(over, {
    limits: { max_daily_budget_increase_pct: 20 },
    forbidden_actions: ["delete_campaign"],
    require_two_step_if: { daily_spend_delta_abs_gte: 500, irreversible: true },
    ...over,
  });

const NOW = new Date("2026-10-17T10:00:00.000Z");

const adset = (id: string, name?: string) => ({ platform: "meta", kind: "adset", id, ...(name ? { name } : {}) });
const campaign = (id: string, name: string) => ({ platform: "google_ads", kind: "campaign", id, name });

const input = (over: Partial<CompileInput> = {}): CompileInput => ({
  workspace: "etlaala-ksa",
  client: "etlaala",
  origin: { job: "diagnose", finding_ids: ["f_12"], tactic_id: "TACTIC-MENA-019", experiment_id: "EXP-088" },
  now: NOW,
  proposals: [
    { type: "budget_change", target: adset("23859102938", "Maldives_Broad"), from: 95, to: 35, currency: "USD" },
    { type: "budget_change", target: adset("23859994110", "KSA_Bookers_LAL"), from: 100, to: 120, currency: "USD" },
    { type: "add_negative_keywords", target: campaign("123", "Brand Search"), terms: [{ text: "free", match: "BROAD" }, { text: "jobs", match: "PHRASE" }] },
    { type: "code_patch", artifact: "patches/PLAN-04-hero-schema.diff" },
  ],
  ...over,
});

describe("compilePlan", () => {
  it("assigns action ids, executors and inverses, and derives preconditions", () => {
    const { plan } = compilePlan(input(), { policy: policy() });
    expect(plan.actions.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(plan.actions[0]).toMatchObject({ type: "budget_change", executor: "export", irreversible: false, inverse: { type: "budget_change", to: 95 } });
    expect(plan.actions[2]).toMatchObject({ inverse: { type: "remove_negative_keywords" } });
    expect(plan.actions[3]).toMatchObject({ type: "code_patch", executor: "patch", deploy: "never_automatic", inverse: { type: "revert_patch" } });
    expect(plan.preconditions).toEqual([
      { entity: "meta:adset/23859102938", field: "daily_budget", expect: 95, currency: "USD" },
      { entity: "meta:adset/23859994110", field: "daily_budget", expect: 100, currency: "USD" },
    ]);
  });

  it("reports the daily spend impact and the policy result", () => {
    const { plan } = compilePlan(input(), { policy: policy() });
    expect(plan.impact_estimate.daily_spend_delta).toEqual({ gross: 80, net: -40, currency: "USD" });
    expect(plan.policy_result).toMatchObject({ status: "pass", two_step_required: false });
    expect(plan.approvals).toEqual([]);
  });

  it("sets expiry 48 hours out by default and honors expiresInHours", () => {
    expect(compilePlan(input(), { policy: policy() }).plan.expires_at).toBe("2026-10-19T10:00:00.000Z");
    expect(compilePlan(input({ expiresInHours: 1 }), { policy: policy() }).plan.expires_at).toBe("2026-10-17T11:00:00.000Z");
  });

  it("is deterministic: identical inputs give byte-identical plan files across runs", () => {
    const runs = [1, 2, 3].map(() => serializePlan(compilePlan(input(), { policy: policy() }).plan));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it("is independent of the key order of the input objects", () => {
    const a = compilePlan(input(), { policy: policy() }).plan;
    const reordered = input({
      proposals: [
        { currency: "USD", to: 35, from: 95, target: adset("23859102938", "Maldives_Broad"), type: "budget_change" },
        { currency: "USD", to: 120, from: 100, target: adset("23859994110", "KSA_Bookers_LAL"), type: "budget_change" },
        { terms: [{ match: "BROAD", text: "free" }, { match: "PHRASE", text: "jobs" }], target: campaign("123", "Brand Search"), type: "add_negative_keywords" },
        { artifact: "patches/PLAN-04-hero-schema.diff", type: "code_patch" },
      ],
    });
    expect(serializePlan(compilePlan(reordered, { policy: policy() }).plan)).toBe(serializePlan(a));
  });

  it("changes the hash and id when the content or the clock changes", () => {
    const base = compilePlan(input(), { policy: policy() }).plan;
    const other = compilePlan(input({ proposals: [{ type: "budget_change", target: adset("1"), from: 10, to: 11, currency: "USD" }] }), { policy: policy() }).plan;
    const later = compilePlan(input({ now: new Date("2026-10-17T10:00:01.000Z") }), { policy: policy() }).plan;
    expect(other.plan_hash).not.toBe(base.plan_hash);
    expect(later.plan_id).not.toBe(base.plan_id);
    expect(base.plan_id).toMatch(/^pl_[0-9a-f]{12}$/);
  });

  it("verifies its own hash, ignores approvals, and detects any edit to an action", () => {
    const { plan } = compilePlan(input(), { policy: policy() });
    expect(verifyPlanHash(plan)).toBe(true);
    const approved = { ...plan, approvals: [{ approver: "owner", channel: "cli", ts: NOW.toISOString(), nonce: "n", plan_hash: plan.plan_hash, signature: "s" }] };
    expect(verifyPlanHash(approved)).toBe(true);
    const edited = structuredClone(plan);
    (edited.actions[0] as { to: number }).to = 400;
    expect(verifyPlanHash(edited)).toBe(false);
    const rehashed = { ...plan, policy_result: { ...plan.policy_result, status: "pass" as const, checks: [] } };
    expect(verifyPlanHash(rehashed)).toBe(false);
  });

  it("reports a policy failure instead of throwing, with the offending action", () => {
    const { plan } = compilePlan(input({ proposals: [{ type: "budget_change", target: adset("1"), from: 100, to: 130, currency: "USD" }] }), { policy: policy() });
    expect(plan.policy_result.status).toBe("fail");
    expect(plan.policy_result.checks.find((c) => c.ok === false)).toMatchObject({ rule: "max_daily_budget_increase_pct", action_id: "a1" });
  });

  it("flags two-step approval from the policy", () => {
    const { plan } = compilePlan(input({ proposals: [{ type: "budget_change", target: adset("1"), from: 3000, to: 3500, currency: "USD" }, { type: "budget_change", target: adset("2"), from: 900, to: 600, currency: "USD" }] }), {
      policy: policy({ limits: { max_daily_budget_increase_pct: 50 } }),
    });
    expect(plan.policy_result.two_step_required).toBe(true);
  });

  it("passes the baseline spend through to the spend-cap check", () => {
    const capped = policy({ limits: { max_daily_budget_increase_pct: 50, max_total_spend_cap: { amount: 1000, currency: "USD", period: "day", scope: "workspace" } } });
    const { plan } = compilePlan(input({ proposals: [{ type: "budget_change", target: adset("1"), from: 100, to: 150, currency: "USD" }] }), { policy: capped, baselineDailySpend: { amount: 980, currency: "USD" } });
    expect(plan.policy_result.status).toBe("fail");
  });
});

describe("compilePlan: input validation", () => {
  const bad = (proposal: Record<string, unknown>) => () => compilePlan(input({ proposals: [proposal as never] }), { policy: policy() });

  it("rejects no-op and malformed changes", () => {
    expect(bad({ type: "budget_change", target: adset("1"), from: 100, to: 100, currency: "USD" })).toThrow(PlanInputError);
    expect(bad({ type: "budget_change", target: adset("1"), from: -1, to: 5, currency: "USD" })).toThrow(PlanInputError);
    expect(bad({ type: "budget_change", target: adset("1"), from: 1, to: 5, currency: "ZZZ" })).toThrow(PlanInputError);
    expect(bad({ type: "status_change", target: adset("1"), from: "PAUSED", to: "PAUSED" })).toThrow(PlanInputError);
    expect(bad({ type: "mystery", target: adset("1") })).toThrow(PlanInputError);
    expect(() => compilePlan(input({ proposals: [] }), { policy: policy() })).toThrow(PlanInputError);
  });

  it("rejects negative keywords that would be dangerous in a spreadsheet and de-duplicates the rest", () => {
    for (const text of ["=SUM(A1)", "+1", "-free", "@cmd", "\tfree", ""]) {
      expect(bad({ type: "add_negative_keywords", target: campaign("1", "C"), terms: [{ text, match: "BROAD" }] }), JSON.stringify(text)).toThrow(PlanInputError);
    }
    const { plan } = compilePlan(input({ proposals: [{ type: "add_negative_keywords", target: campaign("1", "C"), terms: [{ text: "Free", match: "BROAD" }, { text: "free", match: "BROAD" }, { text: "free", match: "PHRASE" }] }] }), { policy: policy() });
    expect((plan.actions[0] as { terms: unknown[] }).terms).toHaveLength(2);
  });

  it("rejects patch artifacts that escape the patches folder", () => {
    for (const artifact of ["../x.diff", "/etc/passwd", "C:\\x.diff", "patches/../../x.diff", "notes/x.diff", ""]) {
      expect(bad({ type: "code_patch", artifact }), artifact).toThrow(PlanInputError);
    }
  });
});

describe("canonicalJsonPretty", () => {
  it("is indented, sorted and parses back to the same data", () => {
    const text = canonicalJsonPretty({ b: [1, { z: 1, a: 2 }], a: "x" });
    expect(text).toBe('{\n  "a": "x",\n  "b": [\n    1,\n    {\n      "a": 2,\n      "z": 1\n    }\n  ]\n}');
    expect(JSON.parse(text)).toEqual({ a: "x", b: [1, { a: 2, z: 1 }] });
  });
});

describe("compilePlan: publish_post (a draft bound to a version and a hash)", () => {
  const HASH = "a".repeat(64);
  const publish = (over: Record<string, unknown> = {}) => ({ type: "publish_post", site: "etlaala-trips", draft: { workflow: "posts", slug: "umrah-guide", version: 2, sha256: HASH }, title: "Umrah in Ramadan: a calm guide", ...over });
  const compile = (proposals: unknown[]) => compilePlan({ workspace: "etlaala-ksa", origin: { job: "content", finding_ids: [] }, now: NOW, proposals: proposals as never }, { policy: policy() }).plan;

  it("compiles to a reviewable action that keeps the draft version and hash, defaulting to a WordPress draft", () => {
    const plan = compile([publish()]);
    expect(plan.actions[0]).toMatchObject({
      id: "a1",
      type: "publish_post",
      site: "etlaala-trips",
      post_status: "draft",
      executor: "export",
      irreversible: false,
      draft: { workflow: "posts", slug: "umrah-guide", version: 2, sha256: HASH },
      inverse: { type: "unpublish_post" },
    });
    expect(verifyPlanHash(plan)).toBe(true);
  });

  it("marks a post that goes live as irreversible (it can be seen before it is taken down), so the two-step rule applies", () => {
    const plan = compile([publish({ post_status: "publish" })]);
    expect(plan.actions[0]).toMatchObject({ post_status: "publish", irreversible: true });
    expect(plan.policy_result.two_step_required).toBe(true);
  });

  it("binds the plan hash to the draft: a different version or hash is a different plan", () => {
    const a = compile([publish()]);
    expect(compile([publish({ draft: { workflow: "posts", slug: "umrah-guide", version: 3, sha256: HASH } })]).plan_hash).not.toBe(a.plan_hash);
    expect(compile([publish({ draft: { workflow: "posts", slug: "umrah-guide", version: 2, sha256: "b".repeat(64) } })]).plan_hash).not.toBe(a.plan_hash);
  });

  it("rejects a bad hash, an unknown status, a site name that is not a name, and fields it does not know", () => {
    for (const bad of [{ draft: { workflow: "posts", slug: "x", version: 1, sha256: "nope" } }, { post_status: "private" }, { site: "My Site!" }, { title: "" }, { title: "line\nbreak" }, { wp_slug: "Not A Slug" }, { extra: 1 }]) {
      expect(() => compile([publish(bad)]), JSON.stringify(bad)).toThrow(PlanInputError);
    }
  });

  it("is judged by the policy as a wordpress post action and can sit beside ad changes in one plan", () => {
    const plan = compile([publish(), { type: "add_negative_keywords", target: campaign("123", "Brand Search"), terms: [{ text: "free", match: "BROAD" }] }]);
    expect(plan.actions.map((a) => a.type)).toEqual(["publish_post", "add_negative_keywords"]);
    expect(plan.policy_result.status).toBe("pass");
    expect(plan.preconditions.every((p) => p.entity.startsWith("google_ads:"))).toBe(true);
  });
});
