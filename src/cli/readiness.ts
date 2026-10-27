// What is ready in a workspace and what is missing, as plain facts for the agent's Guide step. The runtime
// cannot import the analysis layers, so this adapter lives here and reaches the agent through the growth port.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadUnitEconomics } from "../analysis/simulate.js";
import { exportGuideSummaries, GUIDE_NOTICE } from "../guide/exports.js";
import { loadPolicy } from "../shield/policy.js";
import { contextFiles } from "../workspace/init.js";
import { loadWorkspace } from "../workspace/load.js";

export type ContextStatus = "missing" | "empty" | "partial" | "ready";

export interface ContextFileState {
  file: string;
  status: ContextStatus;
  /** Unit economics only: the numbers still to fill, in plain words. */
  missing?: string[];
}

const TEXT_FILES = ["context/offer-matrix.md", "context/brand-voice.md", "context/claims.md"] as const;
const UNIT_ECONOMICS = "context/unit-economics.md";

function split(text: string): { front: Record<string, unknown>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  let front: unknown = {};
  try {
    front = parseYaml(m[1] as string) ?? {};
  } catch {
    front = {};
  }
  return { front: typeof front === "object" && front !== null ? (front as Record<string, unknown>) : {}, body: m[2] ?? "" };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** True when the front matter holds nothing the person added (only empty lists, and the workspace id init wrote). */
function frontIsBlank(front: Record<string, unknown>): boolean {
  return Object.entries(front).every(([key, value]) => key === "workspace" || value === null || value === "" || (Array.isArray(value) && value.length === 0));
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function textFileState(dir: string, file: (typeof TEXT_FILES)[number]): Promise<ContextFileState> {
  const text = await readOrNull(join(dir, file));
  if (text === null) return { file, status: "missing" };
  const template = split(contextFiles("template")[file] ?? "");
  const now = split(text);
  return { file, status: frontIsBlank(now.front) && squash(now.body) === squash(template.body) ? "empty" : "ready" };
}

async function unitEconomicsState(dir: string): Promise<ContextFileState> {
  const text = await readOrNull(join(dir, UNIT_ECONOMICS));
  if (text === null) return { file: UNIT_ECONOMICS, status: "missing" };
  const economics = await loadUnitEconomics(dir);
  if (economics.problems.length === 0) return { file: UNIT_ECONOMICS, status: "ready" };
  const filled = Object.keys(economics.inputs).length;
  return { file: UNIT_ECONOMICS, status: filled === 0 ? "empty" : "partial", missing: economics.problems.map((p) => p.message) };
}

async function dataState(dir: string, dropzoneDir: string) {
  let names: string[] = [];
  try {
    names = (await readdir(dropzoneDir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    /* no dropzone yet */
  }
  let newest = 0;
  for (const name of names) newest = Math.max(newest, (await stat(join(dropzoneDir, name))).mtimeMs);
  const mapping = await stat(join(dir, "ingestion.mappings.yaml")).then((s) => s.isFile(), () => false);
  return {
    dropzone: dropzoneDir,
    files_found: names.length,
    newest_file: names.length === 0 ? null : new Date(newest).toISOString().slice(0, 10),
    mapping_exists: mapping,
  };
}

export async function readinessOf(dir: string) {
  const { config, dropzoneDir } = await loadWorkspace(dir);
  const policy = await loadPolicy(dir);
  const files = [await unitEconomicsState(dir), ...(await Promise.all(TEXT_FILES.map((f) => textFileState(dir, f))))];
  const cap = policy.limits.max_total_spend_cap;
  return {
    workspace: { id: config.workspace.id, name: config.workspace.name, currency: config.workspace.base_currency, language: config.localization.languages.primary },
    context: { files, ready_count: files.filter((f) => f.status === "ready").length },
    data: await dataState(dir, dropzoneDir),
    /** Live connections. None exist yet; the field is here so the answer has the same shape when they do. */
    connections: [] as string[],
    limits: {
      max_posts_per_day: policy.limits.max_posts_per_day,
      spend_cap: cap ? `${cap.amount} ${cap.currency} per ${cap.period}` : null,
      simulation_required_to_scale: policy.limits.require_simulation_for_scale,
    },
    guides: exportGuideSummaries(),
    guide_notice: GUIDE_NOTICE,
  };
}
