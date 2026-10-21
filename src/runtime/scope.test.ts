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

describe("RunScope mounts (named, read-only folders outside the workspace)", () => {
  async function withMount(trust: "owner" | "untrusted" = "owner", name = "m") {
    const dir = await workspace(name);
    const hq = join(root, "hq");
    await mkdir(join(hq, "03_Global_Assets", "frameworks"), { recursive: true });
    await writeFile(join(hq, "03_Global_Assets", "frameworks", "standards.md"), "evidence rules", "utf8");
    await writeFile(join(hq, ".env"), "SECRET=1", "utf8");
    await mkdir(join(hq, ".git"), { recursive: true });
    await writeFile(join(hq, ".git", "config"), "x", "utf8");
    await mkdir(join(hq, "secrets"), { recursive: true });
    await writeFile(join(hq, "secrets", "keys.md"), "k", "utf8");
    const scope = await scopeFor(dir, { mounts: [{ name: "hq", path: hq, trust }] });
    return { dir, hq, scope };
  }

  it("reads a file through the mount name, stamped with the mount in its source", async () => {
    const { scope } = await withMount();
    const r = await scope.readText("hq:03_Global_Assets/frameworks/standards.md");
    expect(r.text).toBe("evidence rules");
    expect(r.source).toBe("file:hq:03_Global_Assets/frameworks/standards.md");
    expect(() => scope.assertAllowed("hq:03_Global_Assets/frameworks/standards.md")).not.toThrow();
  });

  it("lists a mount folder, and the mount itself appears at the top level", async () => {
    const { scope } = await withMount();
    expect((await scope.list("hq:03_Global_Assets")).map((e) => e.name)).toEqual(["frameworks"]);
    expect((await scope.list("")).map((e) => e.name)).toContain("hq:");
  });

  it("refuses .., absolute paths, an unknown mount, machine state, secrets and a drive-letter lookalike", async () => {
    const { scope } = await withMount();
    expect(await code(scope.readText("hq:../outside.md"))).toBe("outside");
    expect(await code(scope.readText("hq:/etc/passwd"))).toBe("outside");
    expect(await code(scope.readText("zz:whatever"))).toBe("denied");
    expect(await code(scope.readText("hq:.git/config"))).toBe("denied");
    expect(await code(scope.readText("hq:.env"))).toBe("denied");
    expect(await code(scope.readText("hq:secrets/keys.md"))).toBe("denied");
    expect(() => scope.assertAllowed("zz:whatever")).toThrow(ScopeError);
    expect(await code(scope.readText("c:foo.txt"))).toBe("denied");
  });

  it("does not follow a link that leads out of the mount", async () => {
    const { scope, hq } = await withMount();
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "nope", "utf8");
    try {
      await symlink(outside, join(hq, "escape"), "junction");
    } catch {
      return;
    }
    expect(await code(scope.readText("hq:escape/secret.md"))).toBe("outside");
  });

  it("reports the trust of a mount: owner is the owner's own words, anything else is untrusted", async () => {
    const owner = await withMount("owner");
    expect(owner.scope.isOwnerText("hq:03_Global_Assets/frameworks/standards.md")).toBe(true);
    expect(owner.scope.isOwnerText("context/note.md")).toBe(true);
    const other = await withMount("untrusted", "m2");
    expect(other.scope.isOwnerText("hq:03_Global_Assets/frameworks/standards.md")).toBe(false);
  });

  it("a mount whose folder does not exist is simply not mounted", async () => {
    const dir = await workspace("n");
    const scope = await scopeFor(dir, { mounts: [{ name: "gone", path: join(root, "nowhere"), trust: "owner" }] });
    expect(await code(scope.readText("gone:x.md"))).toBe("denied");
  });
});
