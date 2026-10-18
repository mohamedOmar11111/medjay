// Credential resolution, in strict order:
//   1. OS keychain (@napi-rs/keyring): primary for local CLI use on Windows, macOS, Linux.
//   2. A MEDJAY_* environment variable: headless Linux, CI, Docker, Cloud Run.
// A credential is addressed by a reference {keychainRef, envFallback}, so one provider can have
// several keys (for example one per client). Vendor-standard variables (ANTHROPIC_API_KEY, ...)
// are unreachable by construction: only MEDJAY_* names are accepted. Secrets are never written to
// workspace files, plans, logs, or error messages; this is the only module that reads them.
import { randomBytes } from "node:crypto";
import type { Provider } from "./slots.js";

export const KEYCHAIN_SERVICE = "medjay";
export const ENV_REF_PATTERN = /^MEDJAY_[A-Z0-9][A-Z0-9_]*$/;
export const KEYCHAIN_REF_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export type CredentialSource = "keychain" | "env" | "none";

export interface CredentialRef {
  keychainRef: string;
  envFallback: string;
}

export interface KeyStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export function envVarName(provider: Provider): string {
  return `MEDJAY_${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** The reference used when a slot target does not set keychain_ref / env_fallback. */
export function defaultRef(provider: Provider): CredentialRef {
  return { keychainRef: provider, envFallback: envVarName(provider) };
}

export class KeyringStore implements KeyStore {
  private modulePromise: Promise<typeof import("@napi-rs/keyring")> | undefined;

  private async entry(account: string) {
    this.modulePromise ??= import("@napi-rs/keyring");
    const { AsyncEntry } = await this.modulePromise;
    return new AsyncEntry(KEYCHAIN_SERVICE, account);
  }

  async get(account: string): Promise<string | null> {
    return (await this.entry(account)).getPassword();
  }

  async set(account: string, secret: string): Promise<void> {
    await (await this.entry(account)).setPassword(secret);
  }

  async delete(account: string): Promise<boolean> {
    return (await this.entry(account)).deletePassword();
  }
}

export interface ResolvedCredential {
  source: CredentialSource;
  /** Present only when source is not "none". Never log or print this. */
  value?: string;
  /** Why the keychain could not be used, when it was skipped. */
  keychainError?: string;
}

export interface CredentialStatus extends CredentialRef {
  source: CredentialSource;
  keychainError?: string;
}

export interface CredentialResolverOptions {
  keystore?: KeyStore;
  env?: NodeJS.ProcessEnv;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function assertKeychainRef(ref: string): void {
  if (!KEYCHAIN_REF_PATTERN.test(ref)) {
    throw new Error(`invalid keychain reference "${ref}": use lowercase letters, digits, dot, dash or underscore`);
  }
}

function assertEnvRef(name: string): void {
  if (!ENV_REF_PATTERN.test(name)) {
    throw new Error(`invalid env reference "${name}": only MEDJAY_* variables may hold credentials`);
  }
}

export class CredentialResolver {
  private readonly keystore: KeyStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CredentialResolverOptions = {}) {
    this.keystore = options.keystore ?? new KeyringStore();
    this.env = options.env ?? process.env;
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
    assertKeychainRef(ref.keychainRef);
    assertEnvRef(ref.envFallback);
    let keychainError: string | undefined;
    try {
      const stored = (await this.keystore.get(ref.keychainRef))?.trim();
      if (stored) return { source: "keychain", value: stored };
    } catch (error) {
      keychainError = message(error);
    }
    const fromEnv = this.env[ref.envFallback]?.trim();
    const base: ResolvedCredential = fromEnv ? { source: "env", value: fromEnv } : { source: "none" };
    return keychainError === undefined ? base : { ...base, keychainError };
  }

  async status(ref: CredentialRef): Promise<CredentialStatus> {
    const { source, keychainError } = await this.resolve(ref);
    const status: CredentialStatus = { ...ref, source };
    if (keychainError !== undefined) status.keychainError = keychainError;
    return status;
  }

  async store(keychainRef: string, secret: string): Promise<void> {
    assertKeychainRef(keychainRef);
    const trimmed = secret.trim();
    if (trimmed === "") throw new Error("secret is empty");
    await this.keystore.set(keychainRef, trimmed);
  }

  async remove(keychainRef: string): Promise<boolean> {
    assertKeychainRef(keychainRef);
    return this.keystore.delete(keychainRef);
  }
}

/** Write, read back and delete a throwaway entry to prove the keychain works. */
export async function probeKeystore(
  keystore: KeyStore,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = "__doctor__";
  const secret = randomBytes(12).toString("hex");
  try {
    await keystore.set(account, secret);
    const read = await keystore.get(account);
    await keystore.delete(account);
    return read === secret ? { ok: true } : { ok: false, error: "keychain returned a different value than was written" };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
