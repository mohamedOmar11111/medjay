import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/audit/ledger.js";
import { ingestDropzone, type IngestDeps, type IngestReport } from "../../src/ingest/ingest.js";
import { loadMappings } from "../../src/ingest/mapping.js";
import { Store } from "../../src/store/db.js";

export const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "etlaala-ksa");
/** "Now" for the fixture: the morning after the export. */
export const FIXTURE_NOW = new Date("2026-10-17T07:00:00.000Z");

export interface IngestHarness {
  dir: string;
  store: Store;
  ledger: Ledger;
  deps: IngestDeps;
  ingest: () => Promise<IngestReport>;
  cleanup: () => Promise<void>;
}

/** A temp copy of the etlaala-ksa fixture, a fresh store and ledger. */
export async function setupIngest(): Promise<IngestHarness> {
  const dir = await mkdtemp(join(tmpdir(), "medjay-ingest-"));
  await cp(FIXTURE, dir, { recursive: true });
  const store = Store.open(join(dir, ".medjay", "experiments.db"));
  const ledger = new Ledger(join(dir, ".medjay", "audit-log.jsonl"));
  const deps: IngestDeps = {
    dropzoneDir: join(dir, "data", "imports"),
    workspaceId: "etlaala-ksa",
    mappings: await loadMappings(dir),
    store,
    ledger,
    now: () => FIXTURE_NOW,
    actor: "test",
  };
  return {
    dir,
    store,
    ledger,
    deps,
    ingest: () => ingestDropzone(deps),
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
