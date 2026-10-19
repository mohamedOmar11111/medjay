// The bridge through the real CLI, with no tunnel: `mdj bridge simulate-webhook` builds a signed
// provider-format request and handles it in process against a real workspace.
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyLedger } from "../audit/ledger.js";
import { hashE164 } from "../shield/policy.js";

vi.setConfig({ testTimeout: 180_000 });

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js"); // built once by test/global-setup.ts
const KEY = Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
const OMAR = "+966551234567";
let root: string;
let dir: string;

async function mdj(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--workspace", dir], { cwd: REPO, timeout: 150_000, env: { ...process.env, MEDJAY_SIGNING_KEY: KEY } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const hook = (...a: string[]) => mdj("bridge", "simulate-webhook", ...a);

let short = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-bridge-cli-"));
  const id = `bridge-${randomBytes(4).toString("hex")}`;
  dir = join(root, id);
  await exec(process.execPath, [CLI, "init", dir, "--id", id, "--currency", "SAR", "--business-type", "agency"], { cwd: REPO });
  const file = join(dir, "shield.policy.yaml");
  const policy = parse(await readFile(file, "utf8")) as Record<string, any>;
  policy.whatsapp = { approvers: [{ name: "omar", sender: { sha256: hashE164(OMAR) }, clients: ["*"], can: ["query", "strike", "hold", "drop"] }] };
  await writeFile(file, stringify(policy), "utf8");
  const proposals = join(root, "p.json");
  await writeFile(proposals, JSON.stringify({ proposals: [{ type: "status_change", target: { platform: "meta", kind: "adset", id: "120200000000001", name: "UMRAH-ALL-Broad-Reels" }, from: "ENABLED", to: "PAUSED" }] }), "utf8");
  const created = await mdj("plan", "new", "--from", proposals);
  short = /hash ([0-9a-f]{64})/.exec(created.stdout)![1]!.slice(0, 8);
}, 120_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mdj bridge simulate-webhook", () => {
  it("refuses a request with a bad signature (HTTP 401, exit 1)", async () => {
    const r = await hook("--from", OMAR, "--text", "STATUS", "--bad-signature");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^HTTP 401/);
  });

  it("gives an unauthorized sender no reply and leaves the plan alone", async () => {
    const r = await hook("--from", "+971500000000", "--text", `STRIKE 1 ${short}`);
    expect(r.stdout).toMatch(/outcome=rejected:unknown_sender/);
    expect(r.stdout).toMatch(/no reply is sent/);
    expect((await mdj("plan", "show", "1")).stdout).toMatch(/\[proposed\]/);
  });

  it("a voice note that says STRIKE with the right hash is refused and the plan stays proposed", async () => {
    const r = await hook("--kind", "voice", "--from", OMAR, "--text", `strike 1 ${short}`);
    expect(r.stdout).toMatch(/outcome=refused:voice/);
    expect(r.stdout).toMatch(/Voice notes can only ask for reports/);
    expect((await mdj("plan", "show", "1")).stdout).toMatch(/\[proposed\]/);
    const flagged = await hook("--kind", "voice_text", "--from", OMAR, "--text", `STRIKE 1 ${short}`);
    expect(flagged.stdout).toMatch(/outcome=refused:voice/);
  });

  it("an approval prompt carries the short hash, signed buttons and the ledger head", async () => {
    const r = await hook("--from", OMAR, "--text", "STRIKE 1");
    expect(r.stdout).toContain(`STRIKE 1 ${short}`);
    expect(r.stdout).toMatch(/Ledger head [0-9a-f]{12} \(entry \d+\)/);
    expect(r.stdout).toMatch(/buttons: \[STRIKE 1\] STRIKE:1:[0-9a-f]{8}:[0-9a-f]{16}/);
  });

  it("a typed STRIKE from the approver approves and exports the plan; replaying the message id does nothing", async () => {
    const first = await hook("--from", OMAR, "--text", `STRIKE 1 ${short}`, "--message-id", "wamid.demo-1");
    expect(first.code, first.stderr + first.stdout).toBe(0);
    expect(first.stdout).toMatch(/Plan #1 exported/);
    expect((await mdj("plan", "show", "1")).stdout).toMatch(/approved by whatsapp:omar via whatsapp/);
    const replay = await hook("--from", OMAR, "--text", `STRIKE 1 ${short}`, "--message-id", "wamid.demo-1");
    expect(replay.stdout).toMatch(/HTTP 200\n\(no reply is sent\)/);
  });

  it("works in the Respond.io format too, and the ledger stays verifiable", async () => {
    const r = await hook("--preset", "respond_io", "--from", OMAR, "--text", "status");
    expect(r.stdout).toMatch(/outcome=ok/);
    expect(r.stdout).toMatch(/1 exported/);
    expect(await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"))).toMatchObject({ ok: true });
    const log = await readFile(join(dir, ".medjay", "audit-log.jsonl"), "utf8");
    expect(log).not.toContain("966551234567");
  });
});
