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
let hq: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    // a throwaway home, so the real ~/.medjay and ~/.claude are never read by a test
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { cwd: REPO, timeout: 150_000, env: { ...process.env, USERPROFILE: home, HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function skill(dir: string, folder: string, name: string, description: string, extra = "") {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nUse Read on the brief.\n`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-skills-cli-"));
  ws = join(root, "ws");
  home = join(root, "home");
  hq = join(root, "hq");
  await mkdir(home, { recursive: true });
  await exec(process.execPath, [CLI, "init", ws, "--id", "sk", "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
  await skill(hq, "m09", "gd-m09-email-lifecycle-planner", "Build useful email sequences around a subscriber action.", "allowed-tools: Read, Write, Bash\n");
  await skill(hq, "e05", "gd-e05-content-brief-writer", "Write an SEO content brief before drafting starts.");
  await skill(join(ws, "skills"), "mine", "gd-e05-content-brief-writer", "A workspace copy that hides the HQ one.");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj skill link / skills list / show / doctor / skill unlink", () => {
  it("link adds the root to workspace.yaml, keeps the file's comments, and writes a ledger entry", async () => {
    const file = join(ws, "workspace.yaml");
    await writeFile(file, `# my own note\n${await readFile(file, "utf8")}`);
    const r = await mdj("skill", "link", hq, "--trust", "owner", "--name", "hq", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/linked hq/);
    const text = await readFile(file, "utf8");
    expect(text).toContain("# my own note");
    expect(text).toMatch(/trust: owner/);
    expect((await verifyLedger(join(ws, ".medjay", "audit-log.jsonl"))).ok).toBe(true);
    const again = await mdj("skill", "link", hq, "--workspace", ws);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already linked/);
  });

  it("list shows every skill with its source and trust, and hides the shadowed copy", async () => {
    const r = await mdj("skills", "list", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gd-m09-email-lifecycle-planner\s+hq\s+owned/);
    expect(r.stdout).toMatch(/gd-e05-content-brief-writer\s+workspace\s+owned/);
    expect(r.stdout).not.toMatch(/gd-e05-content-brief-writer\s+hq/);
    const only = await mdj("skills", "list", "--source", "hq", "--json", "--workspace", ws);
    expect((JSON.parse(only.stdout) as { name: string }[]).map((s) => s.name)).toEqual(["gd-m09-email-lifecycle-planner"]);
  });

  it("show gives the details and what became of each declared tool", async () => {
    const r = await mdj("skills", "show", "gd-m09-email-lifecycle-planner", "--workspace", ws);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("source: hq (owned)");
    expect(r.stdout).toMatch(/Read -> read_file/);
    expect(r.stdout).toMatch(/Write -> draft_save.*not available yet/);
    expect(r.stdout).toMatch(/stripped: Bash/);
    expect((await mdj("skills", "show", "nope", "--workspace", ws)).code).toBe(1);
  });

  it("doctor reports the collision and exits non-zero only for real problems", async () => {
    const r = await mdj("skills", "doctor", "--workspace", ws);
    expect(r.stdout).toMatch(/gd-e05-content-brief-writer: kept workspace, hidden hq/);
    expect(r.stdout).toMatch(/roots/i);
  });

  it("unlink removes the root again, and linking a folder that does not exist is refused", async () => {
    expect((await mdj("skill", "unlink", hq, "--workspace", ws)).code).toBe(0);
    expect(await readFile(join(ws, "workspace.yaml"), "utf8")).not.toMatch(/trust: owner/);
    const missing = await mdj("skill", "link", join(root, "nowhere"), "--workspace", ws);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/not a folder/);
  });
});

describe("mdj mount add / list / remove", () => {
  it("adds a named read-only folder, lists it, refuses duplicates and non-folders, and removes it", async () => {
    const add = await mdj("mount", "add", "hq", hq, "--trust", "owner", "--workspace", ws);
    expect(add.code).toBe(0);
    expect(add.stdout).toMatch(/mounted hq/);
    expect(await readFile(join(ws, "workspace.yaml"), "utf8")).toMatch(/name: hq/);
    const list = await mdj("mount", "list", "--workspace", ws);
    expect(list.stdout).toMatch(/hq\s+owner\s+/);
    expect(list.stdout).toContain("hq:");
    expect((await mdj("mount", "add", "hq", hq, "--workspace", ws)).stderr).toMatch(/already mounted/);
    expect((await mdj("mount", "add", "c", hq, "--workspace", ws)).code).toBe(1);
    expect((await mdj("mount", "add", "nope", join(root, "nowhere"), "--workspace", ws)).stderr).toMatch(/not a folder/);
    expect((await mdj("mount", "remove", "hq", "--workspace", ws)).code).toBe(0);
    expect((await mdj("mount", "list", "--workspace", ws)).stdout).toMatch(/No folders mounted/);
    expect((await verifyLedger(join(ws, ".medjay", "audit-log.jsonl"))).ok).toBe(true);
  });
});
