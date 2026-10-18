import { describe, expect, it } from "vitest";
import { safeChildEnv } from "./env.js";

const parent = {
  PATH: "/usr/bin",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  HOME: "/home/omar",
  LANG: "en_US.UTF-8",
  MEDJAY_ANTHROPIC_API_KEY: "sk-ant-secret",
  MEDJAY_SIGNING_KEY: "pem",
  ANTHROPIC_API_KEY: "vendor",
  GITHUB_TOKEN: "ghp_x",
  AWS_SECRET_ACCESS_KEY: "aws",
  DATABASE_PASSWORD: "pw",
  NODE_OPTIONS: "--require evil.js",
  RANDOM_THING: "hello",
};

describe("safeChildEnv", () => {
  it("passes only a small whitelist of harmless variables", () => {
    const env = safeChildEnv(parent);
    expect(env).toEqual({ PATH: "/usr/bin", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", HOME: "/home/omar", LANG: "en_US.UTF-8" });
  });

  it("never passes MEDJAY_* variables, vendor keys, tokens, secrets, passwords or NODE_OPTIONS", () => {
    const env = safeChildEnv(parent);
    for (const name of ["MEDJAY_ANTHROPIC_API_KEY", "MEDJAY_SIGNING_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DATABASE_PASSWORD", "NODE_OPTIONS", "RANDOM_THING"]) {
      expect(env, name).not.toHaveProperty(name);
    }
    expect(JSON.stringify(env)).not.toContain("sk-ant-secret");
  });

  it("matches names case-insensitively (Windows spells it Path)", () => {
    expect(safeChildEnv({ Path: "C:\\bin", windir: "C:\\Windows" })).toEqual({ Path: "C:\\bin", windir: "C:\\Windows" });
  });

  it("adds explicit variables for the one server that needs them", () => {
    const env = safeChildEnv(parent, { extra: { GA4_PROPERTY_ID: "123", GA4_TOKEN: "short-lived" } });
    expect(env.GA4_PROPERTY_ID).toBe("123");
    expect(env.GA4_TOKEN).toBe("short-lived");
    expect(env).not.toHaveProperty("MEDJAY_ANTHROPIC_API_KEY");
  });

  it("refuses an explicit variable that would hand a MEDJAY_* secret to a child", () => {
    expect(() => safeChildEnv(parent, { extra: { MEDJAY_ANTHROPIC_API_KEY: "x" } })).toThrow(/MEDJAY_/);
    expect(() => safeChildEnv(parent, { extra: { medjay_x: "x" } })).toThrow(/MEDJAY_/);
  });

  it("allows extending the whitelist with harmless names but not with secret-looking ones", () => {
    expect(safeChildEnv({ ...parent, CUSTOM_LOCALE: "x" }, { allow: ["CUSTOM_LOCALE"] })).toHaveProperty("CUSTOM_LOCALE", "x");
    for (const name of ["MY_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "AUTH_HEADER", "MEDJAY_X", "NODE_OPTIONS"]) {
      expect(() => safeChildEnv(parent, { allow: [name] }), name).toThrow();
    }
  });

  it("skips undefined values and does not modify its input", () => {
    const input = { PATH: "/bin", HOME: undefined as string | undefined };
    const copy = { ...input };
    expect(safeChildEnv(input)).toEqual({ PATH: "/bin" });
    expect(input).toEqual(copy);
  });
});
