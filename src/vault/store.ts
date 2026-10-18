// The global vault on disk: ~/.medjay/global-vault/tactics/<global_id>.json, one file per record.
// A record is trusted only if its content still hashes to its id, so a hand edit (or a bad sync) is
// refused rather than imported.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../audit/canonical.js";
import { VaultRecordSchema, type VaultRecord } from "./record.js";

const ID = /^GT-[0-9a-f]{12}$/;

export const defaultVaultDir = (env: NodeJS.ProcessEnv = process.env): string => env.MEDJAY_VAULT_DIR || join(homedir(), ".medjay", "global-vault");

function verify(raw: unknown): VaultRecord {
  const record = VaultRecordSchema.parse(raw);
  const { global_id, ...body } = record;
  const expected = `GT-${createHash("sha256").update(canonicalJson(body), "utf8").digest("hex").slice(0, 12)}`;
  if (expected !== global_id) throw new Error(`the record does not match its id ${global_id} (it was edited, or is corrupt)`);
  return record;
}

export async function writeRecord(dir: string, record: VaultRecord): Promise<{ created: boolean; file: string }> {
  const folder = join(dir, "tactics");
  await mkdir(folder, { recursive: true });
  const file = `${record.global_id}.json`;
  const existing = await readFile(join(folder, file), "utf8").catch(() => undefined);
  if (existing !== undefined) return { created: false, file };
  const temp = join(folder, `.${file}.tmp`);
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, join(folder, file));
  return { created: true, file };
}

export async function readRecord(dir: string, id: string): Promise<VaultRecord> {
  if (!ID.test(id)) throw new Error(`"${id}" is not a vault id (expected GT- and 12 hex characters)`);
  let text: string;
  try {
    text = await readFile(join(dir, "tactics", `${id}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no vault record ${id} in ${dir}`);
    throw error;
  }
  return verify(JSON.parse(text));
}

export async function listVault(dir: string): Promise<{ records: VaultRecord[]; problems: { file: string; message: string }[] }> {
  let names: string[];
  try {
    names = await readdir(join(dir, "tactics"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], problems: [] };
    throw error;
  }
  const records: VaultRecord[] = [];
  const problems: { file: string; message: string }[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      records.push(verify(JSON.parse(await readFile(join(dir, "tactics", name), "utf8"))));
    } catch (error) {
      problems.push({ file: name, message: error instanceof Error ? error.message.split("\n")[0] ?? "invalid" : String(error) });
    }
  }
  return { records, problems };
}

export interface SearchFilter {
  industry?: string;
  market?: string;
  funnelStage?: string;
  pillar?: number;
  /** A diagnose finding kind the tactic answers, for example bleeding_adset. */
  matches?: string;
}

const CONFIDENCE_RANK: Record<string, number> = { "0.99 or more": 4, "0.95-0.99": 3, "0.90-0.95": 2, "0.10-0.90": 1, "0.10 or less": 0 };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every filter given must match (industry = vertical tag, market = market tag). Best evidence first. */
export async function searchVault(dir: string, filter: SearchFilter): Promise<VaultRecord[]> {
  const { records } = await listVault(dir);
  return records
    .filter((r) => (filter.industry === undefined || r.tags.verticals.some((v) => same(v, filter.industry as string))))
    .filter((r) => (filter.market === undefined || r.tags.markets.some((m) => same(m, filter.market as string))))
    .filter((r) => (filter.funnelStage === undefined || (r.funnel_stage !== undefined && same(r.funnel_stage, filter.funnelStage))))
    .filter((r) => (filter.pillar === undefined || r.pillars.includes(filter.pillar)))
    .filter((r) => (filter.matches === undefined || r.matches.includes(filter.matches)))
    .sort((a, b) => (CONFIDENCE_RANK[b.evidence.confidence_band] ?? 0) - (CONFIDENCE_RANK[a.evidence.confidence_band] ?? 0) || a.global_id.localeCompare(b.global_id));
}
