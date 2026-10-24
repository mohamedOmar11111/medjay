// Export validation: before a human imports an export, prove the files are well formed AND still
// say exactly what the approved plan says. The Google Ads Editor CSV and the Meta mutation file are
// regenerated from the plan and compared byte for byte, then checked field by field against the
// formats' rules, so a hand edit, a truncated write or a drifting exporter is caught here.
//
// WHAT THIS CANNOT DO: it checks Medjay's own reading of the Editor CSV format. It has not been
// run against a real Google Ads Editor import (Editor then shows every change for review before
// posting), and the Meta file is a dry-run payload that is never sent.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../audit/canonical.js";
import { parseCsv } from "../ingest/csv.js";
import { resolvePublishDrafts, type DraftPort } from "./draft-binding.js";
import { buildEditorCsv, buildMetaMutations, buildWordPressRequests, EDITOR_EXTRA_HEADERS, EDITOR_HEADERS } from "./export.js";
import type { Plan } from "./types.js";

export interface ExportIssue {
  file: string;
  row?: number;
  message: string;
  /** Actions whose export this issue spoils; strike marks them failed. */
  action_ids: string[];
}

export interface ExportValidation {
  ok: boolean;
  issues: ExportIssue[];
  /** Files that were checked. */
  checked: string[];
}

const STATUSES = new Set(["", "Enabled", "Paused"]);
// Editor wants "Campaign Negative ..." when Ad Group is empty and "Negative ..." when it is set; Medjay writes campaign level only.
const CRITERIA = new Set(["", "Campaign Negative Broad", "Campaign Negative Phrase", "Campaign Negative Exact"]);
const FORMULA_START = /^[=+\-@\t\r]/;

const read = (path: string) => readFile(path).catch(() => undefined);

function googleIds(plan: Plan): string[] {
  return plan.actions.filter((a) => "target" in a && a.target.platform === "google_ads" && a.executor === "export").map((a) => a.id);
}
function metaIds(plan: Plan): string[] {
  return plan.actions.filter((a) => (a.type === "budget_change" || a.type === "status_change") && a.target.platform === "meta" && ["campaign", "adset"].includes(a.target.kind) && a.executor === "export").map((a) => a.id);
}

function checkEditorCsv(bytes: Buffer, plan: Plan, ids: string[]): ExportIssue[] {
  const file = "google-ads-editor.csv";
  const issues: ExportIssue[] = [];
  const add = (message: string, row?: number) => issues.push({ file, ...(row === undefined ? {} : { row }), message, action_ids: ids });

  if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) add("missing the UTF-8 byte order mark; Arabic campaign names would be misread");
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  if (!text.endsWith("\r\n")) add("does not end with a CRLF line break");
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (error) {
    add(error instanceof Error ? error.message : String(error));
    return issues;
  }
  // the six base columns, then any of the two extras in their fixed order
  const header = rows[0] ?? [];
  const extras = header.slice(EDITOR_HEADERS.length);
  const extrasOk = extras.every((h, i) => EDITOR_EXTRA_HEADERS.indexOf(h as (typeof EDITOR_EXTRA_HEADERS)[number]) > (i === 0 ? -1 : EDITOR_EXTRA_HEADERS.indexOf(extras[i - 1] as (typeof EDITOR_EXTRA_HEADERS)[number])));
  if (header.slice(0, EDITOR_HEADERS.length).join("\u0001") !== EDITOR_HEADERS.join("\u0001") || !extrasOk) {
    add(`headers are "${header.join(",")}", expected "${EDITOR_HEADERS.join(",")}" optionally followed by ${EDITOR_EXTRA_HEADERS.map((h) => `"${h}"`).join(" and ")}`, 1);
    return issues;
  }
  const col = (name: string) => header.indexOf(name);
  const [adGroupStatusAt, itemStatusAt] = [col("Ad Group Status"), col("Status")];

  const campaignRows = new Map<string, number>();
  rows.slice(1).forEach((cells, i) => {
    const row = i + 2;
    if (cells.length !== header.length) return add(`has ${cells.length} columns, expected ${header.length}`, row);
    const [campaign, adGroup, keyword, criterion, status, budget] = cells as [string, string, string, string, string, string];
    const adGroupStatus = adGroupStatusAt === -1 ? "" : (cells[adGroupStatusAt] as string);
    const itemStatus = itemStatusAt === -1 ? "" : (cells[itemStatusAt] as string);
    cells.forEach((c, at) => {
      if (FORMULA_START.test(c) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(c)) add(`column ${header[at]} holds text a spreadsheet could run as a formula or that has control characters`, row);
    });
    if (campaign === "") add("Campaign is empty", row);
    if (!STATUSES.has(status)) add(`Campaign Status "${status}" is not Enabled or Paused`, row);
    if (!STATUSES.has(adGroupStatus)) add(`Ad Group Status "${adGroupStatus}" is not Enabled or Paused`, row);
    if (!CRITERIA.has(criterion)) add(`Criterion Type "${criterion}" is not a campaign-level negative match type (Campaign Negative Broad, Phrase or Exact)`, row);
    if (budget !== "" && !(/^\d+(\.\d{1,2})?$/.test(budget) && Number(budget) > 0)) add(`Budget "${budget}" is not a positive amount with at most 2 decimals`, row);
    if (itemStatus !== "" && itemStatus !== "Removed") add(`Status "${itemStatus}" is not Removed (Medjay only removes negative keywords at item level)`, row);
    if (adGroupStatus !== "" && adGroup === "") add("Ad Group Status needs an Ad Group", row);
    if (adGroup !== "" && adGroupStatus === "") add("an Ad Group row must set its Ad Group Status (Medjay does not edit anything else at ad group level)", row);

    if (keyword !== "") {
      if (adGroup !== "") add("negative keywords are written at campaign level only: Ad Group must be empty on a Keyword row", row);
      if (criterion === "") add("a Keyword row needs a Criterion Type", row);
      if (keyword.length > 80) add("Keyword is longer than 80 characters", row);
      if (status !== "" || budget !== "" || adGroupStatus !== "") add("a negative keyword row must not also change status or budget", row);
    } else {
      if (itemStatus !== "") add("Status needs a Keyword: Medjay only removes negative keywords", row);
      if (criterion !== "") add("a Criterion Type needs a Keyword", row);
      if (adGroup !== "") {
        if (status !== "" || budget !== "") add("an Ad Group row must not also change the campaign's status or budget", row);
      } else {
        if (status === "" && budget === "") add("a campaign row that changes nothing", row);
        if (campaignRows.has(campaign)) add(`campaign "${campaign}" appears on rows ${campaignRows.get(campaign)} and ${row}; Editor expects one row per campaign`, row);
        campaignRows.set(campaign, row);
      }
    }
  });

  const expected = buildEditorCsv(plan.actions).csv;
  if (expected !== null && bytes.toString("utf8") !== expected) add("does not match what the approved plan produces; the file was edited or the exporter changed");
  return issues;
}

