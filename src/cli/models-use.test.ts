import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialResolver, type KeyStore } from "../models/credentials.js";
import { initWorkspace } from "../workspace/init.js";
import { loadWorkspace } from "../workspace/load.js";
import { useProvider } from "./models-use.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-models-use-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "ecom" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A resolver whose keychain holds exactly the given accounts (no real keychain, no environment). */
const resolverWith = (...accounts: string[]) => {
  const keystore: KeyStore = {
    get: async (account) => (accounts.includes(account) ? "stored-key" : null),
    set: async () => undefined,
    delete: async () => false,
  };
  return new CredentialResolver({ keystore, env: {} });
};

const slots = async () => {
  const { config } = await loadWorkspace(dir);
  return (["fast", "reasoning", "creative"] as const).map((s) => `${config.models.slots[s].primary.provider}/${config.models.slots[s].primary.model}`);
};

describe("mdj models use", () => {
  it("points all three slots at the provider's default model, keeping the file's comments", async () => {
    const before = await readFile(join(dir, "workspace.yaml"), "utf8");
    const result = await useProvider({ dir, provider: "openai", resolver: resolverWith() });
    expect(result.changed).toBe(true);
    expect(await slots()).toEqual(["openai/gpt-5.4-mini", "openai/gpt-5.4-mini", "openai/gpt-5.4-mini"]);
    const after = await readFile(join(dir, "workspace.yaml"), "utf8");
    expect([...before.matchAll(/^\s*#.*$/gm)].length).toBe([...after.matchAll(/^\s*#.*$/gm)].length);
  });

  it("uses the model it is given, and a provider with no built-in default needs one", async () => {
    await useProvider({ dir, provider: "google", model: "gemini-test", resolver: resolverWith() });
    expect(await slots()).toEqual(["google/gemini-test", "google/gemini-test", "google/gemini-test"]);
    await expect(useProvider({ dir, provider: "google", resolver: resolverWith() })).rejects.toThrow(/--model/);
  });

  it("refuses a provider that is not a cloud provider, or a model name that is not plain", async () => {
    await expect(useProvider({ dir, provider: "ollama", resolver: resolverWith() })).rejects.toThrow(/anthropic, openai, google/);
    await expect(useProvider({ dir, provider: "openai", model: "bad model;x", resolver: resolverWith() })).rejects.toThrow(/model name/);
    expect(await slots()).toEqual(["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"]);
  });

  describe("--only-if-no-key (what /connect uses)", () => {
    it("switches when none of the workspace's models has a key, so the key just added will be used", async () => {
      const result = await useProvider({ dir, provider: "openai", onlyIfNoKey: true, resolver: resolverWith("openai") });
      expect(result.changed).toBe(true);
      expect((await slots())[0]).toBe("openai/gpt-5.4-mini");
    });

    it("leaves the workspace alone when its current model already has a key", async () => {
      const result = await useProvider({ dir, provider: "openai", onlyIfNoKey: true, resolver: resolverWith("anthropic", "openai") });
      expect(result.changed).toBe(false);
      expect(result.note).toMatch(/already/);
      expect((await slots())[0]).toBe("anthropic/claude-sonnet-5-5");
    });

    it("does nothing, and says why, when the provider has no default model", async () => {
      const result = await useProvider({ dir, provider: "google", onlyIfNoKey: true, resolver: resolverWith("google") });
      expect(result.changed).toBe(false);
      expect(result.note).toMatch(/mdj models use google --model/);
    });

    it("does nothing when the slots already use that provider", async () => {
      await useProvider({ dir, provider: "openai", resolver: resolverWith() });
      const result = await useProvider({ dir, provider: "openai", onlyIfNoKey: true, resolver: resolverWith() });
      expect(result.changed).toBe(false);
    });
  });
});

describe("mdj models use auto (what setup runs: pick the provider whose key is already stored)", () => {
  it("moves a new workspace to the provider that has a key when its own provider has none", async () => {
    const result = await useProvider({ dir, provider: "auto", resolver: resolverWith("openai") });
    expect(result.changed).toBe(true);
    expect((await slots())[0]).toBe("openai/gpt-5.4-mini");
  });
  it("leaves the workspace alone when the model it uses already has a key, even if other keys exist", async () => {
    const result = await useProvider({ dir, provider: "auto", resolver: resolverWith("anthropic", "openai") });
    expect(result.changed).toBe(false);
    expect((await slots())[0]).toBe("anthropic/claude-sonnet-5-5");
  });
  it("changes nothing, and says what to do, when no key is stored yet", async () => {
    const result = await useProvider({ dir, provider: "auto", resolver: resolverWith() });
    expect(result.changed).toBe(false);
    expect(result.note).toMatch(/\/connect/);
  });
  it("skips a provider it has no default model for, and names it", async () => {
    const result = await useProvider({ dir, provider: "auto", resolver: resolverWith("google") });
    expect(result.changed).toBe(false);
    expect(result.note).toMatch(/google/);
    expect(result.note).toMatch(/--model/);
  });
  it("prefers anthropic, then openai, when several keys exist and the workspace's own has none", async () => {
    await useProvider({ dir, provider: "openai", resolver: resolverWith() }); // now on openai, but only google and anthropic keys exist
    const result = await useProvider({ dir, provider: "auto", resolver: resolverWith("anthropic", "google") });
    expect(result.changed).toBe(true);
    expect((await slots())[0]).toBe("anthropic/claude-sonnet-5-5");
  });
});
