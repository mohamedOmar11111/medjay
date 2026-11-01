import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { ProfileStore } from "../../context/profile.js";
import { loadPolicy, PolicySchema } from "../../shield/policy.js";
import { initWorkspace, PLACEHOLDER_NAME } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { profileTools } from "./workspace-profile.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-proftool-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "my-business", name: PLACEHOLDER_NAME, businessType: "ecom" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ledgerPath = () => join(dir, ".medjay", "audit-log.jsonl");
async function setup(rules?: unknown[]) {
  const loaded = await loadPolicy(dir);
  const policy = rules ? PolicySchema.parse({ ...loaded, rules: [...loaded.rules, ...rules] }) : loaded;
  const ledger = new Ledger(ledgerPath());
  const store = new ProfileStore(dir, { audit: async ({ event, author, ...payload }) => void (await ledger.append({ actor: String(author), event: String(event), payload })) });
  const registry = new ToolRegistry({ policy, ledger });
  for (const tool of profileTools(store)) registry.register(tool);
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "my-business", dropzoneDir: join(dir, "data", "imports") });
  return { registry, run: (extra: { approveAsk?: boolean } = {}) => ({ runId: "run_1", step: 1, scope, ...extra }) };
}
const yaml = () => readFile(join(dir, "workspace.yaml"), "utf8");
const input = { name: "Etlaala Travel", business_type: "high_ticket_hybrid", base_currency: "SAR", timezone: "Asia/Riyadh", language: "ar", reason: "owner described the business" };
const call = { name: "workspace_profile", input };

describe("workspace_profile", () => {
  it("is a context-class tool, so it always waits for the owner", async () => {
    const { registry } = await setup();
    expect(registry.specs()).toEqual([expect.objectContaining({ name: "workspace_profile", class: "context" })]);
  });

  it("writes nothing until the owner allows it, even if someone edits the policy to allow", async () => {
    const { registry, run } = await setup([{ action: "context.*", resource: "*", effect: "allow" }]);
    const before = await yaml();
    expect(await registry.invoke(call, run())).toMatchObject({ ok: false, error: { kind: "approval_required" } });
    expect(await yaml()).toBe(before);
  });

  it("with the owner's OK changes the profile and logs which fields, not their values", async () => {
    const { registry, run } = await setup();
    const out = await registry.invoke(call, run({ approveAsk: true }));
    expect(out).toMatchObject({ ok: true, trust: "trusted", output: { saved: true, fields: ["name", "business_type", "base_currency", "timezone", "language"], version: 1 } });
    expect(await yaml()).toContain("name: Etlaala Travel");
    const log = (await readFile(ledgerPath(), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown> });
    expect(log.find((e) => e.event === "workspace.profile_updated")?.payload).toMatchObject({ fields: ["name", "business_type", "base_currency", "timezone", "language"] });
    expect(JSON.stringify(log)).not.toContain("Etlaala");
  });

  it("returns a refused value to the model as an error to fix", async () => {
    const { registry, run } = await setup();
    const out = await registry.invoke({ name: "workspace_profile", input: { ...input, timezone: "Mars/Base" } }, run({ approveAsk: true }));
    expect(out).toMatchObject({ ok: false, error: { kind: "failed" } });
    expect(JSON.stringify(out)).toMatch(/timezone|IANA/i);
    expect(await yaml()).toContain(PLACEHOLDER_NAME);
  });

  it("only the profile fields can be given: nothing else in workspace.yaml, no path, no empty request", async () => {
    const { registry, run } = await setup();
    for (const bad of [
      { reason: "r" },
      { ...input, models: { slots: {} } },
      { ...input, path: "../x" },
      { ...input, business_type: "bakery" },
      { ...input, base_currency: "sar" },
      { ...input, language: "arabic" },
      { ...input, reason: "" },
    ]) {
      expect(await registry.invoke({ name: "workspace_profile", input: bad }, run({ approveAsk: true })), JSON.stringify(bad)).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    }
  });
});
