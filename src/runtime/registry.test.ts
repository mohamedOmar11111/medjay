import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Ledger, verifyLedger } from "../audit/ledger.js";
import { loadPolicy, PolicySchema, type Policy } from "../shield/policy.js";
import { initWorkspace } from "../workspace/init.js";
import { defineTool, ToolRegistry, type ToolDef } from "./registry.js";
import { RunScope } from "./scope.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-registry-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup(policyOverride?: Policy, client?: string) {
  const policy = policyOverride ?? (await loadPolicy(dir));
  const ledger = new Ledger(join(dir, ".medjay", "audit-log.jsonl"));
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports"), ...(client ? { client } : {}) });
  const registry = new ToolRegistry({ policy, ledger });
  return { registry, ledger, scope, policy, run: { runId: "run_1", step: 1, scope } };
}

const echo = defineTool({
  name: "echo_text",
  description: "Echo text back.",
  class: "read",
  input: z.object({ text: z.string() }).strict(),
  execute: async ({ text }) => ({ text }),
  trustOf: () => "trusted",
});

const events = async () => (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const toolEvents = async () => (await events()).filter((e) => e.event.startsWith("tool."));

describe("register", () => {
  it("accepts a valid tool and lists it with a JSON schema for the model", async () => {
    const { registry } = await setup();
    registry.register(echo);
    const [spec] = registry.specs();
    expect(spec).toMatchObject({ name: "echo_text", class: "read", description: "Echo text back." });
    expect(spec!.input_schema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
  });

  it("rejects duplicate names and badly formed names", async () => {
    const { registry } = await setup();
    registry.register(echo);
    expect(() => registry.register(echo)).toThrow(/already/);
    for (const name of ["Echo", "1abc", "a", "has space", "has-dash"]) {
      expect(() => registry.register({ ...echo, name } as ToolDef), name).toThrow(/name/);
    }
  });

  it("has no write class: only read, draft, propose and context can be registered", async () => {
    const { registry } = await setup();
    for (const cls of ["write", "execute", "strike", "approve", "delete"]) {
      expect(() => registry.register({ ...echo, name: "ok_name", class: cls } as unknown as ToolDef), cls).toThrow(/class/);
    }
    for (const cls of ["read", "draft", "propose", "context"] as const) {
      expect(() => registry.register({ ...echo, name: `tool_${cls}`, class: cls } as ToolDef)).not.toThrow();
    }
  });

  it("rejects names that read like writes, so a mislabelled tool cannot slip in", async () => {
    const { registry } = await setup();
    for (const name of ["write_file", "delete_campaign", "update_budget", "execute_plan", "run_shell", "send_message", "publish_post", "strike_plan", "approve_plan", "apply_patch", "deploy_site", "set_budget", "pause_campaign"]) {
      expect(() => registry.register({ ...echo, name } as ToolDef), name).toThrow(/write|mutat|read like/i);
    }
  });

  it("lists tools sorted by name", async () => {
    const { registry } = await setup();
    registry.register({ ...echo, name: "zeta_tool" } as ToolDef);
    registry.register({ ...echo, name: "alpha_tool" } as ToolDef);
    expect(registry.specs().map((s) => s.name)).toEqual(["alpha_tool", "zeta_tool"]);
  });
});

describe("invoke: lookup and validation", () => {
  it("returns unknown_tool for an unregistered name and logs it", async () => {
    const { registry, run } = await setup();
    const outcome = await registry.invoke({ name: "nope", input: {} }, run);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "unknown_tool" } });
    expect((await toolEvents())[0]).toMatchObject({ event: "tool.invoked", payload: { tool: "nope", ok: false, error_kind: "unknown_tool" } });
  });

  it("validates input strictly, reports paths, and never runs the tool", async () => {
    const { registry, run } = await setup();
    let ran = false;
    registry.register({ ...echo, execute: async () => ((ran = true), {}) } as ToolDef);
    for (const input of [{}, { text: 5 }, { text: "x", extra: 1 }, "string", null]) {
      const outcome = await registry.invoke({ name: "echo_text", input }, run);
      expect(outcome, JSON.stringify(input)).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    }
    expect(ran).toBe(false);
  });

  it("runs a valid call and returns output with trust and timing", async () => {
    const { registry, run } = await setup();
    registry.register(echo);
    const outcome = await registry.invoke({ name: "echo_text", input: { text: "hi" } }, run);
    expect(outcome).toMatchObject({ ok: true, output: { text: "hi" }, trust: "trusted" });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("treats output as untrusted unless the tool says otherwise (fail closed)", async () => {
    const { registry, run } = await setup();
    registry.register({ ...echo, trustOf: undefined } as ToolDef);
    expect(await registry.invoke({ name: "echo_text", input: { text: "hi" } }, run)).toMatchObject({ ok: true, trust: "untrusted" });
  });
});

describe("invoke: permissions from shield.policy.yaml", () => {
  const policyWith = (rules: unknown[], extra: Record<string, unknown> = {}) => PolicySchema.parse({ defaults: { effect: "ask" }, rules, ...extra });

  it("allows what an allow rule covers", async () => {
    const { registry, run } = await setup(policyWith([{ action: "read.*", resource: "*", effect: "allow" }]));
    registry.register(echo);
    expect((await registry.invoke({ name: "echo_text", input: { text: "x" } }, run)).ok).toBe(true);
  });

  it("denies what a deny rule covers, with kind denied, and does not run the tool", async () => {
    const { registry, run } = await setup(policyWith([{ action: "read.*", resource: "*", effect: "allow" }, { action: "read.echo_text", resource: "*", effect: "deny" }]));
    let ran = false;
    registry.register({ ...echo, execute: async () => ((ran = true), {}) } as ToolDef);
    const outcome = await registry.invoke({ name: "echo_text", input: { text: "x" } }, run);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "denied" } });
    expect(ran).toBe(false);
    expect((await toolEvents())[0]).toMatchObject({ event: "tool.denied", payload: { decision: "deny" } });
  });

  it("asks (approval_required) when no rule matches and the default is ask, so the loop can stop for a human", async () => {
    const { registry, run } = await setup(policyWith([]));
    registry.register(echo);
    expect(await registry.invoke({ name: "echo_text", input: { text: "x" } }, run)).toMatchObject({ ok: false, error: { kind: "approval_required" } });
  });

  it("applies rules per client: a deny on client:other does not touch this client", async () => {
    const rules = [{ action: "read.*", resource: "*", effect: "allow" }, { action: "read.*", resource: "client:other", effect: "deny" }];
    const mine = await setup(policyWith(rules), "mine");
    mine.registry.register(echo);
    expect((await mine.registry.invoke({ name: "echo_text", input: { text: "x" } }, mine.run)).ok).toBe(true);
    const other = await setup(policyWith(rules), "other");
    other.registry.register({ ...echo, name: "echo_two" } as ToolDef);
    expect(await other.registry.invoke({ name: "echo_two", input: { text: "x" } }, other.run)).toMatchObject({ ok: false, error: { kind: "denied" } });
  });

  it("evaluates tool-declared resources against the rules", async () => {
    const { registry, run } = await setup(policyWith([{ action: "propose.*", resource: "*", effect: "allow" }, { action: "propose.*", resource: "meta:adset/locked", effect: "deny" }]));
    registry.register(
      defineTool({
        name: "propose_thing",
        description: "x",
        class: "propose",
        input: z.object({ id: z.string() }).strict(),
        resources: ({ id }) => [`meta:adset/${id}`],
        execute: async () => ({}),
        trustOf: () => "trusted",
      }),
    );
    expect((await registry.invoke({ name: "propose_thing", input: { id: "free" } }, run)).ok).toBe(true);
    expect(await registry.invoke({ name: "propose_thing", input: { id: "locked" } }, run)).toMatchObject({ ok: false, error: { kind: "denied" } });
  });

  it("lets a human approve one ask for one call, logged as approved_once, without widening anything", async () => {
    const { registry, scope } = await setup(policyWith([]));
    registry.register(echo);
    const base = { runId: "run_1", step: 1, scope };
    expect(await registry.invoke({ name: "echo_text", input: { text: "x" } }, base)).toMatchObject({ ok: false, error: { kind: "approval_required" } });
    expect((await registry.invoke({ name: "echo_text", input: { text: "x" } }, { ...base, approveAsk: true })).ok).toBe(true);
    expect((await toolEvents()).map((e) => e.payload.decision)).toEqual(["ask", "approved_once"]);
    // the approval was for that call only
    expect(await registry.invoke({ name: "echo_text", input: { text: "x" } }, base)).toMatchObject({ ok: false, error: { kind: "approval_required" } });
  });

  it("never lets a one-time approval override a deny or a forbidden action", async () => {
    const denied = await setup(policyWith([{ action: "read.*", resource: "*", effect: "deny" }]));
    denied.registry.register(echo);
    expect(await denied.registry.invoke({ name: "echo_text", input: { text: "x" } }, { ...denied.run, approveAsk: true })).toMatchObject({ ok: false, error: { kind: "denied" } });
    const forbidden = await setup(policyWith([{ action: "read.*", resource: "*", effect: "allow" }], { forbidden_actions: ["echo_text"] }));
    forbidden.registry.register(echo);
    expect(await forbidden.registry.invoke({ name: "echo_text", input: { text: "x" } }, { ...forbidden.run, approveAsk: true })).toMatchObject({ ok: false, error: { kind: "denied" } });
  });

  it("honors forbidden_actions by tool name", async () => {
    const { registry, run } = await setup(policyWith([{ action: "read.*", resource: "*", effect: "allow" }], { forbidden_actions: ["echo_text"] }));
    registry.register(echo);
    expect(await registry.invoke({ name: "echo_text", input: { text: "x" } }, run)).toMatchObject({ ok: false, error: { kind: "denied" } });
  });
});

