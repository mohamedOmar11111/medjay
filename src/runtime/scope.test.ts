import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { RunScope, ScopeError } from "./scope.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-scope-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function workspace(name: string, note = `note of ${name}`) {
  const dir = join(root, name);
  await initWorkspace({ dir, id: name, businessType: "agency" });
  await writeFile(join(dir, "context", "note.md"), note, "utf8");
  return dir;
}
const scopeFor = (dir: string, over: Partial<Parameters<typeof RunScope.create>[0]> = {}) =>
  RunScope.create({ workspaceDir: dir, workspaceId: "ws", dropzoneDir: join(dir, "data", "imports"), ...over });

const code = async (promise: Promise<unknown>) => ((await promise.catch((e) => e)) as ScopeError).code;

describe("RunScope.readText", () => {
  it("reads an allowed file and stamps it with source and as_of", async () => {
    const dir = await workspace("a");
    const when = new Date("2026-10-01T08:30:00.000Z");
    await utimes(join(dir, "context", "note.md"), when, when);
    const result = await (await scopeFor(dir)).readText("context/note.md");
    expect(result).toMatchObject({ text: "note of a", bytes: 9, truncated: false, as_of: "2026-10-01T08:30:00.000Z", source: "file:context/note.md" });
  });

  it("normalizes separators and dot segments but never leaves the allowed roots", async () => {
    const dir = await workspace("a");
    const scope = await scopeFor(dir);
    expect((await scope.readText("context\\note.md")).source).toBe("file:context/note.md");
    expect((await scope.readText("./context/./note.md")).source).toBe("file:context/note.md");
    expect((await scope.readText("context/sub/../note.md")).source).toBe("file:context/note.md");
  });

  it.each(["context/note.md", "workspace.yaml", "shield.policy.yaml"])("allows %s", async (rel) => {
    const dir = await workspace("a");
    await expect((await scopeFor(dir)).readText(rel)).resolves.toBeDefined();
  });

  it("allows tactics, plans and the dropzone", async () => {
    const dir = await workspace("a");
    await writeFile(join(dir, "tactics", "t.md"), "t");
    await writeFile(join(dir, "plans", "p.json"), "{}");
    await writeFile(join(dir, "data", "imports", "meta.csv"), "a,b");
    const scope = await scopeFor(dir);
    for (const rel of ["tactics/t.md", "plans/p.json", "data/imports/meta.csv"]) await expect(scope.readText(rel), rel).resolves.toBeDefined();
  });

  it.each([
    [".medjay/audit-log.jsonl"],
    [".medjay/keys/signing.pub"],
    [".MEDJAY/experiments.db"],
    ["context/../.medjay/audit-log.jsonl"],
    ["data/imports/../../.medjay/audit-log.jsonl"],
    ["exports/x.csv"],
    ["src/index.ts"],
    ["context/.env"],
    ["context/.env.local"],
    ["context/server.pem"],
    ["context/id.key"],
    ["context/.git/config"],
    ["../outside.txt"],
    ["context/../../outside.txt"],
    ["/etc/passwd"],
    ["C:\\Windows\\win.ini"],
    ["C:/Windows/win.ini"],
    ["\\\\server\\share\\x"],
    ["context/\0note.md"],
    [""],
  ])("denies %j", async (rel) => {
    const dir = await workspace("a");
    expect(["denied", "outside"]).toContain(await code((await scopeFor(dir)).readText(rel)));
  });

  it("reports a missing allowed file as missing", async () => {
    const dir = await workspace("a");
    expect(await code((await scopeFor(dir)).readText("context/nope.md"))).toBe("missing");
  });

  it("refuses a directory and a binary file", async () => {
    const dir = await workspace("a");
    await writeFile(join(dir, "context", "blob.bin"), Buffer.from([1, 2, 0, 3, 0, 0]));
    const scope = await scopeFor(dir);
    expect(await code(scope.readText("context"))).toBe("not_file");
    expect(await code(scope.readText("context/blob.bin"))).toBe("binary");
  });

  it("truncates large files on a character boundary and says so", async () => {
    const dir = await workspace("a", "é".repeat(100));
    const result = await (await scopeFor(dir, { maxReadBytes: 51 })).readText("context/note.md");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(200);
    expect(result.text).toBe("é".repeat(25));
    expect(result.text).not.toContain("\uFFFD");
  });

  it("honors a custom dropzone folder inside the workspace", async () => {
    const dir = await workspace("a");
    await mkdir(join(dir, "inbox", "exports"), { recursive: true });
    await writeFile(join(dir, "inbox", "exports", "g.csv"), "x");
    const scope = await scopeFor(dir, { dropzoneDir: join(dir, "inbox", "exports") });
    await expect(scope.readText("inbox/exports/g.csv")).resolves.toBeDefined();
    expect(scope.isDropzone("inbox/exports/g.csv")).toBe(true);
    expect(scope.isDropzone("context/note.md")).toBe(false);
  });
});

