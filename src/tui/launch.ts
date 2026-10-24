// Starts the terminal app. Everything here is wiring: find the workspace, point the runner at this
// same CLI, take over the screen, and give it back (always) when the app ends.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { createElement } from "react";
import { VERSION } from "../version.js";
import { rememberWorkspace, resolveStartWorkspace, workspaceRoot } from "../workspace/home.js";
import { App } from "./app.js";
import { loadDashboard } from "./dashboard.js";
import { spawnRunner } from "./runner.js";

const ENTER_SCREEN = "\u001B[?1049h\u001B[2J\u001B[H";
const LEAVE_SCREEN = "\u001B[?1049l";

/** The CLI script the app runs its commands through: this one (built), or the source entry under tsx. */
function cliEntry(): { path: string; nodeArgs: string[] } {
  const argv1 = process.argv[1];
  if (argv1 && /\.[cm]?js$/.test(argv1) && existsSync(argv1)) return { path: argv1, nodeArgs: [] };
  const built = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(built)) return { path: built, nodeArgs: [] };
  return { path: fileURLToPath(new URL("../cli.ts", import.meta.url)), nodeArgs: process.execArgv };
}

export async function launch(options: { workspace?: string } = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("the interactive app needs a terminal; run a command such as `mdj scout` instead, or `mdj --help`");
  }
  // --workspace, else a workspace above this folder, else the one used last, else first-run setup in ~/Medjay
  const start = await resolveStartWorkspace({ flag: options.workspace, cwd: process.cwd() });
  const workspaceDir = start.dir;
  if (workspaceDir !== null) await rememberWorkspace(workspaceDir);
  const baseDir = workspaceRoot();
  if (workspaceDir === null) await mkdir(baseDir, { recursive: true });
  const entry = cliEntry();
  const runner = spawnRunner(entry.path, process.execPath, entry.nodeArgs);
  process.stdout.write(ENTER_SCREEN);
  // a closed terminal or a kill must not leave the alternate screen on
  const leave = () => void process.stdout.write(LEAVE_SCREEN);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, () => (leave(), process.exit(143)));
  try {
    const app = render(
      createElement(App, { workspaceDir, baseDir, runner, version: VERSION, load: (dir: string) => loadDashboard(dir), onWorkspace: (dir: string) => void rememberWorkspace(dir) }),
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write(LEAVE_SCREEN);
  }
}
