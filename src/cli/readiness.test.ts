import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { readinessOf } from "./readiness.js";

const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "etlaala-ksa");
let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-ready-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "ecom", baseCurrency: "SAR" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const file = (r: Awaited<ReturnType<typeof readinessOf>>, name: string) => r.context.files.find((f) => f.file === name)!;

describe("workspace readiness", () => {
  it("a fresh workspace has four empty context files, no data, no connections and the safe limits", async () => {
    const r = await readinessOf(dir);
    expect(r.context.files.map((f) => [f.file, f.status])).toEqual([
      ["context/unit-economics.md", "empty"],
      ["context/offer-matrix.md", "empty"],
      ["context/brand-voice.md", "empty"],
      ["context/claims.md", "empty"],
    ]);
    expect(r.context.ready_count).toBe(0);
    expect(r.data).toMatchObject({ files_found: 0, newest_file: null, mapping_exists: false });
    expect(r.connections).toEqual([]);
    expect(r.limits).toMatchObject({ max_posts_per_day: 5, simulation_required_to_scale: true });
    expect(r.guides.length).toBeGreaterThan(3);
    expect(r.guide_notice).toMatch(/menu names/i);
  });

  it("unit economics: partial lists what is still missing, ready when the validator has no problems", async () => {
    await writeFile(join(dir, "context", "unit-economics.md"), "---\ncurrency: SAR\ncpc: { value: 2, low: 1, high: 3, source: test }\n---\n# Unit economics\n", "utf8");
    const partial = file(await readinessOf(dir), "context/unit-economics.md");
    expect(partial.status).toBe("partial");
    expect(partial.missing!.length).toBeGreaterThan(0);
    expect(partial.missing!.join(" ")).not.toMatch(/cost per click/i);
    await cp(join(FIXTURE, "context", "unit-economics.md"), join(dir, "context", "unit-economics.md"));
    const ready = file(await readinessOf(dir), "context/unit-economics.md");
    expect(ready).toMatchObject({ status: "ready" });
    expect(ready.missing).toBeUndefined();
  });

  it("text files: untouched template is empty; any real content, in the text or in the front matter, makes it ready", async () => {
    await writeFile(join(dir, "context", "offer-matrix.md"), `${await readFile(join(dir, "context", "offer-matrix.md"), "utf8")}\n- Umrah package, 4 nights, 3200 SAR\n`, "utf8");
    await writeFile(join(dir, "context", "claims.md"), "---\nclaims:\n  - { id: CLM-001, values: [\"+31%\"], text: Lift, source: EXP-1, date: 2026-10-01, status: verified }\n---\n# Claim register\n", "utf8");
    const r = await readinessOf(dir);
    expect(file(r, "context/offer-matrix.md").status).toBe("ready");
    expect(file(r, "context/claims.md").status).toBe("ready");
    expect(file(r, "context/brand-voice.md").status).toBe("empty");
    expect(r.context.ready_count).toBe(2);
  });

  it("a deleted context file is reported as missing, not as an error", async () => {
    await rm(join(dir, "context", "claims.md"));
    expect(file(await readinessOf(dir), "context/claims.md").status).toBe("missing");
  });

  it("data: counts files in the dropzone, reports the newest one's date and whether a mapping exists", async () => {
    await mkdir(join(dir, "data", "imports"), { recursive: true });
    const a = join(dir, "data", "imports", "a.csv");
    await writeFile(a, "x\n", "utf8");
    await utimes(a, new Date("2026-10-20T10:00:00Z"), new Date("2026-10-20T10:00:00Z"));
    await writeFile(join(dir, "data", "imports", "b.csv"), "y\n", "utf8");
    await utimes(join(dir, "data", "imports", "b.csv"), new Date("2026-10-22T10:00:00Z"), new Date("2026-10-22T10:00:00Z"));
    await writeFile(join(dir, "ingestion.mappings.yaml"), "sources: []\n", "utf8");
    const r = await readinessOf(dir);
    expect(r.data).toMatchObject({ files_found: 2, newest_file: "2026-10-22", mapping_exists: true });
  });
});

describe("readiness gives the model absolute places to point the owner to", () => {
  it("names the workspace folder, each context file's full path and the full dropzone path", async () => {
    const r = await readinessOf(dir);
    expect(r.workspace.folder).toBe(resolve(dir));
    expect(r.context.files.map((f) => f.path)).toEqual(["unit-economics.md", "offer-matrix.md", "brand-voice.md", "claims.md"].map((n) => join(resolve(dir), "context", n)));
    expect(r.data.dropzone).toBe(join(resolve(dir), "data", "imports"));
  });
});
