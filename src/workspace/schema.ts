// workspace.yaml, schema 1.0.0. Strict: unknown keys are errors (the loader explains the ones
// that were removed on purpose). The pillar catalog, voice rules, ledger/database/policy paths
// and approver allowlists are NOT here: the first two are engine code, paths are fixed by
// convention, and approvers live in shield.policy.yaml where edits are policy-governed.
import { z } from "zod";
import { SLOT_NAMES } from "../constants.js";
import { ENV_REF_PATTERN, KEYCHAIN_REF_PATTERN } from "../models/credentials.js";
import { ModelsSchema } from "../models/slots.js";
import { BUSINESS_TYPES, type BusinessType } from "../pillars/catalog.js";

export { BUSINESS_TYPES, type BusinessType };
export const SCHEMA_VERSION = "1.0.0";
export const PILLAR_COUNT = 11;

const timezones = new Set(Intl.supportedValuesOf("timeZone"));
const currencies = new Set(Intl.supportedValuesOf("currency"));

const Timezone = z.string().refine((tz) => tz === "UTC" || timezones.has(tz), "not an IANA timezone, e.g. Asia/Riyadh");
const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "use a 3-letter ISO 4217 code")
  .refine((code) => currencies.has(code), "not a known ISO 4217 currency code");

const CredRef = z
  .object({
    keychain_ref: z.string().regex(KEYCHAIN_REF_PATTERN, "use lowercase letters, digits, dot, dash or underscore"),
    env_fallback: z.string().regex(ENV_REF_PATTERN, "must be a MEDJAY_* variable name"),
  })
  .strict();

const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx", "pipx", "dlx"]);
const FILESYSTEM_SERVER = /filesystem/i;
const PINNED_SPEC = /^(@?[^@\s]+)@(\d+\.\d+\.\d+(?:[-+][\w.]+)?)$/;

const McpServer = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.url({ protocol: /^https?$/ }).optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/, "pin an exact version, e.g. 1.4.2"),
    mode: z.enum(["read_only", "read_write"]).default("read_only"),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((server, ctx) => {
    const launch = [server.command ?? "", ...server.args].join(" ");
    if (FILESYSTEM_SERVER.test(launch) || FILESYSTEM_SERVER.test(server.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "filesystem MCP servers can write outside the plan engine and are not allowed; Medjay has guarded readers for the dropzone",
      });
    }
    if (server.transport === "stdio" && !server.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "stdio servers need a command" });
    }
    if (server.transport === "http" && !server.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "http servers need a url" });
    }
    if (server.command && PACKAGE_RUNNERS.has(server.command)) {
      const pinned = server.args.map((arg) => PINNED_SPEC.exec(arg)).find(Boolean);
      if (!pinned || pinned[2] !== server.version) {
        ctx.addIssue({
          code: "custom",
          path: ["args"],
          message: `package runners must name the exact pinned package, e.g. "pkg@${server.version}"`,
        });
      }
    }
  });

const WhatsApp = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["respond_io_webhook", "whatsapp_cloud_api", "local_baileys"]).default("whatsapp_cloud_api"),
    channel_id: z.string().min(1).optional(),
    webhook_url: z.url({ protocol: /^https$/ }).optional(),
    credentials: z.object({ api_token: CredRef, webhook_secret: CredRef }).strict().optional(),
    templates: z
      .object({ pulse: z.string().min(1), approval_card: z.string().min(1), alert: z.string().min(1) })
      .strict()
      .optional(),
    unsupported_acknowledged: z.boolean().optional(),
  })
  .strict()
  .superRefine((wa, ctx) => {
    if (!wa.enabled) return;
    for (const field of ["channel_id", "webhook_url", "credentials", "templates"] as const) {
      if (wa[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `required when the bridge is enabled` });
    }
    if (wa.provider === "local_baileys" && wa.unsupported_acknowledged !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["unsupported_acknowledged"],
        message: "the local session bridge is unofficial and unsupported (terms-of-service and account-ban risk); set unsupported_acknowledged: true to use it",
      });
    }
  });

export const WorkspaceSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    workspace: z
      .object({
        id: z.string().min(1).max(80).regex(/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u, "use letters, numbers, dot, dash or underscore"),
        name: z.string().min(1).max(120),
        business_type: z.enum(BUSINESS_TYPES),
        vertical: z.string().min(1).max(80).optional(),
        timezone: Timezone,
        base_currency: Currency,
      })
      .strict(),
    localization: z
      .object({
        primary_markets: z.array(z.string().regex(/^[A-Z]{2}$/, "use ISO 3166-1 alpha-2 codes, e.g. SA")).default([]),
        languages: z
          .object({
            primary: z.string().regex(/^[a-z]{2,3}$/, "use a lowercase language code, e.g. ar"),
            secondary: z.string().regex(/^[a-z]{2,3}$/).optional(),
          })
          .strict(),
        arabic_dialects: z
          .object({ default: z.string().min(1), supported: z.array(z.string().min(1)).min(1) })
          .strict()
          .refine((d) => d.supported.includes(d.default), "default must be one of supported")
          .optional(),
        bnpl_providers: z.array(z.string().min(1)).default([]),
        conversion_topology: z
          .enum(["web_form", "ecommerce_checkout", "conversational_assisted", "phone_assisted", "hybrid"])
          .default("web_form"),
      })
      .strict(),
    models: ModelsSchema,
    pillars: z
      .object({
        active: z
          .array(z.number().int().min(1).max(PILLAR_COUNT))
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length, "pillar ids must be unique"),
        overrides: z
          .record(z.string().regex(/^(?:[1-9]|1[01])$/, "pillar ids run from 1 to 11"), z.object({ default_slot: z.enum(SLOT_NAMES) }).strict())
          .default({}),
      })
      .strict(),
    ingestion: z
      .object({
        dropzone_dir: z.string().default("./data/imports"),
        freshness_sla_hours: z.number().int().positive().default(24),
        mcp_servers: z.array(McpServer).default([]),
      })
      .strict()
      .prefault({}),
    command_bridge: z.object({ whatsapp: WhatsApp.prefault({}) }).strict().prefault({}),
    vault: z
      .object({
        promotion: z.enum(["off", "ask", "allow"]).default("off"),
        trust_vault_priors: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    pack: z.string().min(1).optional(),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>;
