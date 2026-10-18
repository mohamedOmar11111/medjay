import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryKeystore } from "../../test/helpers/keystore.js";
import { Ledger } from "../audit/ledger.js";
import { loadPolicy, PolicySchema, type Policy } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { initWorkspace } from "../workspace/init.js";
import { approvePlan } from "./approve.js";
import { compilePlan } from "./compile.js";
import { currencyExponent, toMinorUnits } from "./currency.js";
import { buildMetaMutations, exportPlan } from "./export.js";
import { proposePlan, type PlanDeps } from "./propose.js";
import { PlanRepo } from "./repo.js";
import { ensureSigningKey } from "./signing.js";
import { strikePlan } from "./strike.js";
import { validateExport } from "./validate.js";

const NOW = new Date("2026-10-17T10:00:00.000Z");
const google = (id: string, name: string) => ({ platform: "google_ads", kind: "campaign", id, name });
const meta = (id: string) => ({ platform: "meta", kind: "adset", id, name: "Broad" });

let root: string;
let dir: string;
let store: Store | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-validate-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  await mkdir(join(dir, "plans", "patches"), { recursive: true });
  await writeFile(join(dir, "plans", "patches", "hero.diff"), "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n");
});
afterEach(async () => {
  store?.close();
  store = undefined;
  await rm(root, { recursive: true, force: true });
});

const policy = async (): Promise<Policy> => {
  const loaded = await loadPolicy(dir);
  return PolicySchema.parse({ ...loaded, limits: { ...loaded.limits, require_simulation_for_scale: false, max_daily_budget_increase_pct: 1000 } });
};

const build = async (proposals: unknown[]) => {
  const { plan } = compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: proposals as never, now: NOW }, { policy: await policy() });
  await exportPlan({ dir, plan, pending: new Set(plan.actions.map((a) => a.id)), now: NOW });
  return plan;
};

const full = [
  { type: "budget_change", target: google("1", "Brand Search"), from: 200, to: 160, currency: "SAR" },
  { type: "status_change", target: google("1", "Brand Search"), from: "ENABLED", to: "PAUSED" },
  { type: "add_negative_keywords", target: google("1", "Brand Search"), terms: [{ text: "free", match: "BROAD" }, { text: "رخيص", match: "EXACT" }] },
  { type: "budget_change", target: meta("999"), from: 100, to: 115.5, currency: "SAR" },
  { type: "status_change", target: meta("998"), from: "ENABLED", to: "PAUSED" },
  { type: "code_patch", artifact: "patches/hero.diff" },
];

const csvPath = (plan: { plan_id: string }) => join(dir, "exports", plan.plan_id, "google-ads-editor.csv");
const metaPath = (plan: { plan_id: string }) => join(dir, "exports", plan.plan_id, "meta-mutations.json");

describe("currency minor units", () => {
  it("uses ISO exponents and refuses amounts a currency cannot hold", () => {
    expect([currencyExponent("SAR"), currencyExponent("JPY"), currencyExponent("KWD")]).toEqual([2, 0, 3]);
    expect(toMinorUnits(115.5, "SAR")).toBe(11550);
    expect(toMinorUnits(1200, "JPY")).toBe(1200);
    expect(toMinorUnits(1.5, "JPY")).toBeNull();
    expect(toMinorUnits(10.555, "SAR")).toBeNull();
    expect(toMinorUnits(-1, "SAR")).toBeNull();
    expect(toMinorUnits(Number.NaN, "SAR")).toBeNull();
  });
});

describe("the Meta mutation export", () => {
  it("writes exact dry-run requests in minor units with the expected current value, and sends nothing", async () => {
    const plan = await build(full);
    const doc = JSON.parse(await readFile(metaPath(plan), "utf8"));
    expect(doc.note).toMatch(/has not sent any/);
    expect(doc.requests).toEqual([
      { action_id: "a4", method: "POST", path: "/999", params: { daily_budget: "11550" }, expect_before: { daily_budget: "10000" } },
      { action_id: "a5", method: "POST", path: "/998", params: { status: "PAUSED" }, expect_before: { status: "ACTIVE" } },
    ]);
  });

  it("fails a budget the currency cannot hold, rather than rounding it", () => {
    const { plan } = compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: [{ type: "budget_change", target: meta("999"), from: 100, to: 100.555, currency: "SAR" }] as never, now: NOW }, { policy: PolicySchema.parse({}) });
    const built = buildMetaMutations(plan.actions);
    expect(built.requests).toEqual([]);
    expect(built.problems.get("a1")).toMatch(/cannot hold a budget of 100.555/);
  });
});

