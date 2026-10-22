import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { resolveClientFiles } from "./client-files.js";
import { RunScope } from "./scope.js";

let root: string;
let dir: string;
let hq: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-clientfiles-"));
  dir = join(root, "ws");
  hq = join(root, "hq");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  await mkdir(join(hq, "01_Active_Clients", "etlaala"), { recursive: true });
  await writeFile(join(hq, "01_Active_Clients", "etlaala", "icp.md"), "icp", "utf8");
  await writeFile(join(hq, "01_Active_Clients", "etlaala", "icp-etlaala-com.md"), "icp com", "utf8");
  await writeFile(join(hq, "01_Active_Clients", "etlaala", "icp-etlaala-net.md"), "icp net", "utf8");
  await writeFile(join(hq, "01_Active_Clients", "etlaala", "MARKETING-AUDIT.md"), "audit", "utf8");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const scopeWith = (withMount = true) =>
  RunScope.create({
    workspaceDir: dir,
    workspaceId: "ws",
    dropzoneDir: join(dir, "data", "imports"),
    mounts: withMount ? [{ name: "hq", path: hq, trust: "owner", allow: ["01_Active_Clients/etlaala"] }] : [],
  });
const CLIENT = { mount: "hq", folder: "01_Active_Clients/etlaala" };
const byName = (files: Awaited<ReturnType<typeof resolveClientFiles>>) => Object.fromEntries(files.map((f) => [f.name, f]));

describe("resolveClientFiles", () => {
  it("finds the client's own file in its HQ folder, lists the variants, and falls back to Medjay's own files", async () => {
    const files = byName(await resolveClientFiles(await scopeWith(), CLIENT));
    expect(files["icp.md"]).toMatchObject({ found: "hq:01_Active_Clients/etlaala/icp.md", via: "client_folder" });
    expect(files["icp.md"]!.related.sort()).toEqual(["hq:01_Active_Clients/etlaala/icp-etlaala-com.md", "hq:01_Active_Clients/etlaala/icp-etlaala-net.md"]);
    expect(files["brand.md"]).toMatchObject({ found: "context/brand-voice.md", via: "native" });
    expect(files["offers.md"]).toMatchObject({ found: "context/offer-matrix.md", via: "native" });
    expect(files["STRATEGY.md"]).toMatchObject({ found: null, via: null });
  });

  it("prefers a file in the workspace itself over the HQ folder", async () => {
    await writeFile(join(dir, "context", "icp.md"), "workspace icp", "utf8");
    const files = byName(await resolveClientFiles(await scopeWith(), CLIENT));
    expect(files["icp.md"]).toMatchObject({ found: "context/icp.md", via: "workspace" });
  });

  it("works in a standalone workspace with no mount at all", async () => {
    const files = byName(await resolveClientFiles(await scopeWith(false), undefined));
    expect(files["icp.md"]).toMatchObject({ found: null, via: null, related: [] });
    expect(files["brand.md"]).toMatchObject({ found: "context/brand-voice.md", via: "native" });
  });

  it("does not look in another client's folder even if it is named", async () => {
    const files = byName(await resolveClientFiles(await scopeWith(), { mount: "hq", folder: "01_Active_Clients/aqarverse" }));
    expect(files["icp.md"]).toMatchObject({ found: null, via: null });
  });
});

describe("resolveClientFiles with unusual names", () => {
  it("treats a name as plain text, never as a pattern", async () => {
    const scope = await scopeWith();
    const files = await resolveClientFiles(scope, CLIENT, ["(a+)+$.md", "icp.md"]);
    expect(files.find((f) => f.name === "(a+)+$.md")).toMatchObject({ found: null, related: [] });
    expect(files.find((f) => f.name === "icp.md")!.related).toHaveLength(2);
  });
});
