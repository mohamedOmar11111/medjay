import { describe, expect, it } from "vitest";
import { findSecretLeaks, redactSecretValues } from "./secrets.js";

const paths = (value: unknown) => findSecretLeaks(value).map((l) => l.path).sort();

describe("findSecretLeaks: key names", () => {
  it("flags keys that name a secret", () => {
    expect(
      paths({ api_key: "x", apiKey: "x", password: "x", client_secret: "x", webhook_token: "x", authorization: "x", bearer: "x", private_key: "x" }),
    ).toEqual(["apiKey", "api_key", "authorization", "bearer", "client_secret", "password", "private_key", "webhook_token"]);
  });

  it("flags nested keys with their full path and never echoes values", () => {
    const leaks = findSecretLeaks({ models: { slots: { fast: { api_key: "hunter2hunter2" } } } });
    expect(leaks).toEqual([{ path: "models.slots.fast.api_key", reason: "key_name" }]);
    expect(JSON.stringify(leaks)).not.toContain("hunter2");
  });

  it("does not flag reference keys or ordinary names that merely contain the word token", () => {
    expect(
      paths({
        log_token_telemetry: true,
        max_tokens: 1000,
        tokens_per_minute: 5,
        keychain_ref: "anthropic_default",
        env_fallback: "MEDJAY_ANTHROPIC_API_KEY",
        api_token_ref: { keychain_ref: "wa_token", env_fallback: "MEDJAY_WA_API_TOKEN" },
        webhook_secret_ref: { keychain_ref: "wa_secret", env_fallback: "MEDJAY_WA_WEBHOOK_SECRET" },
        timeout_ms: 1000,
        passwordless: true,
      }),
    ).toEqual([]);
  });
});

describe("findSecretLeaks: reference objects", () => {
  it("allows a secret-named key whose value is only a keychain/env reference", () => {
    expect(
      paths({ credentials: { api_token: { keychain_ref: "wa_api", env_fallback: "MEDJAY_WA_API" }, webhook_secret: { keychain_ref: "wa_sec", env_fallback: "MEDJAY_WA_SEC" } } }),
    ).toEqual([]);
  });

  it("still flags a secret-named key holding anything else, including a nested plaintext value", () => {
    expect(paths({ api_token: { value: "plain" } })).toEqual(["api_token"]);
    expect(paths({ api_token: { keychain_ref: "x", value: "plain" } })).toEqual(["api_token"]);
    expect(paths({ api_token: {} })).toEqual(["api_token"]);
  });
});

describe("redactSecretValues", () => {
  it("replaces provider-key-shaped values anywhere in free text and counts them", () => {
    const out = redactSecretValues("use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 or AIzaSyA1234567890abcdefghijklmnopqrstuvw now");
    expect(out.text).toBe("use [REDACTED_SECRET] or [REDACTED_SECRET] now");
    expect(out.count).toBe(2);
  });

  it("leaves ordinary text alone, and works repeatedly (no regex state leaks between calls)", () => {
    expect(redactSecretValues("nothing secret here: 12345 and MEDJAY_ANTHROPIC_API_KEY")).toEqual({ text: "nothing secret here: 12345 and MEDJAY_ANTHROPIC_API_KEY", count: 0 });
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecretValues(key).count).toBe(1);
    expect(redactSecretValues(key).count).toBe(1);
  });
});

describe("findSecretLeaks: values", () => {
  it("flags values shaped like provider keys under innocent key names", () => {
    expect(
      paths({
        note: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        other: { value: "AIzaSyA1234567890abcdefghijklmnopqrstuvw" },
        list: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
        pem: "-----BEGIN PRIVATE KEY-----",
      }),
    ).toEqual(["list[0]", "note", "other.value", "pem"]);
  });

  it("flags raw phone numbers so they stay out of git-tracked files", () => {
    const leaks = findSecretLeaks({ owner: "+201000000000", nested: { who: "+966512345678" } });
    expect(leaks).toEqual([
      { path: "owner", reason: "phone_number" },
      { path: "nested.who", reason: "phone_number" },
    ]);
  });

  it("does not flag numeric ids, hashes or ordinary text", () => {
    expect(
      paths({
        channel_id: "1234567890",
        phone_number_id: "109876543210987",
        hash: "a".repeat(64),
        text: "call +20 for help",
        date: "2026-10-17",
      }),
    ).toEqual([]);
  });
});
