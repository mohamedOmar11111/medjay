import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "dist", "cli.js"); // built once by test/global-setup.ts
let root: string;
let ws: string;
let home: string;
let pluginDir: string;
let installedDir: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd: REPO, timeout: 150_000, env: { ...process.env, USERPROFILE: home, HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function makePlugin(dir: string, name: string) {
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: `${name} helpers` }));
  await mkdir(join(dir, "skills", `${name}-skill`), { recursive: true });
  await writeFile(join(dir, "skills", `${name}-skill`, "SKILL.md"), `---\nname: ${name}-skill\ndescription: Does ${name} things.\n---\nBody.\n`);
  await mkdir(join(dir, "commands"), { recursive: true });
  await writeFile(join(dir, "commands", "go.md"), "---\ndescription: Go now\n---\nGo\n");
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { feed: { type: "http", url: "https://mcp.example.com/x", headers: { Authorization: "Bearer TOP-SECRET-VALUE" } } } }));
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "evil" }] }] } }));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-plugins-cli-"));
  ws = join(root, "ws");
  home = join(root, "home");
  pluginDir = join(root, "linked-plugin");
  installedDir = join(root, "installed-plugin");
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  await makePlugin(pluginDir, "acme");
  await makePlugin(installedDir, "market");
  await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "market@store": [{ scope: "user", installPath: installedDir }] } }));
  await exec(process.execPath, [CLI, "init", ws, "--id", "pl", "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj plugins", () => {
  it("lists nothing until a plugin is linked or included", async () => {
    const r = await mdj("plugins", "list", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/No plugins/);
  });

  it("link adds a plugin folder; list and show tell what it offers and what is not run, without secrets", async () => {
    const link = await mdj("plugins", "link", pluginDir, "--workspace", ws);
    expect(link.code).toBe(0);
    expect(link.stdout).toMatch(/linked acme/);
    const list = await mdj("plugins", "list", "--workspace", ws);
    expect(list.stdout).toMatch(/acme\s+1\.0\.0\s+1\s+1\s+0\s+1/);
    const show = await mdj("plugins", "show", "acme", "--workspace", ws);
    expect(show.stdout).toMatch(/skills: 1/);
    expect(show.stdout).toMatch(/commands: go/);
    expect(show.stdout).toMatch(/feed .*http .*mcp\.example\.com/);
    expect(show.stdout).toMatch(/credentials expected: Authorization/);
    expect(show.stdout).toMatch(/ignored: hooks 1, scripts 0, bin 0/);
    expect(show.stdout + list.stdout).not.toContain("TOP-SECRET-VALUE");
    expect(show.stdout + list.stdout).not.toContain("evil");
    expect((await mdj("plugins", "link", pluginDir, "--workspace", ws)).stderr).toMatch(/already linked/);
    expect((await mdj("plugins", "link", join(root, "nowhere"), "--workspace", ws)).stderr).toMatch(/not a plugin|not a folder/);
  });

  it("include turns on an installed plugin by name@marketplace, and its skills show up in mdj skills list", async () => {
    expect((await mdj("plugins", "include", "market@store", "--workspace", ws)).code).toBe(0);
    expect((await mdj("plugins", "include", "ghost@store", "--workspace", ws)).stderr).toMatch(/not installed/);
    const skills = await mdj("skills", "list", "--workspace", ws);
    expect(skills.stdout).toMatch(/market-skill\s+plugin:market\s+third_party/);
    expect(skills.stdout).toMatch(/acme-skill\s+plugin:acme\s+third_party/);
  });

  it("unlink and exclude turn them off again, and the ledger stays intact", async () => {
    expect((await mdj("plugins", "unlink", pluginDir, "--workspace", ws)).code).toBe(0);
    expect((await mdj("plugins", "exclude", "market@store", "--workspace", ws)).code).toBe(0);
    expect((await mdj("plugins", "list", "--workspace", ws)).stdout).toMatch(/No plugins/);
    expect(await readFile(join(ws, "workspace.yaml"), "utf8")).not.toContain("market@store");
    expect((await verifyLedger(join(ws, ".medjay", "audit-log.jsonl"))).ok).toBe(true);
  });
});
