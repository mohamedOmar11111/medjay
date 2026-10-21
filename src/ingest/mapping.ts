// ingestion.mappings.yaml: how each export in the dropzone maps onto Medjay's normalized facts.
// It lives at the workspace root, NOT in the dropzone: the dropzone is untrusted data, the mapping
// is configuration. Sanitized real exports drop in later through the same file.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const MAPPINGS_FILE = "ingestion.mappings.yaml";

export class MappingError extends Error {
  constructor(
    summary: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(issues.length === 0 ? summary : `${summary}\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "MappingError";
  }
}

const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lowercase letters, digits, dash or underscore");
/** A file name or simple glob (* and ?) inside the dropzone: no folders, no "..". */
const FileGlob = z
  .string()
  .min(1)
  .regex(/^[^/\\:]+$/, "a file name or glob inside the dropzone, no folders")
  .refine((v) => !v.includes(".."), "no '..'");
const Column = z.string().min(1);
const Currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. SAR");

const Csv = {
  file: FileGlob,
  format: z.literal("csv").default("csv"),
  delimiter: z.enum([",", ";", "\t"]).default(","),
  /** Lines to skip before the header row (platform exports often start with a title and a date range). */
  skip_rows: z.number().int().min(0).max(50).default(0),
  date_format: z.enum(["iso", "dmy", "mdy"]).default("iso"),
};

const AdPlatformSource = z
  .object({
    id: Id,
    kind: z.literal("ad_platform"),
    platform: Id,
    currency: Currency,
    ...Csv,
    columns: z
      .object({
        date: Column,
        campaign: Column,
        adset: Column.optional(),
        spend: Column,
        impressions: Column.optional(),
        clicks: Column.optional(),
        conversions: Column.optional(),
        conv_value: Column.optional(),
      })
      .strict(),
  })
  .strict();

export const SUMMARY_DIMENSIONS = ["campaign", "search_term", "keyword", "device", "word", "day"] as const;
export type SummaryDimension = (typeof SUMMARY_DIMENSIONS)[number];

/**
 * A platform UI export that summarizes a whole period by one dimension (campaign, search term,
 * device...) and has no date column. The period comes from the file name, for example
 * "Campaigns(2026.09.01-2026.09.30).csv", or from the dates themselves for the "day" dimension.
 */
const AdSummarySource = z
  .object({
    id: Id,
    kind: z.literal("ad_summary"),
    platform: Id,
    currency: Currency,
    file: FileGlob,
    format: z.literal("csv").default("csv"),
    delimiter: z.enum([",", ";", "	"]).default(","),
    skip_rows: z.number().int().min(0).max(50).default(0),
    dimension: z.enum(SUMMARY_DIMENSIONS),
    columns: z
      .object({
        key: Column,
        spend: Column,
        impressions: Column.optional(),
        clicks: Column.optional(),
        conversions: Column.optional(),
        conv_value: Column.optional(),
      })
      .strict(),
  })
  .strict();

const WebAnalyticsSource = z
  .object({
    id: Id,
    kind: z.literal("web_analytics"),
    ...Csv,
    columns: z.object({ date: Column, landing_page: Column, source: Column, campaign: Column, sessions: Column, key_events: Column.optional() }).strict(),
  })
  .strict();

const Path = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/, "a dotted field path, e.g. utm.campaign");

export const CANONICAL_STAGES = ["lead", "qualified", "booked", "won", "lost"] as const;
export type CanonicalStage = (typeof CANONICAL_STAGES)[number];
const CanonicalStageSchema = z.enum(CANONICAL_STAGES);

/**
 * Any CRM or relay, as long as its export maps onto the canonical contact schema: contact id, created
 * time, stage (lead | qualified | booked | won | lost), revenue, utm source and campaign, and a phone
 * number (hashed on the way in) or a phone hash. JSON exports map by field path, flat CSV exports by
 * column name; `stage_map` translates the CRM's own stage words.
 */
const CrmSource = z
  .object({
    id: Id,
    kind: z.literal("crm"),
    file: FileGlob,
    format: z.enum(["json", "csv"]).default("json"),
    currency: Currency,
    delimiter: z.enum([",", ";", "\t"]).default(","),
    skip_rows: z.number().int().min(0).max(50).default(0),
    date_format: z.enum(["iso", "dmy", "mdy"]).default("iso"),
    stage_map: z.record(z.string().min(1), CanonicalStageSchema).default({}),
    /** json: path to the array of contacts inside the file. */
    records_path: Path.optional(),
    fields: z
      .object({
        lead_id: Path,
        created_at: Path,
        utm_source: Path,
        campaign: Path,
        adset: Path.optional(),
        click_id: Path.optional(),
        phone: Path.optional(),
        phone_hash: Path.optional(),
        channel: Path.optional(),
        first_response_seconds: Path.optional(),
        ghosted_after_price: Path.optional(),
      })
      .strict()
      .optional(),
    stages: z.object({ path: Path, name: Path, at: Path }).strict().optional(),
    deal: z.object({ path: Path, id: Path, value: Path, currency: Path.optional(), won_at: Path }).strict().optional(),
    /** csv: one row per contact. */
    columns: z
      .object({
        contact_id: Column,
        created_at: Column,
        stage: Column,
        revenue: Column.optional(),
        utm_source: Column,
        utm_campaign: Column,
        utm_content: Column.optional(),
        click_id: Column.optional(),
        phone: Column.optional(),
        phone_hash: Column.optional(),
        channel: Column.optional(),
        first_response_seconds: Column.optional(),
        ghosted_after_price: Column.optional(),
        stage_at: Column.optional(),
        won_at: Column.optional(),
        currency: Column.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    if (c.format === "json") {
      need(c.records_path !== undefined, "records_path", "a json crm source needs records_path");
      need(c.fields !== undefined, "fields", "a json crm source needs fields");
      need(c.stages !== undefined, "stages", "a json crm source needs stages");
      need(c.deal !== undefined, "deal", "a json crm source needs deal");
      need(c.columns === undefined, "columns", "columns is for csv sources");
    } else {
      need(c.columns !== undefined, "columns", "a csv crm source needs columns");
      need(c.records_path === undefined && c.fields === undefined && c.stages === undefined && c.deal === undefined, "format", "records_path, fields, stages and deal are for json sources");
    }
  });

export const SourceSchema = z.discriminatedUnion("kind", [AdPlatformSource, AdSummarySource, WebAnalyticsSource, CrmSource]);
export type SourceMapping = z.infer<typeof SourceSchema>;
export type AdPlatformMapping = z.infer<typeof AdPlatformSource>;
export type AdSummaryMapping = z.infer<typeof AdSummarySource>;
export type WebAnalyticsMapping = z.infer<typeof WebAnalyticsSource>;
export type CrmMapping = z.infer<typeof CrmSource>;

export const MappingsSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(SourceSchema).min(1),
    /** Which CRM stages mean what. Deals come from the deal object; these stage names count qualified leads. */
    funnel: z.object({ qualified: z.array(z.string().min(1)).min(1).default(["qualified", "booked", "won"]) }).strict().prefault({}),
    /** utm_source values that identify each ad platform. */
    attribution: z.object({ source_aliases: z.record(Id, z.array(z.string().min(1)).min(1)) }).strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.sources.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["sources", i, "id"], message: `duplicate source id "${s.id}"` });
      seen.add(s.id);
    });
    const platforms = new Set(m.sources.flatMap((s) => (s.kind === "ad_platform" ? [s.platform] : [])));
    for (const platform of Object.keys(m.attribution.source_aliases)) {
      if (!platforms.has(platform)) ctx.addIssue({ code: "custom", path: ["attribution", "source_aliases", platform], message: `no ad_platform source has platform "${platform}"` });
    }
  });

export type Mappings = z.infer<typeof MappingsSchema>;

const formatPath = (path: PropertyKey[]) => path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");

export function parseMappings(text: string): Mappings {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new MappingError(`${MAPPINGS_FILE} is not valid YAML: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`);
  }
  // `respond_io` was the first CRM source kind; it is now just an alias for the generic `crm`.
  const sources = (raw as { sources?: unknown } | null)?.sources;
  if (Array.isArray(sources)) for (const src of sources) if (typeof src === "object" && src !== null && (src as { kind?: unknown }).kind === "respond_io") (src as { kind: string }).kind = "crm";
  const parsed = MappingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MappingError(
      `${MAPPINGS_FILE} is invalid`,
      parsed.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
    );
  }
  return parsed.data;
}

export async function loadMappings(workspaceDir: string): Promise<Mappings> {
  let text: string;
  try {
    text = await readFile(join(workspaceDir, MAPPINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MappingError(`no ${MAPPINGS_FILE} in this workspace; it tells Medjay how to read your exports (see docs/SPEC.md section 30.9)`);
    }
    throw error;
  }
  return parseMappings(text);
}