describe("invoke: client scope on declared paths", () => {
  const readish = (extra: Partial<ToolDef> = {}) =>
    defineTool({
      name: "peek",
      description: "peek at a file",
      class: "read",
      input: z.object({ path: z.string() }).strict(),
      paths: ({ path }) => [path],
      execute: async ({ path }, ctx) => ({ source: (await ctx.scope.readText(path)).source }),
      trustOf: () => "trusted",
      ...extra,
    } as ToolDef);

  it("refuses a path outside the scope before the tool runs", async () => {
    const { registry, run } = await setup();
    let ran = false;
    registry.register(readish({ execute: async () => ((ran = true), {}) }));
    for (const path of ["../other/context/note.md", ".medjay/audit-log.jsonl", "/etc/passwd", "context/../../x"]) {
      expect(await registry.invoke({ name: "peek", input: { path } }, run), path).toMatchObject({ ok: false, error: { kind: "scope" } });
    }
    expect(ran).toBe(false);
  });

  it("lets the tool read inside the scope through the scoped reader", async () => {
    const { registry, run } = await setup();
    registry.register(readish());
    expect(await registry.invoke({ name: "peek", input: { path: "context/brand-voice.md" } }, run)).toMatchObject({ ok: true, output: { source: "file:context/brand-voice.md" } });
  });

  it("maps a scope error thrown inside the tool to kind scope, not a crash", async () => {
    const { registry, run } = await setup();
    registry.register(readish({ paths: undefined }));
    expect(await registry.invoke({ name: "peek", input: { path: "../x" } }, run)).toMatchObject({ ok: false, error: { kind: "scope" } });
  });
});

