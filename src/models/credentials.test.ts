import { describe, expect, it } from "vitest";
import { CredentialResolver, defaultRef, envVarName, type KeyStore } from "./credentials.js";

function memoryStore(initial: Record<string, string> = {}): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(account) {
      return data.get(account) ?? null;
    },
    async set(account, secret) {
      data.set(account, secret);
    },
    async delete(account) {
      return data.delete(account);
    },
  };
}

const brokenStore: KeyStore = {
  async get() {
    throw new Error("no secret service available");
  },
  async set() {
    throw new Error("no secret service available");
  },
  async delete() {
    throw new Error("no secret service available");
  },
};

describe("references", () => {
  it("builds MEDJAY_<PROVIDER>_API_KEY and defaults the keychain account to the provider id", () => {
    expect(envVarName("anthropic")).toBe("MEDJAY_ANTHROPIC_API_KEY");
    expect(envVarName("google")).toBe("MEDJAY_GOOGLE_API_KEY");
    expect(envVarName("openai_compatible")).toBe("MEDJAY_OPENAI_COMPATIBLE_API_KEY");
    expect(defaultRef("anthropic")).toEqual({ keychainRef: "anthropic", envFallback: "MEDJAY_ANTHROPIC_API_KEY" });
  });
});

describe("CredentialResolver order: keychain, then MEDJAY_* env, nothing else", () => {
  it("prefers the keychain over the environment", async () => {
    const resolver = new CredentialResolver({
      keystore: memoryStore({ anthropic: "from-keychain" }),
      env: { MEDJAY_ANTHROPIC_API_KEY: "from-env" },
    });
    expect(await resolver.resolve(defaultRef("anthropic"))).toMatchObject({ source: "keychain", value: "from-keychain" });
  });

  it("falls back to the environment variable named by the reference, trimming whitespace", async () => {
    const resolver = new CredentialResolver({ keystore: memoryStore(), env: { MEDJAY_GOOGLE_API_KEY: "  from-env \n" } });
    expect(await resolver.resolve(defaultRef("google"))).toMatchObject({ source: "env", value: "from-env" });
  });

  it("supports several credentials per provider through keychain_ref and env_fallback", async () => {
    const resolver = new CredentialResolver({
      keystore: memoryStore({ client_a: "key-a" }),
      env: { MEDJAY_CLIENT_B_KEY: "key-b" },
    });
    expect(await resolver.resolve({ keychainRef: "client_a", envFallback: "MEDJAY_CLIENT_A_KEY" })).toMatchObject({ source: "keychain", value: "key-a" });
    expect(await resolver.resolve({ keychainRef: "client_b", envFallback: "MEDJAY_CLIENT_B_KEY" })).toMatchObject({ source: "env", value: "key-b" });
    expect((await resolver.resolve({ keychainRef: "client_c", envFallback: "MEDJAY_CLIENT_C_KEY" })).source).toBe("none");
  });

  it("refuses an env reference that is not MEDJAY_*, so vendor variables are unreachable", async () => {
    const resolver = new CredentialResolver({ keystore: memoryStore(), env: { ANTHROPIC_API_KEY: "vendor", PATH: "/bin" } });
    await expect(resolver.resolve({ keychainRef: "x", envFallback: "ANTHROPIC_API_KEY" })).rejects.toThrow(/MEDJAY_/);
    await expect(resolver.resolve({ keychainRef: "x", envFallback: "PATH" })).rejects.toThrow(/MEDJAY_/);
  });

  it("never reads vendor-standard variables for default references", async () => {
    const resolver = new CredentialResolver({
      keystore: memoryStore(),
      env: { ANTHROPIC_API_KEY: "vendor", OPENAI_API_KEY: "vendor", GEMINI_API_KEY: "vendor" },
    });
    for (const p of ["anthropic", "openai", "google"] as const) {
      expect((await resolver.resolve(defaultRef(p))).source).toBe("none");
    }
  });

  it("reports none for unset or blank values", async () => {
    const resolver = new CredentialResolver({ keystore: memoryStore(), env: { MEDJAY_OPENAI_API_KEY: "   " } });
    expect(await resolver.resolve(defaultRef("openai"))).toMatchObject({ source: "none" });
  });

  it("falls back to env when the keychain is unavailable and says why", async () => {
    const resolver = new CredentialResolver({ keystore: brokenStore, env: { MEDJAY_ANTHROPIC_API_KEY: "from-env" } });
    const result = await resolver.resolve(defaultRef("anthropic"));
    expect(result).toMatchObject({ source: "env", value: "from-env" });
    expect(result.keychainError).toMatch(/no secret service/);
  });

  it("status never includes the secret value", async () => {
    const resolver = new CredentialResolver({
      keystore: memoryStore({ anthropic: "super-secret-value" }),
      env: { MEDJAY_GOOGLE_API_KEY: "another-secret" },
    });
    const text = JSON.stringify([await resolver.status(defaultRef("anthropic")), await resolver.status(defaultRef("google"))]);
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("another-secret");
    expect(await resolver.status(defaultRef("anthropic"))).toMatchObject({ source: "keychain", keychainRef: "anthropic" });
  });

  it("stores and deletes under a reference, rejecting empty secrets", async () => {
    const store = memoryStore();
    const resolver = new CredentialResolver({ keystore: store, env: {} });
    await resolver.store("client_a", "  abc  ");
    expect(store.data.get("client_a")).toBe("abc");
    await expect(resolver.store("client_a", "   ")).rejects.toThrow(/empty/);
    await expect(resolver.store("client_a", "sk-ant-\u0016abc")).rejects.toThrow(/control or space/);
    await expect(resolver.store("client_a", "sk ant")).rejects.toThrow(/control or space/);
    expect(await resolver.remove("client_a")).toBe(true);
    expect(await resolver.remove("client_a")).toBe(false);
  });

  it("rejects keychain references that are not well-formed", async () => {
    const resolver = new CredentialResolver({ keystore: memoryStore(), env: {} });
    await expect(resolver.store("../escape", "abc")).rejects.toThrow(/keychain reference/);
  });
});
