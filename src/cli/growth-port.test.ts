import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { createGrowthPort } from "./growth-port.js";

const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "etlaala-ksa");
let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-gport-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "etlaala-ksa", businessType: "ecom", baseCurrency: "SAR", timezone: "Asia/Riyadh" });
  await cp(join(FIXTURE, "data"), join(dir, "data"), { recursive: true });
  await cp(join(FIXTURE, "ingestion.mappings.yaml"), join(dir, "ingestion.mappings.yaml"));
  await cp(join(FIXTURE, "context", "unit-economics.md"), join(dir, "context", "unit-economics.md"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the growth port over a real workspace", () => {
  it("scout ingests and returns the calibrated snapshot with a compact ingest report", async () => {
    const port = createGrowthPort(dir);
    const r = (await port.scout(7)) as { snapshot: { status: string; totals: { spend: number } }; ingest: { files: { status: string }[] } };
    expect(r.snapshot.status).toBe("ok");
    expect(r.snapshot.totals.spend).toBeGreaterThan(0);
    expect(r.ingest.files.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.ingest)).not.toMatch(/issues_json|excerpt/);
  });

  it("diagnose returns findings for the same data", async () => {
    const port = createGrowthPort(dir);
    await port.scout(7);
    const d = (await port.diagnose(7)) as { status: string; findings: unknown[] };
    expect(d.status).toBe("ok");
    expect(d.findings.length).toBeGreaterThan(0);
  });

  it("simulate uses the scouted spend and the owner's unit economics", async () => {
    const port = createGrowthPort(dir);
    await port.scout(7);
    const s = (await port.simulate({ scale_pct: 15 })) as { status: string; spend_used: number };
    expect(s.status).toBe("ok");
    expect(s.spend_used).toBeGreaterThan(0);
  });

  it("context returns the owner's files and the tactics, bounded", async () => {
    const c = (await createGrowthPort(dir).context()) as { unit_economics: string; claims: string; tactics: unknown[] };
    expect(c.unit_economics).toContain("average_deal_value");
    expect(typeof c.claims).toBe("string");
    expect(Array.isArray(c.tactics)).toBe(true);
    expect(JSON.stringify(c).length).toBeLessThan(120_000);
  });

  it("dataId is stable until a file in the dropzone changes", async () => {
    const port = createGrowthPort(dir);
    const first = await port.dataId();
    expect(await port.dataId()).toBe(first);
    await writeFile(join(dir, "data", "imports", "extra.csv"), "a,b\n1,2\n");
    expect(await port.dataId()).not.toBe(first);
  });
});

describe("the growth port when there is no data yet (an expected state, not a failure)", () => {
  let bare: string;
  beforeEach(async () => {
    bare = join(root, "bare");
    await initWorkspace({ dir: bare, id: "bare", businessType: "ecom", baseCurrency: "SAR" });
  });

  it("scout on an empty dropzone says no_data_yet and what to export, and does not throw", async () => {
    const r = (await createGrowthPort(bare).scout(7)) as { status: string; files_found: number; dropzone: string; exports_needed: string[]; unmatched: unknown[] };
    expect(r.status).toBe("no_data_yet");
    expect(r.files_found).toBe(0);
    expect(r.dropzone).toContain("imports");
    expect(r.exports_needed.length).toBeGreaterThan(0);
    expect(r.unmatched).toEqual([]);
  });

  it("scout with a file Medjay cannot read names the file and why", async () => {
    await mkdir(join(bare, "data", "imports"), { recursive: true });
    await writeFile(join(bare, "data", "imports", "notes.csv"), "a,b\n1,2\n", "utf8");
    const r = (await createGrowthPort(bare).scout(7)) as { status: string; files_found: number; unmatched: { file: string; reason: string }[] };
    expect(r.status).toBe("no_data_yet");
    expect(r.files_found).toBe(1);
    expect(r.unmatched[0]).toMatchObject({ file: "notes.csv" });
    expect(r.unmatched[0]!.reason.length).toBeGreaterThan(0);
  });

  it("diagnose and a simulation with no spend report the same state instead of throwing", async () => {
    const port = createGrowthPort(bare);
    expect(await port.diagnose(7)).toMatchObject({ status: "no_data_yet" });
    expect(await port.simulate({})).toMatchObject({ status: "no_data_yet" });
  });

  it("a real problem is still an error (an unreadable mapping file is not 'no data')", async () => {
    await writeFile(join(bare, "ingestion.mappings.yaml"), "not: [valid", "utf8");
    await expect(createGrowthPort(bare).scout(7)).rejects.toThrow();
  });
});
