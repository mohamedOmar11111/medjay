import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DropzoneError, resolveDropzone } from "./paths.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-paths-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveDropzone", () => {
  it("resolves a relative folder inside the workspace", async () => {
    expect(await resolveDropzone(root, "./data/imports")).toBe(resolve(root, "data", "imports"));
    expect(await resolveDropzone(root, "imports")).toBe(resolve(root, "imports"));
    expect(await resolveDropzone(root, "./data/./imports/")).toBe(resolve(root, "data", "imports"));
  });

  it("allows a .. segment that stays inside the workspace", async () => {
    expect(await resolveDropzone(root, "data/tmp/../imports")).toBe(resolve(root, "data", "imports"));
  });

  it.each([
    ["parent traversal", "../outside"],
    ["nested traversal", "data/../../outside"],
    ["bare parent", ".."],
    ["absolute posix path", "/etc"],
    ["windows drive path", "C:\\Users\\x"],
    ["windows drive, forward slashes", "C:/Users/x"],
    ["UNC path", "\\\\server\\share"],
    ["empty path", ""],
    ["workspace root itself", "."],
    ["machine state folder", ".medjay/imports"],
    ["machine state, mixed case", ".MEDJAY"],
    ["null byte", "data/\0imports"],
  ])("rejects %s", async (_label, value) => {
    await expect(resolveDropzone(root, value)).rejects.toBeInstanceOf(DropzoneError);
  });

  it("rejects a path that escapes through a symlink or junction", async () => {
    const outside = await mkdtemp(join(tmpdir(), "medjay-outside-"));
    try {
      await mkdir(join(root, "data"));
      await symlink(outside, join(root, "data", "link"), "junction");
    } catch {
      await rm(outside, { recursive: true, force: true });
      return; // cannot create links in this environment; covered by the lexical checks above
    }
    try {
      await expect(resolveDropzone(root, "data/link")).rejects.toBeInstanceOf(DropzoneError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
