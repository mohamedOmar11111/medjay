import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { ContextStore } from "../../context/store.js";
import { loadPolicy, PolicySchema } from "../../shield/policy.js";
import { initWorkspace } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { contextTools } from "./context-update.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-ctxtool-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OFFERS = "---\nworkspace: ws\n---\n# Offers\n\nUmrah 7 nights, 4200 SAR.\n";
const ledgerPath = () => join(dir, ".medjay", "audit-log.jsonl");
const events = async () => (await readFile(ledgerPath(), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string; actor: string; payload: Record<string, unknown> });

async function setup(policyText?: (p: Awaited<ReturnType<typeof loadPolicy>>) => unknown) {
  const loaded = await loadPolicy(dir);
  const policy = policyText ? PolicySchema.parse(policyText(loaded)) : loaded;
  const ledger = new Ledger(ledgerPath());
  const store = new ContextStore(dir, { audit: async ({ event, author, ...payload }) => void (await ledger.append({ actor: String(author), event: String(event), payload })) });
  const registry = new ToolRegistry({ policy, ledger });
  for (const tool of contextTools(store)) registry.register(tool);
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports"), client: "ws" });
  return { registry, run: (extra: { approveAsk?: boolean } = {}) => ({ runId: "run_1", step: 1, scope, ...extra }) };
}

const call = { name: "context_update", input: { file: "offer-matrix", text: OFFERS, reason: "owner gave the offers" } };

describe("context_update", () => {
  it("is one tool of its own class, so a person sees it is not a read", async () => {
    const { registry } = await setup();
    expect(registry.specs()).toEqual([expect.objectContaining({ name: "context_update", class: "context" })]);
  });

  it("is on the ask list in a new workspace's policy, written out and not just by default", async () => {
    const policy = await loadPolicy(dir);
    expect(policy.rules).toContainEqual(expect.objectContaining({ action: "context.*", effect: "ask" }));
  });

  it("waits for a person: with no approval nothing is written", async () => {
    const { registry, run } = await setup();
    const before = await readFile(join(dir, "context", "offer-matrix.md"), "utf8");
    const out = await registry.invoke(call, run());
    expect(out).toMatchObject({ ok: false, error: { kind: "approval_required" } });
    expect(await readFile(join(dir, "context", "offer-matrix.md"), "utf8")).toBe(before);
  });

  it("still waits when someone edits the policy to allow it: engine code, not config, decides", async () => {
    const { registry, run } = await setup((p) => ({ ...p, rules: [...p.rules, { action: "context.*", resource: "*", effect: "allow" }] }));
    expect(await registry.invoke(call, run())).toMatchObject({ ok: false, error: { kind: "approval_required" } });
    expect(await readFile(join(dir, "context", "offer-matrix.md"), "utf8")).not.toContain("Umrah");
  });

  it("is refused outright when the policy denies it", async () => {
    const { registry, run } = await setup((p) => ({ ...p, rules: [...p.rules, { action: "context.*", resource: "*", effect: "deny" }] }));
    expect(await registry.invoke(call, run({ approveAsk: true }))).toMatchObject({ ok: false, error: { kind: "denied" } });
  });

  it("with the person's approval writes the file, keeps the old text and logs the change by hash", async () => {
    const { registry, run } = await setup();
    const out = await registry.invoke(call, run({ approveAsk: true }));
    expect(out).toMatchObject({ ok: true, trust: "trusted", output: { file: "offer-matrix", saved: true, version: 1 } });
    expect(await readFile(join(dir, "context", "offer-matrix.md"), "utf8")).toBe(OFFERS);
    const log = await events();
    const updated = log.find((e) => e.event === "context.updated");
    expect(updated).toMatchObject({ actor: "agent:run_1" });
    expect(updated?.payload).toMatchObject({ file: "offer-matrix", version: 1, reason: "owner gave the offers" });
    expect(log.find((e) => e.event === "tool.invoked" && e.payload.tool === "context_update" && e.payload.ok === true)?.payload).toMatchObject({ decision: "approved_once", class: "context" });
    expect(JSON.stringify(log)).not.toContain("Umrah");
  });

  it("the approval covers one call, not the next", async () => {
    const { registry, run } = await setup();
    await registry.invoke(call, run({ approveAsk: true }));
    expect(await registry.invoke({ ...call, input: { ...call.input, text: `${OFFERS}\nMore.\n` } }, run())).toMatchObject({ ok: false, error: { kind: "approval_required" } });
  });

  it("returns a bad value to the model as an error to fix, and writes nothing", async () => {
    const { registry, run } = await setup();
    const bad = "---\ncurrency: SAR\ncpc: 2\n---\n# x\n";
    const out = await registry.invoke({ name: "context_update", input: { file: "unit-economics", text: bad, reason: "r" } }, run({ approveAsk: true }));
    expect(out).toMatchObject({ ok: false, error: { kind: "failed" } });
    expect(JSON.stringify(out)).toMatch(/bare number|low and high/);
    expect(await readFile(join(dir, "context", "unit-economics.md"), "utf8")).toContain("note: cost per click");
  });

  it("cannot be pointed at any file but the four (every odd name is refused before anything runs)", async () => {
    const { registry, run } = await setup();
    const names = ["../workspace", "workspace.yaml", "shield.policy.yaml", "/etc/passwd", "C:\\x", "context/claims", "claims.md", "Claims", "seasonal-calendar", "offer-matrix/../../workspace", "", "offer-matrix\0"];
    for (const file of names) {
      const out = await registry.invoke({ name: "context_update", input: { file, text: OFFERS, reason: "r" } }, run({ approveAsk: true }));
      expect(out, file).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    }
    expect(await readFile(join(dir, "workspace.yaml"), "utf8")).not.toContain("Umrah");
  });

  it("refuses unknown fields, a missing reason and text over 20 KB", async () => {
    const { registry, run } = await setup();
    const base = { file: "offer-matrix", text: OFFERS, reason: "r" };
    for (const input of [{ ...base, path: "x" }, { file: base.file, text: base.text }, { ...base, text: "a".repeat(20_001) }, { ...base, reason: "" }]) {
      expect(await registry.invoke({ name: "context_update", input }, run({ approveAsk: true }))).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    }
  });
});
