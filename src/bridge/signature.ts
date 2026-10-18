// Webhook signature checks. Every request is verified before its body is even parsed. The relay signs
// the raw body with HMAC-SHA256 and the shared secret; the header name and how the digest is written
// come from the webhook spec:
//   hex            the digest as lowercase hex
//   base64         the digest as base64
//   sha256_prefix  "sha256=" followed by hex (Meta's X-Hub-Signature-256)
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureFormat, WebhookSpec } from "./webhook-spec.js";

const digest = (secret: string, body: string, format: SignatureFormat): string => {
  const mac = createHmac("sha256", secret).update(body, "utf8");
  if (format === "base64") return mac.digest("base64");
  return `${format === "sha256_prefix" ? "sha256=" : ""}${mac.digest("hex")}`;
};

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

export function signBody(spec: Pick<WebhookSpec, "signature_header" | "signature_format">, rawBody: string, secret: string): Record<string, string> {
  return { [spec.signature_header]: digest(secret, rawBody, spec.signature_format) };
}

export function verifySignature(spec: Pick<WebhookSpec, "signature_header" | "signature_format">, rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean {
  if (secret === "") return false;
  const given = header(headers, spec.signature_header);
  if (!given) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(digest(secret, rawBody, spec.signature_format), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
