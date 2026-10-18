// Guard for "never store plaintext secrets or raw phone numbers in workspace.yaml (or any
// git-tracked file)". Reports where a leak is (a path), never the value.
//
// A key is flagged when its normalized name ENDS in a secret word (api_key, client_secret,
// webhook_token, password, ...). Names that merely contain one (log_token_telemetry, max_tokens)
// and reference keys (api_token_ref, keychain_ref) are fine.
const SECRET_KEY_SUFFIXES = [
  "apikey",
  "secret",
  "secretkey",
  "password",
  "passwd",
  "token",
  "authorization",
  "bearer",
  "privatekey",
  "accesskey",
];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** A whole value that is an E.164 number (+ then 8-15 digits). */
const PHONE_NUMBER = /^\+[1-9]\d{7,14}$/;

export interface SecretLeak {
  path: string;
  reason: "key_name" | "value_pattern" | "phone_number";
}

const REFERENCE_KEYS = new Set(["keychain_ref", "env_fallback"]);

/** { keychain_ref, env_fallback }: a pointer to where a secret lives, not the secret. */
const isReferenceObject = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => REFERENCE_KEYS.has(key));

const looksLikeSecretKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
};

/** Replace provider-key-shaped values in free text. Used before text reaches a model prompt or a log. */
export function redactSecretValues(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), () => {
      count += 1;
      return "[REDACTED_SECRET]";
    });
  }
  return { text: out, count };
}

export function findSecretLeaks(value: unknown, path = ""): SecretLeak[] {
  if (typeof value === "string") {
    if (PHONE_NUMBER.test(value)) return [{ path, reason: "phone_number" }];
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ? [{ path, reason: "value_pattern" }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecretLeaks(item, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => {
      const childPath = path === "" ? key : `${path}.${key}`;
      const own: SecretLeak[] =
        looksLikeSecretKey(key) && !isReferenceObject(child) ? [{ path: childPath, reason: "key_name" }] : [];
      const nested = own.length > 0 && typeof child !== "object" ? [] : findSecretLeaks(child, childPath);
      return [...own, ...nested];
    });
  }
  return [];
}
