import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { loadPolicy } from "../../shield/policy.js";
import { initWorkspace } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { MAX_ANSWER_CHARS, MAX_SOURCES, searchTools, type SearchPort, type SearchResult } from "./web-search.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-search-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakePort(result: SearchResult | Error): SearchPort & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function setup(port: SearchPort) {
  const policy = await loadPolicy(dir);
  const registry = new ToolRegistry({ policy, ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl")) });
  for (const tool of searchTools(port)) registry.register(tool);
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports") });
  const call = (input: unknown) => registry.invoke({ name: "web_search", input }, { runId: "run_s", step: 1, scope });
  return { registry, call };
}

const ONE: SearchResult = { answer: "CPL for off-plan real estate in the UAE is often 20-60 USD.", sources: [{ url: "https://example.com/report", title: "Report 2026" }] };

describe("web_search", () => {
  it("is one read tool, so it can change nothing", async () => {
    const { registry } = await setup(fakePort(ONE));
    expect(registry.specs().map((s) => [s.name, s.class])).toEqual([["web_search", "read"]]);
  });

  it("returns the answer with its sources and the date, and marks it untrusted", async () => {
    const port = fakePort(ONE);
    const { call } = await setup(port);
    const r = await call({ query: "average CPL real estate Dubai Meta ads 2026" });
    expect(r).toMatchObject({ ok: true, trust: "untrusted" });
    const out = (r as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({ source: "web_search", query: "average CPL real estate Dubai Meta ads 2026", answer: ONE.answer, sources: ONE.sources });
    expect(typeof out.retrieved_at).toBe("string");
    expect(port.queries).toEqual(["average CPL real estate Dubai Meta ads 2026"]);
  });

  it("keeps only https sources, without duplicates, and at most the limit", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}` }));
    const { call } = await setup(
      fakePort({ answer: "x", sources: [{ url: "http://insecure.example/a" }, { url: "javascript:alert(1)" }, { url: "not a url" }, { url: "https://example.com/0" }, ...many] }),
    );
    const out = ((await call({ query: "something to look up" })) as { output: { sources: { url: string }[] } }).output;
    expect(out.sources.length).toBe(MAX_SOURCES);
    expect(new Set(out.sources.map((s) => s.url)).size).toBe(MAX_SOURCES);
    expect(out.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
  });

  it("says plainly when no source came back, so the model cannot call the figures benchmarks", async () => {
    const { call } = await setup(fakePort({ answer: "Probably around 30 USD.", sources: [] }));
    const out = ((await call({ query: "average CPL real estate Dubai" })) as { output: { sources: unknown[]; note: string } }).output;
    expect(out.sources).toEqual([]);
    expect(out.note).toMatch(/no source/i);
    expect(out.note).toMatch(/my estimate, verify/);
  });

  it("cuts a very long answer", async () => {
    const { call } = await setup(fakePort({ answer: "a".repeat(MAX_ANSWER_CHARS + 500), sources: ONE.sources }));
    const out = ((await call({ query: "long answer please" })) as { output: { answer: string } }).output;
    expect(out.answer.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS + 60);
    expect(out.answer).toMatch(/\[cut/);
  });

  it("refuses queries that are too short, too long, multi-line or carry control characters", async () => {
    const port = fakePort(ONE);
    const { call } = await setup(port);
    for (const query of ["", "ab", "x".repeat(201), "two\nlines here", "bell\u0007 here ok", "line separator"]) {
      expect(await call({ query }), JSON.stringify(query)).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    }
    expect(port.queries).toEqual([]);
  });

  it("never sends a secret or a phone number out in a query", async () => {
    const port = fakePort(ONE);
    const { call } = await setup(port);
    for (const query of ["what is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 used for", "+971501234567"]) {
      const r = await call({ query });
      expect(r, query).toMatchObject({ ok: false });
    }
    expect(port.queries).toEqual([]);
  });

  it("rejects extra fields", async () => {
    const { call } = await setup(fakePort(ONE));
    expect(await call({ query: "valid query here", url: "https://evil.example" })).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
  });

  it("reports a failing search as a failed call, not a made-up answer", async () => {
    const { call } = await setup(fakePort(new Error("search is not available for this model")));
    const r = await call({ query: "valid query here" });
    expect(r).toMatchObject({ ok: false, error: { kind: "failed" } });
    expect((r as { error: { message: string } }).error.message).toMatch(/not available/);
  });
});
