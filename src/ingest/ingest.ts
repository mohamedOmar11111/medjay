// mdj scout, first half: read the dropzone through the mapping, normalize, store, report.
// The dropzone is untrusted: only plain files directly inside it are read (no symlinks, no folders),
// each under a size cap, and nothing in a file is ever executed or interpreted as configuration.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ledger } from "../audit/ledger.js";
import type { Store } from "../store/db.js";
import type { Mappings, SourceMapping } from "./mapping.js";
import { normalizeAdPlatform, normalizeAdSummary, normalizeCrm, normalizeWebAnalytics, type Issue } from "./normalize.js";
import { IngestRepo, type FactBatch, type SourceRecord } from "./repo.js";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface IngestDeps {
  dropzoneDir: string;
  workspaceId: string;
  mappings: Mappings;
  store: Store;
  ledger: Ledger;
  now: () => Date;
  actor?: string;
}

export type FileStatus = "ingested" | "unchanged" | "rejected";

export interface FileReport {
  source_id: string;
  mapping_id: string;
  file: string;
  status: FileStatus;
  rows: number;
  period: { start: string; end: string } | null;
  issues: Issue[];
}

export interface IngestReport {
  files: FileReport[];
  /** Files in the dropzone that no mapping claims. */
  unmapped: string[];
  /** Mappings that matched no file. */
  missing: string[];
}

const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

async function plainFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    const info = await lstat(join(dir, name));
    if (info.isFile() && !info.isSymbolicLink()) out.push(name);
  }
  return out;
}

function normalize(mapping: SourceMapping, file: string, text: string, workspaceId: string): { batch: FactBatch; issues: Issue[]; rows: number; period: FileReport["period"] } {
  if (mapping.kind === "ad_platform") {
    const r = normalizeAdPlatform(file, text, mapping);
    return { batch: { kind: "ad_platform", platform: mapping.platform, currency: mapping.currency, facts: r.facts }, issues: r.issues, rows: r.rows, period: r.period };
  }
  if (mapping.kind === "ad_summary") {
    const r = normalizeAdSummary(file, text, mapping);
    return { batch: { kind: "ad_summary", platform: mapping.platform, currency: mapping.currency, dimension: mapping.dimension, period: r.period ?? { start: "", end: "" }, facts: r.facts }, issues: r.issues, rows: r.rows, period: r.period };
  }
  if (mapping.kind === "web_analytics") {
    const r = normalizeWebAnalytics(file, text, mapping);
    return { batch: { kind: "web_analytics", facts: r.facts }, issues: r.issues, rows: r.rows, period: r.period };
  }
  const r = normalizeCrm(file, text, mapping, workspaceId);
  return { batch: { kind: "crm", facts: r.facts }, issues: r.issues, rows: r.rows, period: r.period };
}

export async function ingestDropzone(deps: IngestDeps): Promise<IngestReport> {
  const repo = new IngestRepo(deps.store);
  const present = await plainFiles(deps.dropzoneDir);
  const claimed = new Set<string>();
  const files: FileReport[] = [];
  const missing: string[] = [];

  for (const mapping of deps.mappings.sources) {
    const matcher = globToRegExp(mapping.file);
    const matches = present.filter((name) => matcher.test(name) && !claimed.has(name));
    if (matches.length === 0) missing.push(mapping.id);
    for (const file of matches) {
      claimed.add(file);
      const sourceId = `${mapping.id}:${file}`;
      const base = { source_id: sourceId, mapping_id: mapping.id, file };
      const path = join(deps.dropzoneDir, file);
      if ((await lstat(path)).size > MAX_FILE_BYTES) {
        files.push({ ...base, status: "rejected", rows: 0, period: null, issues: [{ severity: "error", kind: "too_large", file, message: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB; not read` }] });
        continue;
      }
      const buffer = await readFile(path);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const known = repo.getSource(sourceId);
      if (known && known.sha256 === sha256) {
        files.push({ ...base, status: "unchanged", rows: known.rows, period: known.period_start && known.period_end ? { start: known.period_start, end: known.period_end } : null, issues: known.issues });
        continue;
      }
      const result = normalize(mapping, file, buffer.toString("utf8"), deps.workspaceId);
      if (result.issues.some((i) => i.severity === "error")) {
        // a bad file never replaces good data that is already stored
        files.push({ ...base, status: "rejected", rows: 0, period: null, issues: result.issues });
        continue;
      }
      const record: SourceRecord = {
        ...base,
        kind: mapping.kind,
        platform: mapping.kind === "ad_platform" || mapping.kind === "ad_summary" ? mapping.platform : null,
        sha256,
        rows: result.rows,
        issues: result.issues,
        period_start: result.period?.start ?? null,
        period_end: result.period?.end ?? null,
        ingested_at: deps.now().toISOString(),
      };
      repo.replace(record, result.batch);
      files.push({ ...base, status: "ingested", rows: result.rows, period: result.period, issues: result.issues });
    }
  }

  const report: IngestReport = { files, unmapped: present.filter((n) => !claimed.has(n)), missing };
  // The ledger records what was read and how it went, never cell contents.
  await deps.ledger.append({
    actor: deps.actor ?? "cli",
    event: "ingest.completed",
    payload: {
      workspace: deps.workspaceId,
      files: files.map((f) => ({ file: f.file, mapping: f.mapping_id, status: f.status, rows: f.rows, issues: f.issues.length, errors: f.issues.filter((i) => i.severity === "error").length, suspicious: f.issues.filter((i) => i.kind === "suspicious_text").length })),
      unmapped: report.unmapped,
      missing,
    },
  });
  return report;
}
