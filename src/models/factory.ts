// Builds an AI SDK language model for a resolved slot target. The credential is passed in by the
// caller (resolved via CredentialResolver); nothing here reads the environment.
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ResolvedTarget } from "./slots.js";

export function createLanguageModel(target: ResolvedTarget, apiKey?: string): LanguageModel {
  const { provider, model, baseURL } = target;
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL })(model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model);
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
