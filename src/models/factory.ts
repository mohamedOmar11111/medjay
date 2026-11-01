// Builds an AI SDK language model for a resolved slot target. The credential is passed in by the
// caller (resolved via CredentialResolver); nothing here reads the environment.
import type { LanguageModel, ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ResolvedTarget } from "./slots.js";

// The SDKs fall back to *_BASE_URL environment variables when no baseURL is given; a stray one would
// send the API key to another host. So each vendor gets its documented endpoint explicitly.
const VENDOR_BASE_URL = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
} as const;

export interface SearchModel {
  model: LanguageModel;
  /** The provider's own web search tool: the vendor runs the search and returns the sources. */
  tools: ToolSet;
}

/**
 * A model with its vendor's built-in web search, for the three vendors that offer one. Anything else
 * (Ollama, a custom endpoint, a proxy) has no search to offer, so this returns undefined.
 */
export function createSearchModel(target: ResolvedTarget, apiKey?: string): SearchModel | undefined {
  if (!target.credentialRequired) return undefined;
  const { provider, model, baseURL } = target;
  switch (provider) {
    case "anthropic": {
      const vendor = createAnthropic({ apiKey, baseURL: baseURL ?? VENDOR_BASE_URL.anthropic });
      return { model: vendor(model), tools: { web_search: vendor.tools.webSearch_20250305({ maxUses: 3 }) } };
    }
    case "google": {
      const vendor = createGoogleGenerativeAI({ apiKey, baseURL: baseURL ?? VENDOR_BASE_URL.google });
      return { model: vendor(model), tools: { google_search: vendor.tools.googleSearch({}) } };
    }
    case "openai": {
      const vendor = createOpenAI({ apiKey, baseURL: baseURL ?? VENDOR_BASE_URL.openai });
      return { model: vendor(model), tools: { web_search: vendor.tools.webSearch({}) } };
    }
    default:
      return undefined;
  }
}

export function createLanguageModel(target: ResolvedTarget, apiKey?: string): LanguageModel {
  const { provider, model, baseURL } = target;
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL: baseURL ?? VENDOR_BASE_URL.anthropic })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL: baseURL ?? VENDOR_BASE_URL.google })(model);
    case "openai":
      return createOpenAI({ apiKey, baseURL: baseURL ?? VENDOR_BASE_URL.openai })(model);
    case "ollama":
    case "openai_compatible":
      // includeUsage: local OpenAI-compatible servers report no token usage otherwise.
      return createOpenAICompatible({
        name: provider,
        baseURL: baseURL as string,
        apiKey,
        includeUsage: true,
      }).chatModel(model);
  }
}
