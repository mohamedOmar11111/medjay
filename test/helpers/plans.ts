import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/audit/ledger.js";
import type { PlanDeps } from "../../src/plan/propose.js";
import { PlanRepo } from "../../src/plan/repo.js";
import { ensureSigningKey } from "../../src/plan/signing.js";
import { loadPolicy, PolicySchema } from "../../src/shield/policy.js";
import { Store } from "../../src/store/db.js";
import { initWorkspace } from "../../src/workspace/init.js";
import { memoryKeystore } from "./keystore.js";

export const PLAN_NOW = new Date("2026-10-17T10:00:00.000Z");

export interface PlanHarness {
  dir: string;
  deps: PlanDeps;
  store: Store;
  events: () => Promise<{ event: string; actor: string; payload: Record<string, any> }[]>;
  cleanup: () => Promise<void>;
}

/** A fresh workspace with a plan store, ledger, signing key and the default policy (simulation gate on unless overridden). */
export async function setupPlans(limits: Record<string, unknown> = {}): Promise<PlanHarness> {
  const root = await mkdtemp(join(tmpdir(), "medjay-plans-"));
  const dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  await mkdir(join(dir, "plans", "patches"), { recursive: true });
  await writeFile(join(dir, "plans", "patches", "hero.diff"), "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n");
  const store = Store.open(join(dir, ".medjay", "experiments.db"));
  const loaded = await loadPolicy(dir);
  const policy = PolicySchema.parse({ ...loaded, limits: { ...loaded.limits, ...limits } });
  let n = 0;
  const deps: PlanDeps = {
    dir,
    repo: new PlanRepo(store),
    ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl"), { now: () => PLAN_NOW }),
    policy,
    signing: await ensureSigningKey({ dir, workspaceId: "ws", keystore: memoryKeystore(), env: {} }),
    now: () => PLAN_NOW,
    random: { code: () => "123456", nonce: () => `nonce-${(n += 1)}` },
  };
  return {
    dir,
    deps,
    store,
    events: async () => (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)),
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