describe("validateExport", () => {
  it("passes a fresh export and lists what it checked", async () => {
    const plan = await build(full);
    const v = await validateExport({ dir, plan });
    expect(v).toEqual({ ok: true, issues: [], checked: ["manifest.json", "google-ads-editor.csv", "meta-mutations.json", "patches/hero.diff"] });
  });

  it("catches a changed Editor CSV: wrong headers, a bad status, a formula, an extra column", async () => {
    const plan = await build(full);
    const file = csvPath(plan);
    const original = await readFile(file, "utf8");
    const cases: [string, string, RegExp][] = [
      ["wrong header", original.replace("Criterion Type", "Match Type"), /headers are/],
      ["bad status", original.replace(",Paused,160", ",Stopped,160"), /Campaign Status "Stopped"/],
      ["formula", original.replace("Brand Search,,,,Paused", "=HYPERLINK(),,,,Paused"), /formula/],
      ["extra column", original.replace("Brand Search,,,,Paused,160", "Brand Search,,,,Paused,160,x"), /7 columns, expected 6/],
      ["bad budget", original.replace(",160\r\n", ",-5\r\n"), /Budget "-5"/],
      ["no BOM", original.slice(1), /byte order mark/],
    ];
    for (const [name, text, expected] of cases) {
      await writeFile(file, text, "utf8");
      const v = await validateExport({ dir, plan });
      expect(v.ok, name).toBe(false);
      expect(v.issues.map((i) => i.message).join("\n"), name).toMatch(expected);
      expect(v.issues[0]!.action_ids, name).toEqual(["a1", "a2", "a3"]);
    }
  });

  it("catches any edit that no rule names, by comparing with what the plan produces", async () => {
    const plan = await build(full);
    const file = csvPath(plan);
    await writeFile(file, (await readFile(file, "utf8")).replace("free", "frees"), "utf8");
    const v = await validateExport({ dir, plan });
    expect(v.issues.map((i) => i.message)).toEqual(["does not match what the approved plan produces; the file was edited or the exporter changed"]);
  });

  it("catches a changed Meta file: wrong budget, a non-numeric id, a second param, a different plan", async () => {
    const plan = await build(full);
    const file = metaPath(plan);
    const original = JSON.parse(await readFile(file, "utf8"));
    const edit = (fn: (d: typeof original) => void) => {
      const copy = structuredClone(original);
      fn(copy);
      return writeFile(file, JSON.stringify(copy), "utf8");
    };
    await edit((d) => (d.requests[0].params.daily_budget = "115.50"));
    expect((await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/positive whole number of minor units/);
    await edit((d) => (d.requests[0].path = "/act_999"));
    expect((await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/not a numeric Meta object id/);
    await edit((d) => (d.requests[1].params.daily_budget = "1000"));
    expect((await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/exactly one of daily_budget or status/);
    await edit((d) => (d.plan_hash = "0".repeat(64)));
    expect((await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/plan_hash does not match/);
    await writeFile(file, "{oops", "utf8");
    expect((await validateExport({ dir, plan })).issues[0]!.message).toMatch(/not valid JSON/);
  });

  it("flags a missing file, a missing manifest, a manifest of another plan and an altered patch copy", async () => {
    const plan = await build(full);
    await rm(csvPath(plan));
    expect((await validateExport({ dir, plan })).issues[0]).toMatchObject({ file: "google-ads-editor.csv", message: "the file is missing" });
    await writeFile(join(dir, "exports", plan.plan_id, "patches", "hero.diff"), "tampered", "utf8");
    expect((await validateExport({ dir, plan })).issues.map((i) => i.file)).toContain("patches/hero.diff");
    await writeFile(join(dir, "exports", plan.plan_id, "manifest.json"), JSON.stringify({ plan_id: "pl_other", plan_hash: "x" }), "utf8");
    expect((await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/different plan/);
    await rm(join(dir, "exports", plan.plan_id, "manifest.json"));
    expect(await validateExport({ dir, plan })).toMatchObject({ ok: false, issues: [{ file: "manifest.json", message: "the export has no manifest.json" }] });
  });
});

describe("strike runs the validation", () => {
  async function deps(): Promise<PlanDeps> {
    store = Store.open(join(dir, ".medjay", "experiments.db"));
    let n = 0;
    return {
      dir,
      repo: new PlanRepo(store),
      ledger: new Ledger(join(dir, ".medjay", "audit-log.jsonl"), { now: () => NOW }),
      policy: await policy(),
      signing: await ensureSigningKey({ dir, workspaceId: "ws", keystore: memoryKeystore(), env: {} }),
      now: () => NOW,
      random: { code: () => "123456", nonce: () => `nonce-${(n += 1)}` },
    };
  }

  it("marks an action failed when its Editor row is not importable (a budget with three decimals), and strikes the rest", async () => {
    const d = await deps();
    const { row } = await proposePlan(d, {
      workspace: "ws",
      origin: { job: "manual", finding_ids: [] },
      proposals: [
        { type: "budget_change", target: google("1", "Brand Search"), from: 200, to: 160.555, currency: "SAR" },
        { type: "add_negative_keywords", target: google("2", "Generic"), terms: [{ text: "free", match: "BROAD" }] },
        { type: "budget_change", target: meta("999"), from: 100, to: 110, currency: "SAR" },
      ] as never,
    });
    await approvePlan(d, row.number, { approver: "cli:omar", channel: "cli" });
    const result = await strikePlan(d, row.number, { actor: "cli:omar" });
    // the whole Google file is rejected as one unit, because Editor imports a file, not a row
    expect(result.results.map((r) => [r.action_id, r.status])).toEqual([["a1", "failed"], ["a2", "failed"], ["a3", "exported"]]);
    expect(result.results[0]!.detail).toMatch(/export validation: google-ads-editor.csv row 2: Budget "160.555"/);
    expect(result.state).toBe("partial");
    const events = (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === "plan.partial").payload.validation).toMatchObject({ ok: false, issues: 1 });
  });

  it("records a clean validation in the ledger for a good plan", async () => {
    const d = await deps();
    const { row } = await proposePlan(d, { workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: [{ type: "budget_change", target: meta("999"), from: 100, to: 110, currency: "SAR" }] as never });
    await approvePlan(d, row.number, { approver: "cli:omar", channel: "cli" });
    const result = await strikePlan(d, row.number, { actor: "cli:omar" });
    expect(result.state).toBe("exported");
    const events = (await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === "plan.exported").payload.validation).toEqual({ ok: true, issues: 0, checked: ["manifest.json", "meta-mutations.json"] });
  });
});
