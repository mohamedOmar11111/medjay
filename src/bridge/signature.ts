// Webhook signature checks. Every request is verified before its body is even parsed.
//   whatsapp_cloud_api: header X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, app secret> (Meta's documented scheme).
//   respond_io_webhook: header X-Webhook-Signature: <hex HMAC-SHA256 of the raw body> (ASSUMED; confirm against Respond.io's docs).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Provider } from "./types.js";

const HEADER: Record<Provider, string> = { whatsapp_cloud_api: "x-hub-signature-256", respond_io_webhook: "x-webhook-signature" };
const PREFIX: Record<Provider, string> = { whatsapp_cloud_api: "sha256=", respond_io_webhook: "" };

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

export function signBody(provider: Provider, rawBody: string, secret: string): Record<string, string> {
  return { [HEADER[provider]]: `${PREFIX[provider]}${hmac(secret, rawBody)}` };
}

export function verifySignature(provider: Provider, rawBody: string, headers: Record<string, string | undefined>, secret: string): boolean {
  if (secret === "") return false;
  const given = header(headers, HEADER[provider]);
  if (!given || !given.startsWith(PREFIX[provider])) return false;
  const a = Buffer.from(given.slice(PREFIX[provider].length), "utf8");
  const b = Buffer.from(hmac(secret, rawBody), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
