import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brokenKeystore, memoryKeystore } from "../../test/helpers/keystore.js";
import { approvalRecord, ensureSigningKey, signApproval, verifyApproval } from "./signing.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-sign-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = () =>
  approvalRecord({ plan_id: "pl_abc", plan_hash: "a".repeat(64), approver: "cli:omar", channel: "cli", ts: "2026-10-17T10:00:00.000Z", nonce: "nonce-1" });

describe("ensureSigningKey", () => {
  it("generates a key pair on first use, keeps the private key in the keychain and publishes the public key", async () => {
    const keystore = memoryKeystore();
    const keys = await ensureSigningKey({ dir, workspaceId: "etlaala-ksa", keystore, env: {} });
    expect(keys.source).toBe("generated");
    expect(keys.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect([...keystore.data.keys()].some((k) => k.startsWith("signing_"))).toBe(true);
    expect(await readFile(join(dir, ".medjay", "keys", "signing.pub"), "utf8")).toBe(keys.publicKeyPem);
    expect((await stat(join(dir, ".medjay", "keys"))).isDirectory()).toBe(true);
  });

  it("reuses the stored key on later calls", async () => {
    const keystore = memoryKeystore();
    const first = await ensureSigningKey({ dir, workspaceId: "ws", keystore, env: {} });
    const second = await ensureSigningKey({ dir, workspaceId: "ws", keystore, env: {} });
    expect(second.source).toBe("keychain");
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it("keeps different workspaces' keys apart", async () => {
    const keystore = memoryKeystore();
    const a = await ensureSigningKey({ dir: join(dir, "a"), workspaceId: "ws-a", keystore, env: {} });
    const b = await ensureSigningKey({ dir: join(dir, "b"), workspaceId: "ws-b", keystore, env: {} });
    expect(a.publicKeyPem).not.toBe(b.publicKeyPem);
  });

  it("accepts a key supplied through MEDJAY_SIGNING_KEY when there is no keychain", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keys = await ensureSigningKey({ dir, workspaceId: "ws", keystore: brokenKeystore, env: { MEDJAY_SIGNING_KEY: Buffer.from(pem).toString("base64") } });
    expect(keys.source).toBe("env");
    expect(keys.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("explains how to supply a key when neither keychain nor environment is available", async () => {
    await expect(ensureSigningKey({ dir, workspaceId: "ws", keystore: brokenKeystore, env: {} })).rejects.toThrow(/MEDJAY_SIGNING_KEY/);
  });

  it("rejects a malformed MEDJAY_SIGNING_KEY without echoing it", async () => {
    const error = await ensureSigningKey({ dir, workspaceId: "ws", keystore: brokenKeystore, env: { MEDJAY_SIGNING_KEY: "not-a-key-secret-value" } }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain("not-a-key-secret-value");
  });
});

describe("signApproval / verifyApproval", () => {
  it("round-trips and detects any change to the record", async () => {
    const keys = await ensureSigningKey({ dir, workspaceId: "ws", keystore: memoryKeystore(), env: {} });
    const signature = signApproval(keys.privateKeyPem, record());
    expect(verifyApproval(keys.publicKeyPem, record(), signature)).toBe(true);
    for (const change of [{ plan_hash: "b".repeat(64) }, { approver: "cli:other" }, { channel: "whatsapp" }, { nonce: "nonce-2" }, { plan_id: "pl_zzz" }]) {
      expect(verifyApproval(keys.publicKeyPem, { ...record(), ...change }, signature), JSON.stringify(change)).toBe(false);
    }
  });

  it("rejects a signature made with a different key and malformed signatures", async () => {
    const a = await ensureSigningKey({ dir: join(dir, "a"), workspaceId: "a", keystore: memoryKeystore(), env: {} });
    const b = await ensureSigningKey({ dir: join(dir, "b"), workspaceId: "b", keystore: memoryKeystore(), env: {} });
    const signature = signApproval(a.privateKeyPem, record());
    expect(verifyApproval(b.publicKeyPem, record(), signature)).toBe(false);
    expect(verifyApproval(a.publicKeyPem, record(), "")).toBe(false);
    expect(verifyApproval(a.publicKeyPem, record(), "!!!not base64!!!")).toBe(false);
  });
});
