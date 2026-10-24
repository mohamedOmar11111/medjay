// Where Medjay puts things when the person gives it no paths: new workspaces go in a Medjay folder in
// their home directory, and the workspace they used last is reopened the next time `mdj` starts.
// This is a convenience only. It never decides what a workspace may do; that stays in the workspace files.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findWorkspace, WORKSPACE_FILE } from "./load.js";

const STATE_FILE = "state.json";

/** Where new workspaces are created: $MEDJAY_WORKSPACES, or a Medjay folder in the home directory. */
export function workspaceRoot(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.MEDJAY_WORKSPACES?.trim();
  return chosen ? resolve(chosen) : join(home, "Medjay");
}

/** Where Medjay keeps its own small bookkeeping (not a workspace): $MEDJAY_HOME, or ~/.medjay. */
export function stateHomeDir(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.MEDJAY_HOME?.trim();
  return chosen ? resolve(chosen) : join(home, ".medjay");
}

const isWorkspace = (dir: string) => stat(join(dir, WORKSPACE_FILE)).then((s) => s.isFile(), () => false);

/** Remember `dir` as the workspace to reopen. False when it is not a workspace or could not be written. */
export async function rememberWorkspace(dir: string, stateHome: string = stateHomeDir()): Promise<boolean> {
  const absolute = resolve(dir);
  if (!(await isWorkspace(absolute))) return false;
  try {
    await mkdir(stateHome, { recursive: true });
    const file = join(stateHome, STATE_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ last_workspace: absolute }, null, 2)}\n`, "utf8");
    await rename(temp, file);
    return true;
  } catch {
    return false; // read-only home or similar: the app still works, it just will not reopen this one by itself
  }
}

/** The workspace opened last, if it still exists and is still a workspace. */
export async function lastWorkspace(stateHome: string = stateHomeDir()): Promise<string | null> {
  try {
    const state: unknown = JSON.parse(await readFile(join(stateHome, STATE_FILE), "utf8"));
    const dir = typeof state === "object" && state !== null ? (state as { last_workspace?: unknown }).last_workspace : undefined;
    return typeof dir === "string" && dir !== "" && (await isWorkspace(dir)) ? dir : null;
  } catch {
    return null; // nothing remembered yet, or the file is damaged: both mean "start fresh"
  }
}

export interface StartWorkspace {
  dir: string | null;
  from: "flag" | "folder" | "last" | "none";
}

/** The workspace to open: --workspace, else one above the current folder, else the last one used. */
export async function resolveStartWorkspace(options: { flag?: string | undefined; cwd: string; stateHome?: string }): Promise<StartWorkspace> {
  if (options.flag) return { dir: resolve(options.flag), from: "flag" };
  const here = await findWorkspace(options.cwd);
  if (here !== null) return { dir: here, from: "folder" };
  const last = await lastWorkspace(options.stateHome);
  return last !== null ? { dir: last, from: "last" } : { dir: null, from: "none" };
}

