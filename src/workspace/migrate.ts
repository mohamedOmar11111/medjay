// Schema 0 (M0) -> 1.0.0. Migration never guesses silently: every mapping, default and dropped
// field is reported as a note, and `mdj migrate` only rewrites the file after backing it up and
// recording the change in the ledger.
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { z } from "zod";
import { Ledger } from "../audit/ledger.js";
import { SCHEMA_VERSION, WorkspaceSchema, type WorkspaceConfig } from "./schema.js";
import { WORKSPACE_FILE, WorkspaceError } from "./errors.js";

const V0Target = z
  .object({
    provider: z.enum(["anthropic", "google", "openai", "ollama", "openai-compatible"]),
    model: z.string().min(1),
    baseURL: z.string().optional(),
    timeoutMs: z.number().optional(),
  })
  .strict();
const V0Slot = z
  .object({
    provider: z.enum(["anthropic", "google", "openai", "ollama", "openai-compatible"]),
    model: z.string().min(1),
    baseURL: z.string().optional(),
    timeoutMs: z.number().optional(),
    fallbacks: z.array(V0Target).optional(),
  })
  .strict();
const V0 = z
  .object({
    workspace: z.string().min(1),
    business_type: z.enum(["b2b", "b2c", "ecommerce", "app", "services"]),
    pack: z.string().optional(),
    pillars: z.object({ active: z.array(z.number().int()) }).strict(),
    locale: z
      .object({
        primary: z.string(),
        also: z.array(z.string()).default([]),
        dialects: z.array(z.string()).default([]),
        rtl_templates: z.boolean().default(false),
        currency: z.string().default("USD"),
      })
      .strict(),
    models: z.object({ fast: V0Slot, reasoning: V0Slot, creative: V0Slot }).strict(),
    connectors: z.record(z.string(), z.unknown()).default({}),
    channels: z.record(z.string(), z.unknown()).default({}),
    vault: z.object({ promotion: z.enum(["off", "ask", "allow"]), trust_vault_priors: z.boolean() }).strict().optional(),
  })
  .strict();

type V0Target = z.infer<typeof V0Target>;

const BUSINESS_TYPE_MAP = { b2b: "b2b_saas", b2c: "ecom", ecommerce: "ecom", app: "b2b_saas", services: "agency" } as const;

function migrateTarget(target: V0Target) {
  return {
    provider: target.provider.replace(/-/g, "_"),
    model: target.model,
    ...(target.baseURL === undefined ? {} : { base_url: target.baseURL }),
    ...(target.timeoutMs === undefined ? {} : { timeout_ms: target.timeoutMs }),
  };
}

export interface MigrationResult {
  config: WorkspaceConfig;
  notes: string[];
}

export function migrateV0Config(raw: unknown): MigrationResult {
  const parsed = V0.safeParse(raw);
  if (!parsed.success) {
    throw new WorkspaceError(
      `${WORKSPACE_FILE} (schema 0) is invalid and cannot be migrated`,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const v0 = parsed.data;
  const notes: string[] = [];

  const businessType = BUSINESS_TYPE_MAP[v0.business_type];
  notes.push(`business_type "${v0.business_type}" mapped to "${businessType}"; review it (schema 1 types: ecom, b2b_saas, high_ticket_hybrid, agency, local_leadgen)`);
  notes.push("workspace.timezone was not recorded in schema 0; set to UTC (edit workspace.timezone)");
  notes.push("workspace.name was not recorded in schema 0; set to the workspace id");
  if (v0.locale.also.length > 1) {
    notes.push(`languages beyond the first secondary language were dropped: ${v0.locale.also.slice(1).join(", ")}`);
  }
  if (v0.locale.rtl_templates) notes.push("locale.rtl_templates was dropped (right-to-left output follows Arabic languages)");
  if (Object.keys(v0.connectors).length > 0) {
    notes.push("connectors was dropped: re-add live connectors under ingestion.mcp_servers with pinned versions");
  }
  if (Object.keys(v0.channels).length > 0) {
    notes.push("channels was dropped: configure the WhatsApp bridge under command_bridge and approvers in shield.policy.yaml");
  }

  const slot = (s: z.infer<typeof V0Slot>) => {
    const { fallbacks, ...primary } = s;
    return {
      primary: migrateTarget(primary),
      ...(fallbacks && fallbacks.length > 0 ? { fallbacks: fallbacks.map(migrateTarget) } : {}),
    };
  };

  const candidate = {
    schema_version: SCHEMA_VERSION,
    workspace: {
      id: v0.workspace,
      name: v0.workspace,
      business_type: businessType,
      timezone: "UTC",
      base_currency: v0.locale.currency,
    },
    localization: {
      languages: { primary: v0.locale.primary, ...(v0.locale.also[0] ? { secondary: v0.locale.also[0] } : {}) },
      ...(v0.locale.dialects.length > 0
        ? { arabic_dialects: { default: v0.locale.dialects[0], supported: v0.locale.dialects } }
        : {}),
    },
    models: { slots: { fast: slot(v0.models.fast), reasoning: slot(v0.models.reasoning), creative: slot(v0.models.creative) } },
    pillars: { active: v0.pillars.active },
    ...(v0.vault ? { vault: v0.vault } : {}),
    ...(v0.pack ? { pack: v0.pack } : {}),
  };

  const result = WorkspaceSchema.safeParse(candidate);
  if (!result.success) {
    throw new WorkspaceError(
      `${WORKSPACE_FILE} (schema 0) cannot be migrated automatically; fix these values and retry`,
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return { config: result.data, notes };
}

export interface MigrateFileResult {
  backup: string;
  notes: string[];
  config: WorkspaceConfig;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

export async function migrateWorkspaceFile(dir: string): Promise<MigrateFileResult> {
  const file = join(dir, WORKSPACE_FILE);
  const text = await readFile(file, "utf8");
  const raw: unknown = parseYaml(text, { uniqueKeys: true });
  if (typeof raw === "object" && raw !== null && "schema_version" in raw) {
    throw new Error(`${WORKSPACE_FILE} is already at schema ${String((raw as { schema_version: unknown }).schema_version)}; nothing to migrate`);
  }
  const { config, notes } = migrateV0Config(raw);

  let backup = `${file}.v0.bak`;
  if (await exists(backup)) backup = `${file}.${Date.now()}.v0.bak`;
  await copyFile(file, backup);

  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(
    temp,
    `# Medjay workspace, schema ${SCHEMA_VERSION}. Migrated from schema 0; review the notes from \`mdj migrate\`.\n# Never put API keys here: use \`mdj auth set <ref>\` (OS keychain) or MEDJAY_* environment variables.\n${toYaml(config)}`,
    "utf8",
  );
  await rename(temp, file);

  await new Ledger(join(dir, ".medjay", "audit-log.jsonl")).append({
    actor: "system",
    event: "workspace.migrated",
    payload: { from: "0", to: SCHEMA_VERSION, notes },
  });
  return { backup, notes, config };
}
