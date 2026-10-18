// Sender allowlist. Approvers live in shield.policy.yaml and are identified by the SHA-256 of an
// E.164 number, or by a reference to where the number is kept (an environment variable or the OS
// keychain). A raw number never appears in a file. Comparison is constant time.
import { timingSafeEqual } from "node:crypto";
export { permissionFor } from "./commands.js";
import { hashE164, type Policy } from "../shield/policy.js";

export type Approver = Policy["whatsapp"]["approvers"][number];
type SenderRef = { env?: string; keychain_ref?: string };

export interface SenderResolver {
  /** The E.164 number a reference points to, or undefined when it is not set. */
  resolve(ref: SenderRef): Promise<string | undefined>;
}

export type SenderAuth = { ok: true; approver: Approver; hash: string } | { ok: false; reason: "malformed_sender" | "unknown_sender" | "client_not_allowed" };

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function hashOf(approver: Approver, resolver: SenderResolver): Promise<string | undefined> {
  const sender = approver.sender as { sha256?: string; env?: string; keychain_ref?: string };
  if (sender.sha256) return sender.sha256;
  const number = await resolver.resolve(sender);
  if (!number) return undefined;
  try {
    return hashE164(number);
  } catch {
    return undefined;
  }
}

export async function authorizeSender(policy: Policy, e164: string, client: string, resolver: SenderResolver): Promise<SenderAuth> {
  let hash: string;
  try {
    hash = hashE164(e164);
  } catch {
    return { ok: false, reason: "malformed_sender" };
  }
  let blockedByClient = false;
  for (const approver of policy.whatsapp.approvers) {
    const theirs = await hashOf(approver, resolver);
    if (theirs === undefined || !same(theirs, hash)) continue;
    if (approver.clients.includes("*") || approver.clients.includes(client)) return { ok: true, approver, hash };
    blockedByClient = true;
  }
  return { ok: false, reason: blockedByClient ? "client_not_allowed" : "unknown_sender" };
}
