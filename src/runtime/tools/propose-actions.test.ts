import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { DraftStore } from "../../drafts/store.js";
import { loadPolicy } from "../../shield/policy.js";
import { initWorkspace } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { proposePlanActionsTool } from "./propose-actions.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-propose-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup(withDrafts = true) {
  const policy = await loadPolicy(dir);
  const drafts = new DraftStore(dir, { checker: (text) => (text.includes("guaranteed") ? { status: "fail", errors: 1, warnings: 0, rules: ["claims.unverified"] } : { status: "pass", errors: 0, warnings: 0, rules: [] }) });
  const registry = new ToolRegistry({ policy, ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl")) });
  registry.register(proposePlanActionsTool(policy, withDrafts ? drafts : undefined) as never);
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports") });
  return { registry, drafts, run: { runId: "r", step: 1, scope } };
}
type Out = { ok: true; output: { draft_checks?: { index: number; ok: boolean; problem?: string }[]; policy: { status: string }; proposals: unknown[] } } | { ok: false; error: { kind: string; message: string } };
const post = (meta: { version: number; sha256: string }, over: Record<string, unknown> = {}) => ({ type: "publish_post", site: "etlaala-trips", draft: { workflow: "posts", slug: "guide", version: meta.version, sha256: meta.sha256 }, title: "A calm guide", ...over });

describe("propose_plan_actions with a publish_post proposal", () => {
  it("says the proposal is ready when its draft is intact, matching and copy-checked", async () => {
    const { registry, drafts, run } = await setup();
    const meta = await drafts.save({ workflow: "posts", slug: "guide", kind: "post", text: "A calm guide.", author: "agent:r" });
    const r = (await registry.invoke({ name: "propose_plan_actions", input: { proposals: [post(meta)] } }, run)) as Out;
    expect(r).toMatchObject({ ok: true, output: { draft_checks: [{ index: 0, ok: true }], policy: { status: "pass" } } });
  });

  it("tells the agent what is wrong with the draft instead of letting it find out at approval time", async () => {
    const { registry, drafts, run } = await setup();
    const bad = await drafts.save({ workflow: "posts", slug: "guide", kind: "post", text: "A guaranteed result.", author: "agent:r" });
    const r1 = (await registry.invoke({ name: "propose_plan_actions", input: { proposals: [post(bad)] } }, run)) as Out;
    expect(r1).toMatchObject({ ok: true, output: { draft_checks: [{ index: 0, ok: false }] } });
    expect(JSON.stringify(r1)).toMatch(/copy check is fail/);
    const r2 = (await registry.invoke({ name: "propose_plan_actions", input: { proposals: [post({ version: 1, sha256: "e".repeat(64) })] } }, run)) as Out;
    expect(JSON.stringify(r2)).toMatch(/sha256/);
  });

  it("cannot vouch for a draft when there is no drafts store", async () => {
    const { registry, run } = await setup(false);
    const r = (await registry.invoke({ name: "propose_plan_actions", input: { proposals: [post({ version: 1, sha256: "e".repeat(64) })] } }, run)) as Out;
    expect(JSON.stringify(r)).toMatch(/drafts store/);
  });

  it("leaves ad-change proposals alone: no draft checks are added", async () => {
    const { registry, run } = await setup();
    const r = (await registry.invoke({ name: "propose_plan_actions", input: { proposals: [{ type: "add_negative_keywords", target: { platform: "google_ads", kind: "campaign", id: "1", name: "A" }, terms: [{ text: "free", match: "BROAD" }] }] } }, run)) as Out;
    expect(r).toMatchObject({ ok: true });
    expect((r as { output: { draft_checks?: unknown } }).output.draft_checks).toBeUndefined();
  });
});
