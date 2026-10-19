#!/usr/bin/env node
import { main } from "./cli/main.js";

// No arguments in a terminal opens the interactive app; anything else is the command line.
if (process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY) {
  try {
    const { launch } = await import("./tui/launch.js");
    await launch();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  await main(process.argv);
}
