import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialResolver, type KeyStore } from "../models/credentials.js";
import { initWorkspace } from "../workspace/init.js";
import { createSearchPort, NO_SEARCH_MODEL } from "./search-port.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-searchport-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A key store that has a key for every account, or for none. */
const credentials = (hasKey: boolean): CredentialResolver => {
  const keystore: KeyStore = { get: async () => (hasKey ? "test-key" : null), set: async () => undefined, delete: async () => false };
  return new CredentialResolver({ keystore, env: {} });
};

interface Call {
  provider: string;
  toolNames: string[];
  prompt: unknown;
}
function fakeGenerate(calls: Call[], reply: { text: string; sources: unknown[] }): typeof generateText {
  return (async (options: { model: { provider: string }; tools: Record<string, unknown>; prompt: unknown }) => {
    calls.push({ provider: options.model.provider, toolNames: Object.keys(options.tools), prompt: options.prompt });
    return reply;
  }) as unknown as typeof generateText;
}

async function workspaceWith(name: string, reasoning: string): Promise<string> {
  const dir = join(root, name);
  await initWorkspace({ dir, id: "ws", businessType: "agency", models: { reasoning } });
  return dir;
}

const signal = () => new AbortController().signal;

describe("createSearchPort", () => {
  it("asks the workspace's own model with its built-in search, and keeps only the url sources", async () => {
    const dir = await workspaceWith("g", "google/gemini-2.5-flash");
    const calls: Call[] = [];
    const port = createSearchPort(dir, {
      credentials: credentials(true),
      generate: fakeGenerate(calls, {
        text: "UAE real estate CPL is 25-60 USD (Source A, 2026).",
        sources: [
          { type: "source", sourceType: "url", id: "1", url: "https://example.com/a", title: "Source A" },
          { type: "source", sourceType: "document", id: "2", mediaType: "application/pdf", title: "Doc" },
          { type: "source", sourceType: "url", id: "3", url: "https://example.com/b" },
        ],
      }),
    });
    const result = await port.search("average CPL real estate UAE 2026", signal());
    expect(result.answer).toBe("UAE real estate CPL is 25-60 USD (Source A, 2026).");
    expect(result.sources).toEqual([{ url: "https://example.com/a", title: "Source A" }, { url: "https://example.com/b" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toContain("google");
    expect(calls[0]?.toolNames).toEqual(["google_search"]);
    expect(calls[0]?.prompt).toBe("average CPL real estate UAE 2026");
  });

  it("uses each vendor's own search tool", async () => {
    for (const [name, ref] of [["o", "openai/gpt-5.4-mini"], ["a", "anthropic/claude-sonnet-5-5"]] as const) {
      const dir = await workspaceWith(name, ref);
      const calls: Call[] = [];
      await createSearchPort(dir, { credentials: credentials(true), generate: fakeGenerate(calls, { text: "t", sources: [] }) }).search("some query here", signal());
      expect(calls[0]?.toolNames, ref).toEqual(["web_search"]);
    }
  });

  it("skips a model with no stored key, and says what to add when none can search", async () => {
    const dir = await workspaceWith("nokey", "google/gemini-2.5-flash");
    const calls: Call[] = [];
    const port = createSearchPort(dir, { credentials: credentials(false), generate: fakeGenerate(calls, { text: "t", sources: [] }) });
    await expect(port.search("some query here", signal())).rejects.toThrow(NO_SEARCH_MODEL);
    expect(calls).toEqual([]);
  });

  it("does not search through a local model", async () => {
    const dir = await workspaceWith("local", "ollama/llama3.1");
    const calls: Call[] = [];
    const port = createSearchPort(dir, { credentials: credentials(true), generate: fakeGenerate(calls, { text: "t", sources: [] }) });
    await expect(port.search("some query here", signal())).rejects.toThrow(NO_SEARCH_MODEL);
    expect(calls).toEqual([]);
  });
});
