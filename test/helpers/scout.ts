import { scout, type Snapshot } from "../../src/analysis/scout.js";
import { FIXTURE_NOW, setupIngest, type IngestHarness } from "./ingest.js";

export interface ScoutHarness extends IngestHarness {
  snapshot: (over?: Partial<Parameters<typeof scout>[0]>) => Snapshot;
}

/** The etlaala-ksa fixture, ingested, with a snapshot helper (Riyadh time, SAR, 24h freshness). */
export async function setupScout(): Promise<ScoutHarness> {
  const h = await setupIngest();
  await h.ingest();
  return {
    ...h,
    snapshot: (over = {}) => scout({ store: h.store, mappings: h.deps.mappings, baseCurrency: "SAR", timezone: "Asia/Riyadh", now: FIXTURE_NOW, freshnessSlaHours: 24, ...over }),
  };
}
