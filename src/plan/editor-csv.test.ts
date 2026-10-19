import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCsv } from "../ingest/csv.js";
import { PolicySchema } from "../shield/policy.js";
import { initWorkspace } from "../workspace/init.js";
import { compilePlan } from "./compile.js";
import { buildEditorCsv, exportPlan } from "./export.js";
import { validateExport } from "./validate.js";

const NOW = new Date("2026-10-17T10:00:00.000Z");
const campaign = { platform: "google_ads", kind: "campaign", id: "1", name: "Brand Search" };
const adGroup = (name: string) => ({ platform: "google_ads", kind: "ad_group", id: "77", name, parent_name: "Brand Search" });
const compile = (proposals: unknown[]) => compilePlan({ workspace: "ws", origin: { job: "manual", finding_ids: [] }, proposals: proposals as never, now: NOW }, { policy: PolicySchema.parse({ limits: { require_simulation_for_scale: false, max_daily_budget_increase_pct: 1000 } }) }).plan;
const rows = (csv: string | null) => parseCsv((csv ?? "").replace(/^﻿/, ""));

describe("Google Ads Editor CSV: Ad Group Status and Status (Removed) columns", () => {
  it("keeps the six base columns when nothing needs more", () => {
    const { csv } = buildEditorCsv(compile([{ type: "status_change", target: campaign, from: "ENABLED", to: "PAUSED" }]).actions);
    expect(rows(csv)).toEqual([["Campaign", "Ad Group", "Keyword", "Criterion Type", "Campaign Status", "Budget"], ["Brand Search", "", "", "", "Paused", ""]]);
  });

  it("pausing or enabling an ad group adds an Ad Group Status column and a row with both names", () => {
    const { csv, written } = buildEditorCsv(compile([{ type: "status_change", target: adGroup("umrah packages exact"), from: "ENABLED", to: "PAUSED" }, { type: "status_change", target: adGroup("umrah offers phrase"), from: "PAUSED", to: "ENABLED" }]).actions);
    expect(written).toEqual(["a1", "a2"]);
    expect(rows(csv)).toEqual([
      ["Campaign", "Ad Group", "Keyword", "Criterion Type", "Campaign Status", "Budget", "Ad Group Status"],
      ["Brand Search", "umrah packages exact", "", "", "", "", "Paused"],
      ["Brand Search", "umrah offers phrase", "", "", "", "", "Enabled"],
    ]);
  });

  it("an ad group needs its campaign name, and a budget change is campaign-level only", () => {
    const noParent = { platform: "google_ads", kind: "ad_group", id: "9", name: "x" };
    const built = buildEditorCsv(compile([{ type: "status_change", target: noParent, from: "ENABLED", to: "PAUSED" }, { type: "budget_change", target: adGroup("g"), from: 10, to: 12, currency: "SAR" }]).actions);
    expect(built.csv).toBeNull();
    expect(built.problems.get("a1")).toMatch(/campaign name \(target.parent_name\)/);
    expect(built.problems.get("a2")).toMatch(/budget.*campaign/i);
  });

  it("removing a negative keyword is emitted as a row with Status: Removed, in the Status column", () => {
    const { csv } = buildEditorCsv(compile([{ type: "remove_negative_keywords", target: campaign, terms: [{ text: "free", match: "BROAD" }, { text: "رخيص", match: "EXACT" }] }]).actions);
    expect(rows(csv)).toEqual([
      ["Campaign", "Ad Group", "Keyword", "Criterion Type", "Campaign Status", "Budget", "Status"],
      ["Brand Search", "", "free", "Negative Broad", "", "", "Removed"],
      ["Brand Search", "", "رخيص", "Negative Exact", "", "", "Removed"],
    ]);
  });

  it("both extra columns together, with adds and removes in the same file, in a stable order", () => {
    const { csv } = buildEditorCsv(
      compile([
        { type: "add_negative_keywords", target: campaign, terms: [{ text: "jobs", match: "PHRASE" }] },
        { type: "remove_negative_keywords", target: campaign, terms: [{ text: "free", match: "BROAD" }] },
        { type: "status_change", target: adGroup("g1"), from: "ENABLED", to: "PAUSED" },
        { type: "budget_change", target: campaign, from: 100, to: 90, currency: "SAR" },
      ]).actions,
    );
    expect(rows(csv)).toEqual([
      ["Campaign", "Ad Group", "Keyword", "Criterion Type", "Campaign Status", "Budget", "Ad Group Status", "Status"],
      ["Brand Search", "", "", "", "", "90", "", ""],
      ["Brand Search", "g1", "", "", "", "", "Paused", ""],
      ["Brand Search", "", "jobs", "Negative Phrase", "", "", "", ""],
      ["Brand Search", "", "free", "Negative Broad", "", "", "", "Removed"],
    ]);
  });
});

describe("validating the extended Editor CSV", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "medjay-editorcsv-"));
    await initWorkspace({ dir, id: "ws", businessType: "agency" });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const exported = async (proposals: unknown[]) => {
    const plan = compile(proposals);
    await exportPlan({ dir, plan, pending: new Set(plan.actions.map((a) => a.id)), now: NOW });
    return { plan, file: join(dir, "exports", plan.plan_id, "google-ads-editor.csv") };
  };

  it("passes a fresh file with ad group rows and removals", async () => {
    const { plan } = await exported([{ type: "status_change", target: adGroup("g1"), from: "ENABLED", to: "PAUSED" }, { type: "remove_negative_keywords", target: campaign, terms: [{ text: "free", match: "BROAD" }] }]);
    expect(await validateExport({ dir, plan })).toMatchObject({ ok: true, issues: [] });
  });

  it("catches an Action that is not Remove, a Remove with no keyword, and an Ad Group Status without an Ad Group", async () => {
    const { plan, file } = await exported([{ type: "status_change", target: adGroup("g1"), from: "ENABLED", to: "PAUSED" }, { type: "remove_negative_keywords", target: campaign, terms: [{ text: "free", match: "BROAD" }] }]);
    const original = await readFile(file, "utf8");
    const check = async (text: string) => (await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n");
    await writeFile(file, original.replace(",Removed", ",Deleted"), "utf8");
    expect(await check(original)).toMatch(/Status "Deleted" is not Removed/);
    await writeFile(file, original.replace("free,Negative Broad,,,,Removed", ",Negative Broad,,,,Removed"), "utf8");
    expect(await check(original)).toMatch(/Status needs a Keyword|needs a Keyword/);
    await writeFile(file, original.replace("Brand Search,g1,,,,,Paused", "Brand Search,,,,,,Paused"), "utf8");
    expect(await check(original)).toMatch(/Ad Group Status needs an Ad Group/);
  });

  it("rejects a header the exporter would not write", async () => {
    const { plan, file } = await exported([{ type: "status_change", target: adGroup("g1"), from: "ENABLED", to: "PAUSED" }]);
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("Ad Group Status", "AdGroupStatus"), "utf8");
    expect((await validateExport({ dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/headers are/);
  });
});
