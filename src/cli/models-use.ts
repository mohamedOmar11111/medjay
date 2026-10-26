// `mdj models use <provider>`: point a workspace's three model slots at one cloud provider. A new workspace
// uses Anthropic; someone who only has an OpenAI key needs this (the app runs it for them after /connect,
// and only when no model the workspace currently uses has a key, so it never overrides a working setup).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { parseDocument } from "yaml";
import { CredentialResolver, defaultRef } from "../models/credentials.js";
import { resolveSlot, SLOT_NAMES } from "../models/slots.js";
import { loadWorkspace } from "../workspace/load.js";
import { guarded, workspaceDirOrThrow } from "./util.js";

/** Cloud providers with a model Medjay is known to work with. Others need --model. */
const CLOUD_PROVIDERS = ["anthropic", "openai", "google"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
const DEFAULT_MODELS: Record<CloudProvider, string> = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.4-mini", google: "gemini-2.5-flash" };
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export interface UseProviderOptions {
  dir: string;
  provider: string;
  model?: string | undefined;
  onlyIfNoKey?: boolean;
  resolver?: CredentialResolver;
}

export interface UseProviderResult {
  changed: boolean;
  note: string;
}

/** Order tried when a workspace's own provider has no key: the first provider with a stored key wins. */
const AUTO_ORDER: readonly CloudProvider[] = ["anthropic", "openai", "google"];

/** "auto": keep the workspace as it is if a model it uses has a key; else move it to the first provider that has one. */
async function useAuto(options: UseProviderOptions): Promise<UseProviderResult> {
  const resolver = options.resolver ?? new CredentialResolver();
  const { config } = await loadWorkspace(options.dir);
  for (const target of SLOT_NAMES.flatMap((slot) => resolveSlot(config.models, slot))) {
    if (target.provider === "ollama") continue;
    const found = await resolver.resolve({ keychainRef: target.keychainRef, envFallback: target.envFallback });
    if (found.source !== "none") return { changed: false, note: `the workspace already has a working key for ${target.provider}; left as it was` };
  }
  for (const candidate of AUTO_ORDER) {
    const found = await resolver.resolve(defaultRef(candidate));
    if (found.source !== "none") return useProvider({ ...options, provider: candidate, onlyIfNoKey: false });
  }
  return { changed: false, note: "no AI model key is stored yet: type /connect (or run mdj auth set <provider>)" };
}

export async function useProvider(options: UseProviderOptions): Promise<UseProviderResult> {
  if (options.provider === "auto") return useAuto(options);
  const provider = options.provider.replaceAll("-", "_");
  if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`provider must be one of ${CLOUD_PROVIDERS.join(", ")}`);
  const cloud = provider as CloudProvider;
  const model = options.model ?? DEFAULT_MODELS[cloud];
  if (options.model !== undefined && !MODEL_NAME.test(options.model)) throw new Error("that is not a model name (letters, digits, . _ : - only)");

  const { config } = await loadWorkspace(options.dir);
  const targets = SLOT_NAMES.flatMap((slot) => resolveSlot(config.models, slot));
  if (options.onlyIfNoKey) {
    if (targets.every((t) => t.provider === cloud)) return { changed: false, note: `the workspace already uses ${cloud}` };
    const resolver = options.resolver ?? new CredentialResolver();
    for (const target of targets) {
      if (target.provider === "ollama") continue;
      const found = await resolver.resolve({ keychainRef: target.keychainRef, envFallback: target.envFallback });
      if (found.source !== "none") return { changed: false, note: `the workspace already has a working key for ${target.provider}; left as it was` };
    }
  }

  const file = join(options.dir, "workspace.yaml");
  const original = await readFile(file, "utf8");
  const doc = parseDocument(original);
  for (const slot of SLOT_NAMES) doc.setIn(["models", "slots", slot, "primary"], { provider: cloud, model });
  await writeFile(file, doc.toString());
  try {
    await loadWorkspace(options.dir);
  } catch (error) {
    await writeFile(file, original);
    throw error;
  }
  return { changed: true, note: `all model slots now use ${cloud}/${model}` };
}

export function registerModelsUse(models: Command): void {
  models
    .command("use <provider>")
    .description("point all model slots at one provider: anthropic, openai or google; `auto` picks the provider whose key is stored")
    .option("--model <id>", "the model to use (default: claude-sonnet-5-5, gpt-5.4-mini or gemini-2.5-flash)")
    .option("--only-if-no-key", "change nothing if the workspace already has a working key for a model it uses")
    .option("--workspace <dir>", "workspace folder")
    .action((provider: string, opts: { model?: string; onlyIfNoKey?: boolean; workspace?: string }) =>
      guarded(async () => {
        const dir = await workspaceDirOrThrow(opts.workspace);
        const result = await useProvider({ dir, provider, model: opts.model, onlyIfNoKey: opts.onlyIfNoKey === true });
        process.stdout.write(`${result.note}\n`);
      }),
    );
}
