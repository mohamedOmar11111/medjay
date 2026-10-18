import { join } from "node:path";
import { diagnose } from "../../src/analysis/diagnose.js";
import { loadUnitEconomics } from "../../src/analysis/simulate.js";
import { handleWebhook, type BridgeDeps, type WebhookResult } from "../../src/bridge/handler.js";
import { buildWebhook, type SimKind } from "../../src/bridge/simulator.js";
import { PRESETS } from "../../src/bridge/webhook-spec.js";
import { proposePlan } from "../../src/plan/propose.js";
import { simulatePlan } from "../../src/plan/simulate-plan.js";
import { hashE164, PolicySchema } from "../../src/shield/policy.js";
import { FIXTURE } from "./ingest.js";
import { PLAN_NOW, setupPlans, type PlanHarness } from "./plans.js";
import { setupScout, type ScoutHarness } from "./scout.js";

export const OMAR = "+966551234567";
export const SARA = "+201000000000";
export const STRANGER = "+971500000000";
export const SECRET = "bridge-test-secret";

export interface BridgeHarness {
  plans: PlanHarness;
  scout: ScoutHarness;
  deps: BridgeDeps;
  send: (kind: SimKind, from: string, extra?: { text?: string; buttonId?: string; id?: string; badSignature?: boolean }) => Promise<WebhookResult>;
  /** A proposed plan that pauses the bleeding ad set (no scale-up, so no simulation needed). */
  proposePause: (id?: string) => Promise<{ number: number; hash: string; short: string }>;
  cleanup: () => Promise<void>;
}

export async function setupBridge(options: { limits?: Record<string, unknown>; rateLimitPerMinute?: number } = {}): Promise<BridgeHarness> {
  const plans = await setupPlans({ require_simulation_for_scale: false, ...(options.limits ?? {}) });
  const scout = await setupScout();
  const policy = PolicySchema.parse({
    ...plans.deps.policy,
    whatsapp: {
      approvers: [
        { name: "omar", sender: { sha256: hashE164(OMAR) }, clients: ["*"], can: ["query", "strike", "hold", "drop", "cap"] },
        { name: "sara", sender: { sha256: hashE164(SARA) }, clients: ["*"], can: ["query"] },
      ],
    },
  });
  const planDeps = { ...plans.deps, policy };
  const economics = await loadUnitEconomics(FIXTURE);
  let tick = 0;
  const deps: BridgeDeps = {
    workspaceId: "ws",
    webhook: PRESETS.cloud_api!,
    secret: SECRET,
    policy,
    ledger: plans.deps.ledger,
    store: plans.store,
    plans: planDeps,
    resolver: { resolve: async () => undefined },
    reads: {
      report: async () => {
        const snapshot = scout.snapshot();
        return { snapshot, diagnosis: diagnose(snapshot) };
      },
      simulate: (planNumber) => simulatePlan(planDeps, plans.store, { planNumber, economics, attach: true, actor: "whatsapp:test" }),
    },
    now: () => new Date(PLAN_NOW.getTime() + (tick += 1000)),
    ...(options.rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute: options.rateLimitPerMinute }),
  };
  return {
    plans,
    scout,
    deps,
    send: (kind, from, extra = {}) => {
      const req = buildWebhook({ webhook: PRESETS.cloud_api!, kind, from, secret: SECRET, ...extra });
      return handleWebhook(deps, req);
    },
    proposePause: async (id = "120200000000001") => {
      const { row, plan } = await proposePlan(planDeps, {
        workspace: "ws",
        origin: { job: "diagnose", finding_ids: [] },
        proposals: [{ type: "status_change", target: { platform: "meta", kind: "adset", id, name: "UMRAH-ALL-Broad-Reels" }, from: "ENABLED", to: "PAUSED" }] as never,
      });
      return { number: row.number, hash: plan.plan_hash, short: plan.plan_hash.slice(0, 8) };
    },
    cleanup: async () => {
      await scout.cleanup();
      await plans.cleanup();
    },
  };
}

export const ledgerPath = (h: BridgeHarness) => join(h.plans.dir, ".medjay", "audit-log.jsonl");
