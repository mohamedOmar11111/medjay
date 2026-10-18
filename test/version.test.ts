import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { VERSION } from "../src/version.js";

it("keeps VERSION in sync with package.json", async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
  expect(VERSION).toBe(pkg.version);
});

it("registers both medjay and mdj binaries on the same entry point", async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
  expect(pkg.bin).toEqual({ medjay: "./dist/cli.js", mdj: "./dist/cli.js" });
});
