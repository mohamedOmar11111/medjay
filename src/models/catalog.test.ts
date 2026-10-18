import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateCostUsd, ModelCatalog, temperatureFor } from "./catalog.js";
import type { ResolvedTarget } from "./slots.js";

const SAMPLE = {
  anthropic: { models: { "claude-sonnet-5-5": { id: "claude-sonnet-5-5", temperature: true, tool_call: true } } },
  openai: { models: { "gpt-reasoner": { id: "gpt-reasoner", temperature: false } } },
  google: { models: { "gemini-3.8-flash": { id: "gemini-3.8-flash", temperature: true } } },
};

let dir: string;
let cacheFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-catalog-"));
  cacheFile = join(dir, "cache", "models-dev.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const okFetch = (body: unknown = SAMPLE) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
const downFetch = (async () => {
  throw new TypeError("fetch failed");
}) as typeof fetch;

const target = (over: Partial<ResolvedTarget>): ResolvedTarget => ({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  timeoutMs: 1000,
  maxRetries: 0,
  local: false,
  credentialRequired: true,
  keychainRef: "anthropic",
  envFallback: "MEDJAY_ANTHROPIC_API_KEY",
  healthcheckPath: "/models",
  ...over,
});

describe("ModelCatalog.load", () => {
  it("fetches, writes the cache, and answers lookups", async () => {
    const catalog = new ModelCatalog({ fetchFn: okFetch(), cacheFile });
    expect(await catalog.load()).toBe("fresh");
    expect(catalog.find("anthropic", "claude-sonnet-5-5")).toMatchObject({ temperature: true });
    expect(JSON.parse(await readFile(cacheFile, "utf8")).anthropic).toBeDefined();
  });

  it("uses a fresh cache without hitting the network", async () => {
    await new ModelCatalog({ fetchFn: okFetch(), cacheFile }).load();
    const catalog = new ModelCatalog({ fetchFn: downFetch, cacheFile });
    expect(await catalog.load()).toBe("cache");
    expect(catalog.find("google", "gemini-3.8-flash")).toBeDefined();
  });

  it("falls back to a stale cache when the network is down", async () => {
    await new ModelCatalog({ fetchFn: okFetch(), cacheFile }).load();
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await utimes(cacheFile, old, old);
    const catalog = new ModelCatalog({ fetchFn: downFetch, cacheFile, ttlMs: 1000 });
    expect(await catalog.load()).toBe("cache");
    expect(catalog.find("anthropic", "claude-sonnet-5-5")).toBeDefined();
  });

  it("reports unavailable with no cache and no network, and finds nothing", async () => {
    const catalog = new ModelCatalog({ fetchFn: downFetch, cacheFile });
    expect(await catalog.load()).toBe("unavailable");
    expect(catalog.find("anthropic", "claude-sonnet-5-5")).toBeUndefined();
  });

  it("ignores a corrupt cache and a malformed response", async () => {
    await new ModelCatalog({ fetchFn: okFetch(), cacheFile }).load();
    await writeFile(cacheFile, "{not json");
    expect(await new ModelCatalog({ fetchFn: downFetch, cacheFile }).load()).toBe("unavailable");
    const bad = new ModelCatalog({ fetchFn: okFetch("nonsense"), cacheFile: join(dir, "other.json") });
    expect(await bad.load()).toBe("unavailable");
  });

  it("does not leave a partial cache file behind on failure", async () => {
    await new ModelCatalog({ fetchFn: downFetch, cacheFile }).load();
    await expect(stat(cacheFile)).rejects.toThrow();
  });
});

describe("estimateCostUsd", () => {
  const priced = {
    anthropic: { models: { "claude-sonnet-5-5": { id: "claude-sonnet-5-5", cost: { input: 3, output: 15, cache_read: 0.3 } } } },
    google: { models: { "no-price": { id: "no-price" } } },
  };
  const loaded = async () => {
    const catalog = new ModelCatalog({ fetchFn: okFetch(priced), cacheFile });
    await catalog.load();
    return catalog;
  };
  const usage = (over: Partial<Parameters<typeof estimateCostUsd>[2]> = {}) => ({ inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0, reasoningTokens: 0, ...over });

  it("prices input and output tokens per million from the catalog", async () => {
    expect(estimateCostUsd(target({}), await loaded(), usage())).toBeCloseTo(3 + 1.5);
  });

  it("prices cache reads at the cache rate and only the rest at the input rate", async () => {
    expect(estimateCostUsd(target({}), await loaded(), usage({ inputTokens: 1_000_000, cachedTokens: 800_000, outputTokens: 0 }))).toBeCloseTo(0.2 * 3 + 0.8 * 0.3);
  });

  it("is zero for local Ollama, whatever the model", async () => {
    expect(estimateCostUsd(target({ provider: "ollama", model: "gemma4:latest" }), await loaded(), usage())).toBe(0);
  });

  it("is unknown (null) for a vendor model the catalog does not price, and for compatible endpoints", async () => {
    const catalog = await loaded();
    expect(estimateCostUsd(target({ provider: "google", model: "no-price" }), catalog, usage())).toBeNull();
    expect(estimateCostUsd(target({ model: "not-in-catalog" }), catalog, usage())).toBeNull();
    expect(estimateCostUsd(target({ provider: "openai_compatible", model: "gpt-6-luna" }), catalog, usage())).toBeNull();
  });

  it("is unknown when the catalog is unavailable", async () => {
    const empty = new ModelCatalog({ fetchFn: downFetch, cacheFile: join(dir, "none.json") });
    await empty.load();
    expect(estimateCostUsd(target({}), empty, usage())).toBeNull();
  });
});

describe("temperatureFor", () => {
  const loaded = async () => {
    const catalog = new ModelCatalog({ fetchFn: okFetch(), cacheFile });
    await catalog.load();
    return catalog;
  };

  it("omits temperature when none is configured", async () => {
    expect(temperatureFor(target({}), await loaded())).toBeUndefined();
  });

  it("passes temperature to vendor models the catalog says support it", async () => {
    expect(temperatureFor(target({ temperature: 0.2 }), await loaded())).toBe(0.2);
  });

  it("strips temperature for vendor models that do not support it", async () => {
    expect(temperatureFor(target({ provider: "openai", model: "gpt-reasoner", temperature: 0.7 }), await loaded())).toBeUndefined();
  });

  it("strips temperature for unknown vendor models and when the catalog is unavailable", async () => {
    expect(temperatureFor(target({ model: "not-in-catalog", temperature: 0.7 }), await loaded())).toBeUndefined();
    const empty = new ModelCatalog({ fetchFn: downFetch, cacheFile: join(dir, "none.json") });
    await empty.load();
    expect(temperatureFor(target({ temperature: 0.7 }), empty)).toBeUndefined();
  });

  it("passes temperature through for local and compatible endpoints the catalog cannot describe", async () => {
    expect(temperatureFor(target({ provider: "ollama", model: "x", temperature: 0.1 }), await loaded())).toBe(0.1);
    expect(temperatureFor(target({ provider: "openai_compatible", model: "x", temperature: 0.1 }), await loaded())).toBe(0.1);
  });
});
