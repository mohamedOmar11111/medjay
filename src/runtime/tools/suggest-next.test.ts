import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { loadPolicy } from "../../shield/policy.js";
import { initWorkspace } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { suggestNextTool } from "./suggest-next.js";

let root: string;
let registry: ToolRegistry;
let run: { runId: string; step: number; scope: RunScope };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-suggest-"));
  const dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  registry = new ToolRegistry({ policy: await loadPolicy(dir), ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl")) });
  registry.register(suggestNextTool);
  run = { runId: "run_1", step: 1, scope: await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports") }) };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const act = (n: number) => ({ label: `Option ${n}`, prompt: `Please do option ${n} for me.` });
const call = (input: unknown) => registry.invoke({ name: "suggest_next", input }, run);

describe("suggest_next", () => {
  it("is a read tool with no side effects, and its answer is trusted (it only echoes what the model gave)", async () => {
    expect(registry.specs()).toEqual([expect.objectContaining({ name: "suggest_next", class: "read" })]);
    const out = await call({ actions: [act(1), act(2), act(3)] });
    expect(out).toMatchObject({ ok: true, trust: "trusted", output: { actions: [act(1), act(2), act(3)] } });
  });

  it("takes one, two or three actions and no more", async () => {
    for (const n of [1, 2, 3]) expect(await call({ actions: Array.from({ length: n }, (_, i) => act(i + 1)) }), String(n)).toMatchObject({ ok: true });
    expect(await call({ actions: [] })).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    expect(await call({ actions: [act(1), act(2), act(3), act(4)] })).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
  });

  it("limits a label to 80 characters and a prompt to 300, and neither may be empty", async () => {
    expect(await call({ actions: [{ label: "a".repeat(80), prompt: "b".repeat(300) }] })).toMatchObject({ ok: true });
    expect(await call({ actions: [{ label: "a".repeat(81), prompt: "ok" }] })).toMatchObject({ ok: false });
    expect(await call({ actions: [{ label: "ok", prompt: "b".repeat(301) }] })).toMatchObject({ ok: false });
    expect(await call({ actions: [{ label: "", prompt: "ok" }] })).toMatchObject({ ok: false });
    expect(await call({ actions: [{ label: "ok", prompt: "  " }] })).toMatchObject({ ok: false });
  });

  it("refuses control characters, so a label cannot move the cursor, ring a bell or fake a new line of output", async () => {
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0007b", "a\u001b[2Jb", "a\u0000b", "a\u007fb", "a b"]) {
      expect(await call({ actions: [{ label: bad, prompt: "ok" }] }), JSON.stringify(bad)).toMatchObject({ ok: false });
      expect(await call({ actions: [{ label: "ok", prompt: bad }] }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it("accepts Arabic text and refuses extra fields", async () => {
    expect(await call({ actions: [{ label: "املأ ملف الأرقام", prompt: "اسألني عن تكلفة النقرة وسعر الباقة." }] })).toMatchObject({ ok: true });
    expect(await call({ actions: [{ ...act(1), run: "rm -rf" }] })).toMatchObject({ ok: false });
    expect(await call({ actions: [act(1)], extra: true })).toMatchObject({ ok: false });
  });
});
