import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../../audit/ledger.js";
import { loadPolicy } from "../../shield/policy.js";
import { discoverSkills } from "../../skills/discover.js";
import { initWorkspace } from "../../workspace/init.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { skillTools } from "./skills.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-skilltools-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function add(rootDir: string, folder: string, name: string, description: string, body = "Body.") {
  await mkdir(join(rootDir, folder), { recursive: true });
  await writeFile(join(rootDir, folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

async function setup() {
  const hq = join(root, "hq");
  const market = join(root, "market");
  await add(hq, "m09", "gd-m09-email-lifecycle-planner", "Build useful email sequences around a subscriber action.", "Use Read on the brief, then Write the sequence.");
  await add(hq, "e05", "gd-e05-content-brief-writer", "Write an SEO content brief before drafting starts.");
  await add(hq, "m08", "gd-m08-social-content-producer", "Produce a batch of social posts from an approved brief.");
  await add(market, "x", "third-party-skill", "Email subject line tricks from the internet.");
  const discovery = await discoverSkills([
    { path: hq, label: "hq", trust: "owned" },
    { path: market, label: "market", trust: "third_party" },
  ]);
  const policy = await loadPolicy(dir);
  const registry = new ToolRegistry({ policy, ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl")) });
  for (const tool of skillTools(discovery)) registry.register(tool);
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports") });
  return { registry, run: { runId: "run_s", step: 1, scope } };
}

describe("skill tools", () => {
  it("are two read tools", async () => {
    const { registry } = await setup();
    expect(registry.specs().map((s) => `${s.name}:${s.class}`)).toEqual(["skill_load:read", "skill_search:read"]);
  });

  it("skill_search finds by words in the name or description, best first, at most 8, with source and trust", async () => {
    const { registry, run } = await setup();
    const r = (await registry.invoke({ name: "skill_search", input: { query: "email sequence" } }, run)) as { ok: true; output: { matches: { name: string; source: string; trust: string }[] } };
    expect(r.ok).toBe(true);
    expect(r.output.matches[0]).toMatchObject({ name: "gd-m09-email-lifecycle-planner", source: "hq", trust: "owned" });
    expect(r.output.matches.length).toBeLessThanOrEqual(8);
    const none = (await registry.invoke({ name: "skill_search", input: { query: "zzzzqqq" } }, run)) as { output: { matches: unknown[] } };
    expect(none.output.matches).toEqual([]);
  });

  it("skill_load returns the body, the tool dictionary, and trusts only owned skills", async () => {
    const { registry, run } = await setup();
    const owned = (await registry.invoke({ name: "skill_load", input: { name: "gd-m09-email-lifecycle-planner" } }, run)) as { ok: true; trust: string; output: { body: string; dictionary: string; source: string } };
    expect(owned.ok).toBe(true);
    expect(owned.trust).toBe("trusted");
    expect(owned.output.body).toContain("Use Read on the brief");
    expect(owned.output.dictionary).toContain('"Read" = read_file');
    expect(owned.output.source).toBe("hq");
    const third = (await registry.invoke({ name: "skill_load", input: { name: "third-party-skill" } }, run)) as { trust: string };
    expect(third.trust).toBe("untrusted");
  });

  it("skill_load on an unknown name says so and suggests close ones", async () => {
    const { registry, run } = await setup();
    const r = (await registry.invoke({ name: "skill_load", input: { name: "gd-m09-email" } }, run)) as { ok: false; error: { message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/no skill named/);
    expect(r.error.message).toContain("gd-m09-email-lifecycle-planner");
  });
});
