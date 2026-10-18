// Model slots: call sites ask for a slot (fast / reasoning / creative), never a model id.
// Each slot has a primary target and optional fallbacks. A target carries its own endpoint,
// timeout, retry count and credential reference, so local models and proxies (Ollama, localhost
// proxies) are configured per slot. YAML keys are snake_case; resolved targets are camelCase.
import { z } from "zod";
import { SLOT_NAMES, type SlotName } from "../constants.js";
import { defaultRef, ENV_REF_PATTERN, KEYCHAIN_REF_PATTERN } from "./credentials.js";

export { SLOT_NAMES, type SlotName };

export const PROVIDERS = ["anthropic", "google", "openai", "ollama", "openai_compatible"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_HEALTHCHECK_PATH = "/models";
export const CLOUD_TIMEOUT_MS = 60_000;
export const LOCAL_TIMEOUT_MS = 300_000;
export const CLOUD_MAX_RETRIES = 2;
const MAX_TIMEOUT_MS = 1_800_000;

export const SlotTargetSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    model: z.string().min(1),
    base_url: z.url({ protocol: /^https?$/ }).optional(),
    keychain_ref: z.string().regex(KEYCHAIN_REF_PATTERN, "use lowercase letters, digits, dot, dash or underscore").optional(),
    env_fallback: z.string().regex(ENV_REF_PATTERN, "must be a MEDJAY_* variable name").optional(),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    max_retries: z.number().int().min(0).max(5).optional(),
    temperature: z.number().min(0).max(2).optional(),
    healthcheck_path: z.string().regex(/^\//, "must start with /").optional(),
  })
  .strict()
  .refine((t) => t.provider !== "openai_compatible" || t.base_url !== undefined, {
    message: "openai_compatible targets require a base_url",
    path: ["base_url"],
  });

export type SlotTarget = z.infer<typeof SlotTargetSchema>;

export const SlotSchema = z
  .object({ primary: SlotTargetSchema, fallbacks: z.array(SlotTargetSchema).max(3).optional() })
  .strict();

export const ModelsSchema = z
  .object({
    routing: z
      .object({
        default_slot: z.enum(SLOT_NAMES).default("reasoning"),
        auto_fallback: z.boolean().default(true),
        log_usage: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    slots: z.object({ fast: SlotSchema, reasoning: SlotSchema, creative: SlotSchema }).strict(),
  })
  .strict();

export type Models = z.infer<typeof ModelsSchema>;

export interface ResolvedTarget {
  provider: Provider;
  model: string;
  baseURL?: string;
  timeoutMs: number;
  maxRetries: number;
  temperature?: number;
  /** Runs on this machine (Ollama or a localhost endpoint): long timeout, no vendor credential. */
  local: boolean;
  /** A vendor credential must be resolvable before this target can be used. */
  credentialRequired: boolean;
  keychainRef: string;
  envFallback: string;
  healthcheckPath: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const VENDOR_PROVIDERS: ReadonlySet<Provider> = new Set(["anthropic", "google", "openai"]);

function resolveTarget(raw: SlotTarget): ResolvedTarget {
  const baseURL = raw.base_url ?? (raw.provider === "ollama" ? OLLAMA_DEFAULT_BASE_URL : undefined);
  const local =
    raw.provider === "ollama" || (baseURL !== undefined && LOCAL_HOSTS.has(new URL(baseURL).hostname));
  const fallbackRef = defaultRef(raw.provider);
  const target: ResolvedTarget = {
    provider: raw.provider,
    model: raw.model,
    timeoutMs: raw.timeout_ms ?? (local ? LOCAL_TIMEOUT_MS : CLOUD_TIMEOUT_MS),
    maxRetries: raw.max_retries ?? (local ? 0 : CLOUD_MAX_RETRIES),
    local,
    credentialRequired: VENDOR_PROVIDERS.has(raw.provider) && raw.base_url === undefined,
    keychainRef: raw.keychain_ref ?? fallbackRef.keychainRef,
    envFallback: raw.env_fallback ?? fallbackRef.envFallback,
    healthcheckPath: raw.healthcheck_path ?? DEFAULT_HEALTHCHECK_PATH,
  };
  if (baseURL !== undefined) target.baseURL = baseURL;
  if (raw.temperature !== undefined) target.temperature = raw.temperature;
  return target;
}

/** Ordered targets for a slot: the primary first, then each fallback. */
export function resolveSlot(models: Models, name: SlotName): ResolvedTarget[] {
  const { primary, fallbacks = [] } = models.slots[name];
  return [primary, ...fallbacks].map(resolveTarget);
}

export function parseModelRef(ref: string): { provider: Provider; model: string } {
  const split = ref.indexOf("/");
  if (split <= 0 || split === ref.length - 1) {
    throw new Error(`model reference "${ref}" must look like provider/model, e.g. anthropic/claude-sonnet-5-5`);
  }
  const provider = ref.slice(0, split).replace(/-/g, "_");
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`unknown provider "${ref.slice(0, split)}"; expected one of ${PROVIDERS.join(", ")}`);
  }
  return { provider: provider as Provider, model: ref.slice(split + 1) };
}
