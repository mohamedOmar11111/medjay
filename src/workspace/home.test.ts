import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastWorkspace, rememberWorkspace, resolveStartWorkspace, workspaceRoot } from "./home.js";

let root: string;
let stateHome: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-home-"));
  stateHome = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const makeWorkspace = async (name: string): Promise<string> => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workspace.yaml"), "workspace:\n  id: x\n", "utf8");
  return dir;
};

describe("workspaceRoot", () => {
  it("is a Medjay folder in the user's home, never the folder the app happened to start in", () => {
    expect(workspaceRoot("/home/sara")).toBe(join("/home/sara", "Medjay"));
  });
  it("honours MEDJAY_WORKSPACES so a person (or a test) can choose another place", () => {
    expect(workspaceRoot("/home/sara", { MEDJAY_WORKSPACES: "/data/clients" })).toBe(resolve("/data/clients"));
    expect(workspaceRoot("/home/sara", { MEDJAY_WORKSPACES: "   " })).toBe(join("/home/sara", "Medjay"));
  });
});

describe("rememberWorkspace and lastWorkspace", () => {
  it("returns the workspace opened last, creating the state folder on the way", async () => {
    const a = await makeWorkspace("a");
    expect(await rememberWorkspace(a, stateHome)).toBe(true);
    expect(await lastWorkspace(stateHome)).toBe(a);
    const b = await makeWorkspace("b");
    await rememberWorkspace(b, stateHome);
    expect(await lastWorkspace(stateHome)).toBe(b);
  });
  it("returns null when nothing was remembered, the folder is gone, or it is no longer a workspace", async () => {
    expect(await lastWorkspace(stateHome)).toBeNull();
    const a = await makeWorkspace("a");
    await rememberWorkspace(a, stateHome);
    await rm(join(a, "workspace.yaml"));
    expect(await lastWorkspace(stateHome)).toBeNull();
    await rm(a, { recursive: true });
    expect(await lastWorkspace(stateHome)).toBeNull();
  });
  it("treats a damaged state file as nothing remembered, and replaces it on the next write", async () => {
    await mkdir(stateHome, { recursive: true });
    await writeFile(join(stateHome, "state.json"), "{not json", "utf8");
    expect(await lastWorkspace(stateHome)).toBeNull();
    const a = await makeWorkspace("a");
    expect(await rememberWorkspace(a, stateHome)).toBe(true);
    expect(await lastWorkspace(stateHome)).toBe(a);
  });
  it("refuses to remember a folder that is not a workspace, and says so", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await rememberWorkspace(plain, stateHome)).toBe(false);
    expect(await lastWorkspace(stateHome)).toBeNull();
  });
});

describe("resolveStartWorkspace", () => {
  it("prefers the --workspace flag, then a workspace above the current folder, then the last one used", async () => {
    const flagged = await makeWorkspace("flagged");
    const here = await makeWorkspace("here");
    const last = await makeWorkspace("last");
    await rememberWorkspace(last, stateHome);
    const inner = join(here, "data", "imports");
    await mkdir(inner, { recursive: true });
    expect(await resolveStartWorkspace({ flag: flagged, cwd: inner, stateHome })).toEqual({ dir: flagged, from: "flag" });
    expect(await resolveStartWorkspace({ cwd: inner, stateHome })).toEqual({ dir: here, from: "folder" });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    expect(await resolveStartWorkspace({ cwd: elsewhere, stateHome })).toEqual({ dir: last, from: "last" });
  });
  it("returns no workspace when there is none, so first-run setup can start", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    expect(await resolveStartWorkspace({ cwd: elsewhere, stateHome })).toEqual({ dir: null, from: "none" });
  });
});
