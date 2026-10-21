// workspace.yaml, schema 1.0.0. Strict: unknown keys are errors (the loader explains the ones
// that were removed on purpose). The pillar catalog, voice rules, ledger/database/policy paths
// and approver allowlists are NOT here: the first two are engine code, paths are fixed by
// convention, and approvers live in shield.policy.yaml where edits are policy-governed.
import { z } from "zod";
import { SLOT_NAMES } from "../constants.js";
import { ENV_REF_PATTERN, KEYCHAIN_REF_PATTERN } from "../models/credentials.js";
import { ModelsSchema } from "../models/slots.js";
import { BUSINESS_TYPES, type BusinessType } from "../pillars/catalog.js";
import { StyleConfigSchema } from "../style/config.js";

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

const DottedPath = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/, "a dotted field path, e.g. message.contact.phone");

/**
 * How inbound webhooks look. provider cloud_api is Meta's WhatsApp Cloud API. generic_hmac is any CRM
 * or relay that signs the raw body with HMAC-SHA256: name the signature header and format and point at
 * the fields in its JSON (or pick a preset). The older provider names whatsapp_cloud_api and
 * respond_io_webhook still load and mean cloud_api and generic_hmac with the respond_io preset.
 */
const Webhook = z
  .object({
    preset: z.string().min(1).max(40).optional(),
    signature_header: z.string().regex(/^[A-Za-z0-9-]+$/, "a header name such as X-Hub-Signature-256").optional(),
    signature_format: z.enum(["hex", "base64", "sha256_prefix"]).optional(),
    messages_path: DottedPath.optional(),
    only_when: z.object({ path: DottedPath, equals: z.string().min(1).max(80) }).strict().optional(),
    fields: z
      .object({
        message_id: DottedPath,
        sender_phone: DottedPath,
        message_type: DottedPath,
        text: DottedPath,
        media_type: DottedPath,
        transcript: DottedPath,
        is_transcription: DottedPath,
        button_id: DottedPath,
        timestamp: DottedPath,
      })
      .partial()
      .strict()
      .optional(),
    type_map: z
      .object({ text: z.array(z.string().min(1)).min(1), audio: z.array(z.string().min(1)).min(1), button: z.array(z.string().min(1)).min(1) })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

/** Where outbound replies go. console only prints them (local use and tests). */
const Transport = z
  .object({
    type: z.enum(["console", "cloud_api", "generic_webhook"]).default("console"),
    /** generic_webhook: where to POST { to, text, plan_id, short_hash, ledger_head }. */
    url: z.url({ protocol: /^https$/ }).optional(),
    /** cloud_api: the WhatsApp Business phone number id that sends the messages. */
    phone_number_id: z.string().regex(/^\d{5,20}$/, "digits only").optional(),
    api_version: z.string().regex(/^v\d+\.\d+$/, "for example v21.0").default("v21.0"),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.type === "generic_webhook" && t.url === undefined) ctx.addIssue({ code: "custom", path: ["url"], message: "required for a generic_webhook transport" });
    if (t.type === "cloud_api" && t.phone_number_id === undefined) ctx.addIssue({ code: "custom", path: ["phone_number_id"], message: "required for a cloud_api transport" });
  });

const WhatsApp = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["cloud_api", "generic_hmac", "local_baileys", "whatsapp_cloud_api", "respond_io_webhook"]).default("cloud_api"),
    channel_id: z.string().min(1).optional(),
    webhook_url: z.url({ protocol: /^https$/ }).optional(),
    webhook: Webhook.optional(),
    transport: Transport.optional(),
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
    if (wa.provider === "generic_hmac" && wa.webhook === undefined) {
      ctx.addIssue({ code: "custom", path: ["webhook"], message: "a generic_hmac bridge needs a webhook block (a preset, or the signature header, format and field pointers)" });
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
    /** Where skills (SKILL.md folders) are found besides the workspace and ~/.medjay. Nothing outside these is read. */
    skills: z
      .object({
        paths: z.array(z.object({ path: z.string().min(1).max(500), trust: z.enum(["owner", "untrusted"]).default("untrusted"), name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional() }).strict()).default([]),
        /** Opt in to ~/.claude/skills (other people's skills may be in there). */
        include_claude_global: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    /** Plugin folders to read skills, commands, agents and read-only MCP definitions from. Hooks and scripts are never run. */
    plugins: z
      .object({
        paths: z.array(z.string().min(1).max(500)).default([]),
        /** Installed plugins (name@marketplace) to include; none are included by default. */
        include: z.array(z.string().min(1).max(100)).default([]),
      })
      .strict()
      .prefault({}),
    style: StyleConfigSchema.prefault({}),
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