describe("client isolation: one client's run can never reach another's files", () => {
  it("cannot read a sibling workspace by relative path, absolute path or a prefixed name", async () => {
    const a = await workspace("client-a");
    const b = await workspace("client-b", "SECRET OF B");
    const scope = await scopeFor(a);
    for (const rel of ["../client-b/context/note.md", join(b, "context", "note.md"), "context/../../client-b/context/note.md", "..\\client-b\\context\\note.md"]) {
      expect(["denied", "outside"], rel).toContain(await code(scope.readText(rel)));
    }
    expect((await (await scopeFor(b)).readText("context/note.md")).text).toBe("SECRET OF B");
  });

  it("cannot follow a symlink or junction out of the workspace or into machine state", async () => {
    const a = await workspace("client-a");
    const b = await workspace("client-b", "SECRET OF B");
    try {
      await symlink(join(b, "context"), join(a, "context", "to-b"), "junction");
      await symlink(join(a, ".medjay"), join(a, "context", "to-state"), "junction");
    } catch {
      return; // links cannot be created in this environment; the lexical checks above still hold
    }
    const scope = await scopeFor(a);
    expect(["denied", "outside"]).toContain(await code(scope.readText("context/to-b/note.md")));
    expect(["denied", "outside"]).toContain(await code(scope.readText("context/to-state/audit-log.jsonl")));
  });

  it("records which client the run is for", async () => {
    const a = await workspace("client-a");
    expect((await scopeFor(a, { client: "etlaala" })).client).toBe("etlaala");
  });
});

describe("RunScope.list", () => {
  it("lists the allowed roots at the top and never machine state", async () => {
    const dir = await workspace("a");
    const names = (await (await scopeFor(dir)).list("")).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["context", "tactics", "plans", "data/imports", "workspace.yaml", "shield.policy.yaml"]));
    for (const hidden of [".medjay", "exports", ".gitignore"]) expect(names).not.toContain(hidden);
  });

  it("lists a folder with type, size and as_of, hiding secret-looking files", async () => {
    const dir = await workspace("a");
    await writeFile(join(dir, "context", ".env"), "KEY=1");
    await writeFile(join(dir, "context", "k.pem"), "x");
    const entries = await (await scopeFor(dir)).list("context");
    const note = entries.find((e) => e.name === "note.md")!;
    expect(note).toMatchObject({ type: "file", bytes: 9 });
    expect(note.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries.map((e) => e.name)).not.toContain(".env");
    expect(entries.map((e) => e.name)).not.toContain("k.pem");
  });

  it("refuses to list a denied folder or a file", async () => {
    const dir = await workspace("a");
    const scope = await scopeFor(dir);
    expect(["denied", "outside"]).toContain(await code(scope.list(".medjay")));
    expect(["denied", "outside"]).toContain(await code(scope.list("..")));
    expect(await code(scope.list("workspace.yaml"))).toBe("not_dir");
  });

  it("lists the dropzone's own entries only", async () => {
    const dir = await workspace("a");
    await mkdir(join(dir, "data", "imports", "sub"), { recursive: true });
    await writeFile(join(dir, "data", "imports", "meta.csv"), "x");
    const names = (await (await scopeFor(dir)).list("data/imports")).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["sub", "meta.csv"]));
    expect(names).not.toContain("..");
    expect(names).not.toContain("imports");
  });
});