function checkMetaMutations(bytes: Buffer, plan: Plan, ids: string[]): ExportIssue[] {
  const file = "meta-mutations.json";
  const issues: ExportIssue[] = [];
  const add = (message: string, row?: number) => issues.push({ file, ...(row === undefined ? {} : { row }), message, action_ids: ids });
  let doc: { plan_hash?: unknown; requests?: unknown };
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    add(`not valid JSON: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`);
    return issues;
  }
  if (doc.plan_hash !== plan.plan_hash) add("plan_hash does not match the approved plan");
  if (!Array.isArray(doc.requests)) {
    add("requests is not an array");
    return issues;
  }
  doc.requests.forEach((r: Record<string, unknown>, i) => {
    const row = i + 1;
    if (r.method !== "POST") add(`method is "${String(r.method)}", expected POST`, row);
    if (typeof r.path !== "string" || !/^\/\d+$/.test(r.path)) add(`path "${String(r.path)}" is not a numeric Meta object id`, row);
    const params = (r.params ?? {}) as Record<string, unknown>;
    const keys = Object.keys(params);
    if (keys.length !== 1 || !["daily_budget", "status"].includes(keys[0] as string)) add("params must hold exactly one of daily_budget or status", row);
    if ("daily_budget" in params && !(typeof params.daily_budget === "string" && /^[1-9]\d*$/.test(params.daily_budget))) add("daily_budget must be a positive whole number of minor units, as a string", row);
    if ("status" in params && !["ACTIVE", "PAUSED"].includes(String(params.status))) add(`status "${String(params.status)}" is not ACTIVE or PAUSED`, row);
    if (typeof r.expect_before !== "object" || r.expect_before === null) add("expect_before is missing, so nobody can tell if the object has drifted", row);
  });
  const expected = buildMetaMutations(plan.actions).requests;
  if (canonicalJson(doc.requests) !== canonicalJson(expected)) add("does not match what the approved plan produces; the file was edited or the exporter changed");
  return issues;
}

function wordpressIds(plan: Plan): string[] {
  return plan.actions.filter((a) => a.type === "publish_post" && a.executor === "export").map((a) => a.id);
}

