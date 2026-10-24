// What a stranger gets from `npm install -g medjay`: a publishable package that carries the built app,
// the demo data and the docs, and none of the tests, sources, spikes or maps.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const pkg = async () => JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;

/** Files `npm pack` would ship, without writing a tarball. */
async function packed(): Promise<string[]> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await exec(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, shell: process.platform === "win32" });
  return (JSON.parse(stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path.replaceAll("\\", "/"));
}

describe("the package is publishable", () => {
  it("is not private and says where it lives", async () => {
    const p = await pkg();
    expect(p.private).not.toBe(true);
    expect(p.name).toBe("medjay");
    expect(p.license).toBe("MIT");
    expect(p.repository).toMatchObject({ type: "git", url: expect.stringContaining("github.com/mohamedOmar11111/medjay") });
    expect(typeof p.homepage).toBe("string");
    expect(p.engines).toEqual({ node: ">=22.13" });
  });

  it("builds before it is packed, so a publish can never ship a stale dist", async () => {
    const p = (await pkg()) as { scripts: Record<string, string> };
    expect(p.scripts.prepack).toBe("npm run build");
  });

  it("ships the app, the demo data and the docs people need", async () => {
    const files = await packed();
    for (const must of ["package.json", "README.md", "LICENSE", "dist/cli.js", "dist/tui/app.js", "fixtures/etlaala-ksa/context/unit-economics.md", "docs/SPEC.md"]) expect(files, must).toContain(must);
  });

  it("leaves out sources, tests, spikes, maps and the fixture generator", async () => {
    const files = await packed();
    const unwanted = files.filter((f) => /^(src|test|spikes)\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || f.endsWith(".map") || f.startsWith("docs/superpowers/") || f === "fixtures/generate-etlaala-ksa.ts" || /^\.(github|medjay)\//.test(f));
    expect(unwanted).toEqual([]);
  });

  it("keeps the shipped file count small", async () => {
    expect((await packed()).length).toBeLessThan(400);
  });
});