describe("invoke: failures, timeouts, output limits", () => {
  it("turns a thrown error into kind failed with a short message and no stack", async () => {
    const { registry, run } = await setup();
    registry.register({ ...echo, execute: async () => { throw new Error("boom ".repeat(200)); } } as ToolDef);
    const outcome = await registry.invoke({ name: "echo_text", input: { text: "x" } }, run);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "failed" } });
    if (!outcome.ok) {
      expect(outcome.error.message.length).toBeLessThanOrEqual(320);
      expect(outcome.error.message).not.toMatch(/\n\s+at /);
    }
  });

  it("times out a tool that never answers and aborts its signal", async () => {
    const { registry, run } = await setup();
    let aborted = false;
    registry.register({
      ...echo,
      timeoutMs: 40,
      execute: (_input: unknown, ctx: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => ((aborted = true), reject(ctx.signal.reason)))),
    } as unknown as ToolDef);
    const started = Date.now();
    expect(await registry.invoke({ name: "echo_text", input: { text: "x" } }, run)).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(aborted).toBe(true);
  });

  it("stops a run-level abort from the caller", async () => {
    const { registry, scope } = await setup();
    registry.register({ ...echo, execute: (_i: unknown, ctx: { signal: AbortSignal }) => new Promise((_r, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))) } as unknown as ToolDef);
    const controller = new AbortController();
    const pending = registry.invoke({ name: "echo_text", input: { text: "x" } }, { runId: "run_1", step: 1, scope, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: "timeout" } });
  });

  it("rejects output that is too large or cannot be serialized", async () => {
    const { registry, run } = await setup();
    registry.register({ ...echo, name: "big_tool", maxOutputBytes: 100, execute: async () => ({ text: "x".repeat(500) }) } as ToolDef);
    expect(await registry.invoke({ name: "big_tool", input: { text: "x" } }, run)).toMatchObject({ ok: false, error: { kind: "failed" } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    registry.register({ ...echo, name: "cyclic_tool", execute: async () => cyclic } as ToolDef);
    expect(await registry.invoke({ name: "cyclic_tool", input: { text: "x" } }, run)).toMatchObject({ ok: false, error: { kind: "failed" } });
  });
});

describe("invoke: every call is written to the ledger", () => {
  it("records tool, class, decision, outcome, resources and an input hash, but never the input or output", async () => {
    const { registry, run } = await setup();
    registry.register(echo);
    await registry.invoke({ name: "echo_text", input: { text: "SUPER-SECRET-TEXT" } }, run);
    const [event] = await toolEvents();
    expect(event.actor).toBe("agent:run_1");
    expect(event.payload).toMatchObject({ run_id: "run_1", step: 1, tool: "echo_text", class: "read", decision: "allow", ok: true });
    expect(event.payload.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(event.payload.output_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain("SUPER-SECRET-TEXT");
  });

  it("logs failures, denials and invalid inputs too, and the chain still verifies", async () => {
    const { registry, run } = await setup();
    registry.register(echo);
    await registry.invoke({ name: "echo_text", input: { bad: true } }, run);
    await registry.invoke({ name: "ghost", input: {} }, run);
    await registry.invoke({ name: "echo_text", input: { text: "ok" } }, run);
    expect((await toolEvents()).map((e) => [e.payload.tool, e.payload.ok])).toEqual([["echo_text", false], ["ghost", false], ["echo_text", true]]);
    expect(await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"))).toMatchObject({ ok: true });
  });

  it("serializes parallel calls into one valid chain", async () => {
    const { registry, run } = await setup();
    registry.register(echo);
    await Promise.all(Array.from({ length: 10 }, (_, i) => registry.invoke({ name: "echo_text", input: { text: String(i) } }, run)));
    expect((await toolEvents()).length).toBe(10);
    expect(await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"))).toMatchObject({ ok: true });
  });
});
