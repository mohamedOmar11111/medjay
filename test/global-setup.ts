// The CLI tests run the real program in a child process. Starting it through tsx transpiles the whole
// tree on every launch, which is what made them slow (and flaky) when the full suite ran in parallel.
// Build once here, and let them run the compiled dist/cli.js.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function setup(): void {
  const root = join(import.meta.dirname, "..");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}
