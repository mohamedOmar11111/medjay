import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, setupIngest, type IngestHarness } from "../../test/helpers/ingest.js";
import { initWorkspace } from "../workspace/init.js";
import { emptyDashboard, ledgerLabel, loadDashboard, sidebarLines, type Dashboard } from "./dashboard.js";

let h: IngestHarness | undefined;
let tmp: string | undefined;
afterEach(async () => {
  await h?.cleanup();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  h = undefined;
  tmp = undefined;
});

const text = (d: Dashboard, now?: Date) => sidebarLines(d, now).map((l) => l.text);

describe("loadDashboard", () => {
  it("reads ledger, plans, gate and data from an ingested workspace without writing", async () => {
    h = await setupIngest();
    await initWorkspace({ dir: h.dir, id: "etlaala-ksa", baseCurrency: "SAR", businessType: "ecom", models: {} });
    await h.ingest();
    const d = await loadDashboard(h.dir, () => FIXTURE_NOW);
    expect(d.problems).toEqual([]);
    expect(d.workspace).toMatchObject({ id: "etlaala-ksa", currency: "SAR" });
    expect(d.ledger!.seq).toBeGreaterThan(0);
    expect(d.data.status).toBe("ok");
    expect(d.data.period).toMatchObject({ days: 7 });
    expect(d.data.spend).toBeGreaterThan(0);
    expect(d.data.sources.map((s) => s.id).sort()).toEqual(expect.arrayContaining(["google_ads:google-ads-2026-10-10_16.csv"]));
    expect(d.gate).toEqual({ required: true, minChance: 0.6 });
    expect(d.plans).toEqual([]);
  });

  it("a fresh workspace with no mapping reports data as not mapped, not as an error", async () => {
    tmp = await mkdtemp(join(tmpdir(), "medjay-dash-"));
    const dir = join(tmp, "ws");
    await initWorkspace({ dir, id: "ws", businessType: "ecom", models: {} });
    const d = await loadDashboard(dir);
    expect(d.workspace).toMatchObject({ id: "ws" });
    expect(d.data.status).toBe("unmapped");
    expect(d.problems).toEqual([]);
    expect(text(d)).toContain("not mapped yet: /scout sets it up");
  });

  it("a folder that is not a workspace gives a problem and nothing else", async () => {
    tmp = await mkdtemp(join(tmpdir(), "medjay-dash-"));
    const d = await loadDashboard(tmp);
    expect(d.workspace).toBeNull();
    expect(d.problems[0]).toMatch(/^workspace:/);
  });
});

describe("sidebarLines", () => {
  const base = (): Dashboard => ({
    ...emptyDashboard(),
    workspace: { id: "etl", name: "Etlaala KSA", currency: "SAR", timezone: "Asia/Riyadh" },
    ledger: { seq: 12, head: "a1b2c3d4e5f6a7b8" },
    gate: { required: true, minChance: 0.6 },
    cap: { amount: 4500, currency: "SAR", period: "day", perDay: 4500 },
    plans: [
      { number: 1, state: "proposed", id: "pl_1", expires_at: "2026-10-18T00:00:00Z" },
      { number: 2, state: "struck", id: "pl_2", expires_at: "2026-10-01T00:00:00Z" },
    ],
    data: { status: "ok", period: { start: "2026-10-10", end: "2026-10-16", days: 7 }, spend: 26880, avgDaily: 3840, sources: [{ id: "meta_ads", ageDays: 1, stale: false, errors: 0 }, { id: "ga4", ageDays: 9, stale: true, errors: 2 }] },
  });

  it("shows plans waiting, the gate, per-source freshness, spend against the cap and the ledger head", () => {
    const t = text(base(), new Date("2026-10-19T00:00:00Z"));
    expect(t).toEqual(expect.arrayContaining(["Etlaala KSA", "etl · SAR", "1 waiting · 2 total", "#1 proposed (expired)", "#2 struck", "scale needs P(>0) ≥ 60%", "✓ Meta Ads 1d", "✗ Website analytics 9d (2 err)", "3,840 SAR/day avg", "cap 4,500/day: 85%", "#12 a1b2c3d4"]));
  });

  it("marks a stale or failing source and a cap near its limit as warnings", () => {
    const lines = sidebarLines({ ...base(), data: { ...base().data, avgDaily: 4400 } });
    expect(lines.find((l) => l.text.startsWith("cap"))!.tone).toBe("warn");
    expect(lines.find((l) => l.text.startsWith("✗ Website analytics"))!.tone).toBe("warn");
  });

  it("does not compare a cap in another currency", () => {
    const t = text({ ...base(), cap: { amount: 1000, currency: "USD", period: "day", perDay: 1000 } });
    expect(t).toContain("cap 1,000 USD/day (other currency)");
  });

  it("says when there is no workspace, no plans, or the gate is off", () => {
    expect(text(emptyDashboard())).toEqual(["no workspace yet", "setup questions are in the feed"]);
    const t = text({ ...base(), plans: [], gate: { required: false, minChance: 0.6 } });
    expect(t).toEqual(expect.arrayContaining(["none", "simulation not required"]));
  });

  it("labels the ledger head for the header", () => {
    expect(ledgerLabel(base())).toBe("ledger #12 a1b2c3d4");
    expect(ledgerLabel(emptyDashboard())).toBe("ledger -");
  });
});
