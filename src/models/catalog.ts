// models.dev catalog: fetched, cached on disk, used to check model ids and per-model capabilities
// (for example whether a model accepts a temperature). Offline or unknown means "don't assume".
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider, ResolvedTarget } from "./slots.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface CatalogModel {
  id: string;
  /** USD per million tokens. */
  cost?: { input?: number; output?: number; cache_read?: number };
  temperature?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
}

export type CatalogLoad = "fresh" | "cache" | "unavailable";

export interface ModelCatalogOptions {
  fetchFn?: typeof fetch;
  cacheFile?: string;
  ttlMs?: number;
}

/** Providers the catalog describes by vendor id. Others (local, compatible) are not in it. */
const CATALOG_PROVIDER: Partial<Record<Provider, string>> = { anthropic: "anthropic", google: "google", openai: "openai" };

type Raw = Record<string, { models?: Record<string, CatalogModel> }>;

const isRaw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;

export class ModelCatalog {
  private readonly fetchFn: typeof fetch;
  private readonly cacheFile: string;
  private readonly ttlMs: number;
  private data: Raw | undefined;

  constructor(options: ModelCatalogOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.cacheFile = options.cacheFile ?? join(homedir(), ".medjay", "cache", "models-dev.json");
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async load(): Promise<CatalogLoad> {
    const cached = await this.readCache();
    if (cached && cached.ageMs < this.ttlMs) {
      this.data = cached.data;
      return "cache";
    }
    const fresh = await this.fetchFresh();
    if (fresh) {
      this.data = fresh;
      await this.writeCache(fresh);
      return "fresh";
    }
    if (cached) {
      this.data = cached.data;
      return "cache";
    }
    return "unavailable";
  }

  find(provider: Provider, modelId: string): CatalogModel | undefined {
    const vendor = CATALOG_PROVIDER[provider];
    return vendor === undefined ? undefined : this.data?.[vendor]?.models?.[modelId];
  }

  private async readCache(): Promise<{ data: Raw; ageMs: number } | undefined> {
    try {
      const [text, info] = await Promise.all([readFile(this.cacheFile, "utf8"), stat(this.cacheFile)]);
      const data: unknown = JSON.parse(text);
      return isRaw(data) ? { data, ageMs: Date.now() - info.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchFresh(): Promise<Raw | undefined> {
    try {
      const response = await this.fetchFn(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return undefined;
      const data: unknown = await response.json();
      return isRaw(data) ? data : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(data: Raw): Promise<void> {
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      const temp = `${this.cacheFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data), "utf8");
      await rename(temp, this.cacheFile);
    } catch {
      // a cache that cannot be written only costs a refetch next time
    }
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/**
 * Estimated cost of one model call in USD, or null when the price is unknown. Local Ollama is free.
 * Vendor models are priced from the models.dev catalog (per million tokens, cached input at the
 * cache-read rate). Compatible endpoints and unpriced or unknown models are null, never guessed.
 */
export function estimateCostUsd(target: ResolvedTarget, catalog: ModelCatalog, usage: TokenUsage): number | null {
  if (target.provider === "ollama") return 0;
  const cost = catalog.find(target.provider, target.model)?.cost;
  if (!cost || cost.input === undefined || cost.output === undefined) return null;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const cacheRate = cost.cache_read ?? cost.input;
  return ((usage.inputTokens - cached) * cost.input + cached * cacheRate + usage.outputTokens * cost.output) / 1_000_000;
}

/**
 * The temperature to send, or undefined to omit it. Vendor models only get a temperature when the
 * catalog says they support it (some reject the parameter); unknown or offline means omit.
 * Local and compatible endpoints are not in the catalog and accept it.
 */
export function temperatureFor(target: ResolvedTarget, catalog: ModelCatalog): number | undefined {
  if (target.temperature === undefined) return undefined;
  if (CATALOG_PROVIDER[target.provider] === undefined) return target.temperature;
  return catalog.find(target.provider, target.model)?.temperature === true ? target.temperature : undefined;
}
