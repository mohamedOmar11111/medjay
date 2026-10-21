// Storage for normalized facts. Re-ingesting a file replaces everything that came from it, in one
// transaction, so a half-written import never leaves the numbers inconsistent.
import type { Store } from "../store/db.js";
import type { AdFact, CrmFacts, Issue, SummaryFact, WebFact } from "./normalize.js";

export interface SourceRecord {
  source_id: string;
  mapping_id: string;
  kind: string;
  platform: string | null;
  file: string;
  sha256: string;
  rows: number;
  issues: Issue[];
  period_start: string | null;
  period_end: string | null;
  ingested_at: string;
}

export type FactBatch =
  | { kind: "ad_platform"; platform: string; currency: string; facts: AdFact[] }
  | { kind: "ad_summary"; platform: string; currency: string; dimension: string; period: { start: string; end: string }; facts: SummaryFact[] }
  | { kind: "web_analytics"; facts: WebFact[] }
  | { kind: "crm"; facts: CrmFacts };

export class IngestRepo {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.database();
  }

  getSource(sourceId: string): SourceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE source_id = ?").get(sourceId) as Record<string, unknown> | undefined;
    return row ? toSource(row) : undefined;
  }

  sources(): SourceRecord[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY source_id").all() as Record<string, unknown>[]).map(toSource);
  }

  /** Replace one source and all its facts atomically. */
  replace(source: SourceRecord, batch: FactBatch): void {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteFacts(source.source_id);
      db.prepare("DELETE FROM sources WHERE source_id = ?").run(source.source_id);
      db.prepare(
        `INSERT INTO sources (source_id, mapping_id, kind, platform, file, sha256, rows, issues_json, period_start, period_end, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(source.source_id, source.mapping_id, source.kind, source.platform, source.file, source.sha256, source.rows, JSON.stringify(source.issues), source.period_start, source.period_end, source.ingested_at);

      const id = source.source_id;
      if (batch.kind === "ad_platform") {
        const insert = db.prepare("INSERT INTO fact_daily (source_id, date, platform, campaign, adset, spend, impressions, clicks, conversions, conv_value, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const f of batch.facts) insert.run(id, f.date, batch.platform, f.campaign, f.adset, f.spend, f.impressions, f.clicks, f.conversions, f.conv_value, batch.currency);
      } else if (batch.kind === "ad_summary") {
        const insert = db.prepare("INSERT INTO fact_period (source_id, platform, period_start, period_end, dimension, key, spend, impressions, clicks, conversions, conv_value, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const f of batch.facts) insert.run(id, batch.platform, batch.period.start, batch.period.end, batch.dimension, f.key, f.spend, f.impressions, f.clicks, f.conversions, f.conv_value, batch.currency);
      } else if (batch.kind === "web_analytics") {
        const insert = db.prepare("INSERT INTO web_sessions (source_id, date, landing_page, source, campaign, sessions, key_events) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const f of batch.facts) insert.run(id, f.date, f.landing_page, f.source, f.campaign, f.sessions, f.key_events);
      } else {
        const lead = db.prepare("INSERT INTO leads (lead_id, source_id, created_at, utm_source, campaign, adset, click_id, phone_hash, channel, first_response_seconds, ghosted_after_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const l of batch.facts.leads) {
          lead.run(l.lead_id, id, l.created_at, l.utm_source, l.campaign, l.adset, l.click_id, l.phone_hash, l.channel, l.first_response_seconds, l.ghosted_after_price === null ? null : l.ghosted_after_price ? 1 : 0);
        }
        const stage = db.prepare("INSERT INTO lead_stage_events (lead_id, source_id, stage, entered_at) VALUES (?, ?, ?, ?)");
        for (const s of batch.facts.stages) stage.run(s.lead_id, id, s.stage, s.entered_at);
        const deal = db.prepare("INSERT INTO deals (deal_id, lead_id, source_id, value, currency, won_at) VALUES (?, ?, ?, ?, ?, ?)");
        for (const d of batch.facts.deals) deal.run(d.deal_id, d.lead_id, id, d.value, d.currency, d.won_at);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private deleteFacts(sourceId: string): void {
    for (const table of ["fact_daily", "fact_period", "web_sessions", "lead_stage_events", "deals", "leads"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).run(sourceId);
    }
  }
}

function toSource(row: Record<string, unknown>): SourceRecord {
  return {
    source_id: String(row.source_id),
    mapping_id: String(row.mapping_id),
    kind: String(row.kind),
    platform: (row.platform as string | null) ?? null,
    file: String(row.file),
    sha256: String(row.sha256),
    rows: Number(row.rows),
    issues: JSON.parse(String(row.issues_json)) as Issue[],
    period_start: (row.period_start as string | null) ?? null,
    period_end: (row.period_end as string | null) ?? null,
    ingested_at: String(row.ingested_at),
  };
}
