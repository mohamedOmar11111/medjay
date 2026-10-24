// A WordPress post through the real CLI: draft -> plan bound to that version and hash -> approve -> strike
// -> validate-export, then what happens when the draft is changed afterwards. The signing key comes from
// MEDJAY_SIGNING_KEY and the workspace id is unique, so nothing is written to the real OS keychain.
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDraftChecker } from "../drafts/checker.js";
import { DraftStore } from "../drafts/store.js";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "dist", "cli.js"); // built once by test/global-setup.ts
const KEY = Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
let root: string;
let dir: string;
let sha: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--workspace", dir], { cwd: REPO, timeout: 150_000, env: { ...process.env, MEDJAY_SIGNING_KEY: KEY } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const proposalFile = async (name: string, over: Record<string, unknown> = {}, draftSha = sha) => {
  const path = join(root, name);
  await writeFile(path, JSON.stringify({ proposals: [{ type: "publish_post", site: "etlaala-trips", draft: { workflow: "posts", slug: "umrah-guide", version: 1, sha256: draftSha }, title: "Umrah in Ramadan: a calm guide", ...over }] }), "utf8");
  return path;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-publish-cli-"));
  const id = `pub-${randomBytes(4).toString("hex")}`;
  dir = join(root, id);
  await exec(process.execPath, [CLI, "init", dir, "--id", id, "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
  const drafts = new DraftStore(dir, { checker: await createDraftChecker(dir) });
  const meta = await drafts.save({ workflow: "posts", slug: "umrah-guide", kind: "post", text: "# Umrah in Ramadan\n\nPlan early and pack light.\n\n- Passport\n- Visa", author: "cli:test" });
  sha = meta.sha256;
}, 90_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a WordPress post, from draft to export file", () => {
  it("proposes a plan bound to the draft, shows it in the diff, approves and strikes it, and validates the export", async () => {
    const proposed = await mdj("plan", "new", "--from", await proposalFile("ok.json"));
    expect(proposed.code, proposed.stderr + proposed.stdout).toBe(0);
    const diff = await mdj("diff", "1");
    expect(diff.stdout).toMatch(/publish_post {2}wordpress:etlaala-trips/);
    expect(diff.stdout).toContain(`sha256 ${sha}`);
    const approved = await mdj("approve", "1");
    expect(approved.code, approved.stderr + approved.stdout).toBe(0);
    const struck = await mdj("strike", "1");
    expect(struck.code, struck.stderr + struck.stdout).toBe(0);
    expect(struck.stdout).toMatch(/plan #1: exported/);
    const valid = await mdj("validate-export", "1");
    expect(valid.code, valid.stdout + valid.stderr).toBe(0);
    expect(valid.stdout).toMatch(/export VALID \(checked manifest.json, wordpress-posts.json\)/);
    const file = JSON.parse(await readFile(join(dir, "exports", (await mdj("plan", "show", "1")).stdout.match(/pl_[0-9a-f]{12}/)![0], "wordpress-posts.json"), "utf8")) as { requests: { params: { status: string; content: string }; draft: { sha256: string } }[] };
    expect(file.requests[0]!.params.status).toBe("draft");
    expect(file.requests[0]!.params.content).toContain("<li>Passport</li>");
    expect(file.requests[0]!.draft.sha256).toBe(sha);
  });

  it("refuses a plan bound to a hash the draft does not have", async () => {
    const r = await mdj("plan", "new", "--from", await proposalFile("stale.json", { title: "Another title" }, "c".repeat(64)));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/sha256/);
  });

  it("cannot roll back a publication, and says how to take the post down", async () => {
    const r = await mdj("rollback", "1");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Medjay cannot take a post down/);
  });

  it("refuses a plan that publishes more posts than the daily cap allows, and says which limit", async () => {
    const file = join(dir, "shield.policy.yaml");
    const original = await readFile(file, "utf8");
    expect(original).toMatch(/max_posts_per_day: 5/);
    await writeFile(file, original.replace("max_posts_per_day: 5", "max_posts_per_day: 0"), "utf8");
    try {
      const r = await mdj("plan", "new", "--from", await proposalFile("capped.json", { title: "A third title" }));
      expect(r.code).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/max_posts_per_day/);
    } finally {
      await writeFile(file, original, "utf8");
    }
  });

  it("stops the export from validating once the draft has been changed", async () => {
    await writeFile(join(dir, "drafts", "posts", "umrah-guide", "v1.md"), "edited after the strike", "utf8");
    const r = await mdj("validate-export", "1");
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/changed after it was saved/);
  });
});
