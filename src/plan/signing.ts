// Approvals are signed with an ed25519 key so that editing the database cannot forge one.
// The private key lives in the OS keychain (or MEDJAY_SIGNING_KEY, base64 of a PKCS8 PEM, for
// headless use). Only the public key is written to the workspace. Nothing here prints a key.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../audit/canonical.js";
import type { KeyStore } from "../models/credentials.js";

export const SIGNING_ENV = "MEDJAY_SIGNING_KEY";

export interface SigningKeys {
  privateKeyPem: string;
  publicKeyPem: string;
  source: "generated" | "keychain" | "env";
}

export interface EnsureSigningKeyOptions {
  dir: string;
  workspaceId: string;
  keystore: KeyStore;
  env: NodeJS.ProcessEnv;
}

const refFor = (workspaceId: string) => `signing_${createHash("sha256").update(workspaceId, "utf8").digest("hex").slice(0, 12)}`;

function parsePrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an ed25519 key");
  return key;
}

const publicPemOf = (key: KeyObject) => createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
const privatePemOf = (key: KeyObject) => key.export({ type: "pkcs8", format: "pem" }).toString();

async function publishPublicKey(dir: string, publicKeyPem: string): Promise<void> {
  const folder = join(dir, ".medjay", "keys");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "signing.pub");
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== publicKeyPem) await writeFile(file, publicKeyPem, "utf8");
}

export async function ensureSigningKey(options: EnsureSigningKeyOptions): Promise<SigningKeys> {
  const ref = refFor(options.workspaceId);
  const finish = async (key: KeyObject, source: SigningKeys["source"]): Promise<SigningKeys> => {
    const keys = { privateKeyPem: privatePemOf(key), publicKeyPem: publicPemOf(key), source };
    await publishPublicKey(options.dir, keys.publicKeyPem);
    return keys;
  };

  let stored: string | null = null;
  try {
    stored = await options.keystore.get(ref);
  } catch {
    // no keychain here: fall through to the environment
  }
  if (stored) {
    try {
      return await finish(parsePrivateKey(Buffer.from(stored, "base64").toString("utf8")), "keychain");
    } catch {
      throw new Error(`the signing key stored in the keychain for this workspace (${ref}) is unreadable; remove it and retry`);
    }
  }

  const fromEnv = options.env[SIGNING_ENV]?.trim();
  if (fromEnv) {
    try {
      return await finish(parsePrivateKey(Buffer.from(fromEnv, "base64").toString("utf8")), "env");
    } catch {
      throw new Error(`${SIGNING_ENV} is not a base64-encoded ed25519 PKCS8 PEM private key`);
    }
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  try {
    await options.keystore.set(ref, Buffer.from(privatePemOf(privateKey), "utf8").toString("base64"));
  } catch {
    throw new Error(
      `cannot store a signing key: the OS keychain is unavailable. Provide one through ${SIGNING_ENV} (base64 of an ed25519 PKCS8 PEM; generate with: node -e "const k=require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});console.log(Buffer.from(k).toString('base64'))")`,
    );
  }
  return finish(privateKey, "generated");
}

export interface ApprovalRecord {
  plan_id: string;
  plan_hash: string;
  approver: string;
  channel: string;
  ts: string;
  nonce: string;
}

export const approvalRecord = (fields: ApprovalRecord): ApprovalRecord => ({
  plan_id: fields.plan_id,
  plan_hash: fields.plan_hash,
  approver: fields.approver,
  channel: fields.channel,
  ts: fields.ts,
  nonce: fields.nonce,
});

export function signApproval(privateKeyPem: string, record: ApprovalRecord): string {
  return sign(null, Buffer.from(canonicalJson(record), "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyApproval(publicKeyPem: string, record: ApprovalRecord, signature: string): boolean {
  try {
    if (signature === "") return false;
    return verify(null, Buffer.from(canonicalJson(record), "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
