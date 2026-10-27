// Medjay uses node:sqlite, which only exists from Node 22.13. On an older Node the first command would fail
// with "No such built-in module: node:sqlite" and a stack trace; this says what is wrong and what to do instead.
// It imports nothing, so it can run before anything that needs a newer Node is loaded.
export const MIN_NODE = Object.freeze({ major: 22, minor: 13 });

/** A plain-words message when `version` (for example "20.11.1") is too old to run Medjay, otherwise null. */
export function nodeProblem(version: string): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return null; // an unreadable version is not a reason to refuse to start
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) return null;
  return [
    `Medjay needs Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer, and this computer is running Node.js ${version}.`,
    "",
    "To fix it:",
    "  1. Install the current LTS version from https://nodejs.org",
    "  2. Close this terminal and open a new one",
    "  3. Check with: node --version   (it should say v22.13 or higher)",
    "  4. Run: mdj",
  ].join("\n");
}

interface WarningHost {
  removeAllListeners(name: "warning"): unknown;
  on(name: "warning", listener: (warning: Error) => void): unknown;
  stderr: { write(text: string): unknown };
}

/**
 * Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" on every command, which looks like
 * a fault and leaks into the app's feed. Hide that one warning; every other warning is printed as before.
 */
export function quietSqliteWarning(host: WarningHost = process as unknown as WarningHost): void {
  host.removeAllListeners("warning");
  host.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
    host.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}
