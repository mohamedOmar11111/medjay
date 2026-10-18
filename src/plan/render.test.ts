import { describe, expect, it } from "vitest";
import { PolicySchema } from "../shield/policy.js";
import { compilePlan } from "./compile.js";
import { renderPlan } from "./render.js";

const policy = PolicySchema.parse({ limits: { max_daily_budget_increase_pct: 20 }, require_two_step_if: { daily_spend_delta_abs_gte: 50 } });

const plan = compilePlan(
  {
    workspace: "ws",
    origin: { job: "diagnose", finding_ids: ["f_1"], experiment_id: "EXP-088" },
    now: new Date("2026-10-17T10:00:00.000Z"),
    proposals: [
      { type: "budget_change", target: { platform: "meta", kind: "adset", id: "1", name: "Maldives_Broad" }, from: 95, to: 35, currency: "USD" },
      { type: "budget_change", target: { platform: "meta", kind: "adset", id: "2", name: "Bookers" }, from: 100, to: 120, currency: "USD" },
      { type: "status_change", target: { platform: "google_ads", kind: "campaign", id: "3", name: "Brand" }, from: "ENABLED", to: "PAUSED" },
      { type: "add_negative_keywords", target: { platform: "google_ads", kind: "campaign", id: "3", name: "Brand" }, terms: [{ text: "free", match: "BROAD" }] },
      { type: "code_patch", artifact: "patches/hero.diff" },
    ],
  },
  { policy },
).plan;

describe("renderPlan", () => {
  const text = renderPlan(plan, { number: 4, state: "proposed" });

  it("shows the header with number, state, expiry and the full hash", () => {
    expect(text).toContain("PLAN #4");
    expect(text).toContain("[proposed]");
    expect(text).toContain(plan.expires_at);
    expect(text).toContain(plan.plan_hash);
  });

  it("shows each change as a before and after with the percentage", () => {
    expect(text).toMatch(/- daily_budget: 95\.00 USD\s*\n\s*\+ daily_budget: 35\.00 USD\s+\(-63\.2%\)/);
    expect(text).toMatch(/\+ daily_budget: 120\.00 USD\s+\(\+20\.0%\)/);
    expect(text).toMatch(/- status: ENABLED\s*\n\s*\+ status: PAUSED/);
    expect(text).toContain("+ negative [broad]: free");
    expect(text).toMatch(/patches\/hero\.diff.*never deployed/s);
  });

  it("summarizes policy, two-step requirement and daily impact", () => {
    expect(text).toMatch(/policy: PASS/);
    expect(text).toMatch(/two-step approval required/);
    expect(text).toMatch(/gross 80\.00 USD, net -40\.00 USD/);
  });

  it("lists failed and unevaluated checks", () => {
    const failing = compilePlan(
      { workspace: "ws", origin: { job: "x", finding_ids: [] }, now: new Date("2026-10-17T10:00:00.000Z"), proposals: [{ type: "budget_change", target: { platform: "meta", kind: "adset", id: "1" }, from: 100, to: 200, currency: "USD" }] },
      { policy },
    ).plan;
    const out = renderPlan(failing);
    expect(out).toMatch(/policy: FAIL/);
    expect(out).toMatch(/max_daily_budget_increase_pct/);
    expect(out).not.toContain("PLAN #");
  });
});
