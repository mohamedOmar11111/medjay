#!/usr/bin/env node
import { nodeProblem, quietSqliteWarning } from "./node-check.js";

// Check the Node version before loading anything that needs a newer one (node:sqlite), so an old Node gets
// a plain explanation instead of a stack trace.
quietSqliteWarning();
const tooOld = nodeProblem(process.versions.node);
if (tooOld !== null) {
  process.stderr.write(`${tooOld}\n`);
  process.exitCode = 1;
} else if (process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY) {
  // No arguments in a terminal opens the interactive app; anything else is the command line.
  try {
    const { launch } = await import("./tui/launch.js");
    await launch();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const { main } = await import("./cli/main.js");
  await main(process.argv);
}
