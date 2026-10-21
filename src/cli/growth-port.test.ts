import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