async function checkWordPressPosts(bytes: Buffer | undefined, plan: Plan, ids: string[], drafts: DraftPort | undefined): Promise<ExportIssue[]> {
  const file = "wordpress-posts.json";
  const issues: ExportIssue[] = [];
  const add = (message: string, row?: number) => issues.push({ file, ...(row === undefined ? {} : { row }), message, action_ids: ids });
  // the draft text is read again: the file must still be exactly what that approved version produces
  const resolved = await resolvePublishDrafts(plan.actions, drafts);
  for (const [, message] of resolved.problems) add(message);
  if (resolved.problems.size > 0) return issues;
  if (!bytes) {
    add("the file is missing");
    return issues;
  }
  let doc: { plan_hash?: unknown; requests?: unknown };
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    add(`not valid JSON: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`);
    return issues;
  }
  if (doc.plan_hash !== plan.plan_hash) add("plan_hash does not match the approved plan");
  if (!Array.isArray(doc.requests)) {
    add("requests is not an array");
    return issues;
  }
  doc.requests.forEach((r: Record<string, unknown>, i) => {
    const row = i + 1;
    if (r.method !== "POST") add(`method is "${String(r.method)}", expected POST`, row);
    if (r.path !== "/wp-json/wp/v2/posts") add(`path "${String(r.path)}" is not the WordPress posts endpoint`, row);
    const params = (r.params ?? {}) as Record<string, unknown>;
    if (!["draft", "pending", "publish"].includes(String(params.status))) add(`status "${String(params.status)}" is not draft, pending or publish`, row);
    if (typeof r.expect_before !== "object" || r.expect_before === null) add("expect_before is missing, so nobody can tell if the post already exists", row);
  });
  const expected = buildWordPressRequests(plan.actions, resolved.drafts);
  if (canonicalJson(doc.requests) !== canonicalJson(expected)) add("does not match what the approved plan produces; the file was edited or the exporter changed");
  return issues;
}

export async function validateExport(options: { dir: string; plan: Plan; drafts?: DraftPort }): Promise<ExportValidation> {
  const { dir, plan } = options;
  const exportDir = join(dir, "exports", plan.plan_id);
  const issues: ExportIssue[] = [];
  const checked: string[] = [];

  const manifestBytes = await read(join(exportDir, "manifest.json"));
  if (!manifestBytes) {
    return { ok: false, issues: [{ file: "manifest.json", message: "the export has no manifest.json", action_ids: plan.actions.map((a) => a.id) }], checked };
  }
  checked.push("manifest.json");
  try {
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { plan_hash?: string; plan_id?: string };
    if (manifest.plan_hash !== plan.plan_hash || manifest.plan_id !== plan.plan_id) {
      issues.push({ file: "manifest.json", message: "belongs to a different plan or hash than the one approved", action_ids: plan.actions.map((a) => a.id) });
    }
  } catch {
    issues.push({ file: "manifest.json", message: "is not valid JSON", action_ids: plan.actions.map((a) => a.id) });
  }

  const google = googleIds(plan);
  if (google.length > 0 && buildEditorCsv(plan.actions).csv !== null) {
    const bytes = await read(join(exportDir, "google-ads-editor.csv"));
    checked.push("google-ads-editor.csv");
    issues.push(...(bytes ? checkEditorCsv(bytes, plan, google) : [{ file: "google-ads-editor.csv", message: "the file is missing", action_ids: google }]));
  }
  const meta = metaIds(plan);
  if (meta.length > 0 && buildMetaMutations(plan.actions).requests.length > 0) {
    const bytes = await read(join(exportDir, "meta-mutations.json"));
    checked.push("meta-mutations.json");
    issues.push(...(bytes ? checkMetaMutations(bytes, plan, meta) : [{ file: "meta-mutations.json", message: "the file is missing", action_ids: meta }]));
  }
  const wordpress = wordpressIds(plan);
  if (wordpress.length > 0) {
    checked.push("wordpress-posts.json");
    issues.push(...(await checkWordPressPosts(await read(join(exportDir, "wordpress-posts.json")), plan, wordpress, options.drafts)));
  }
  for (const action of plan.actions) {
    if (action.type !== "code_patch") continue;
    const name = action.artifact.split("/").pop() as string;
    checked.push(`patches/${name}`);
    const [copy, source] = await Promise.all([read(join(exportDir, "patches", name)), read(join(dir, "plans", action.artifact))]);
    if (!copy) issues.push({ file: `patches/${name}`, message: "the copied patch is missing", action_ids: [action.id] });
    else if (source && !copy.equals(source)) issues.push({ file: `patches/${name}`, message: "differs from the patch that was approved", action_ids: [action.id] });
  }
  return { ok: issues.length === 0, issues, checked };
}
