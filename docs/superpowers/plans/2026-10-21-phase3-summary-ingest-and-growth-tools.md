# Phase 3: summary-report ingest and the `growth_*` tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** (A) Medjay can read Google Ads UI summary exports (no date column; the period is in the file name) and answer from them. (B) The agent gets `growth_scout`, `growth_diagnose`, `growth_context` and `growth_simulate` so it stops opening raw CSVs and talks about calibrated results.

**Architecture:** (A) A new mapping kind `ad_summary` reads one dimension per file (campaign, search term, keyword, device, word, day) into a new `fact_period` table. A small analysis module, `summary.ts`, turns those rows into a period summary that `mdj scout --json` returns beside the daily snapshot. (B) The four tools are thin wrappers around the existing analyses (`scout`, `diagnose`, `simulate`, context and tactics files), registered in the tool registry with `read` class; `growth_diagnose`, `growth_simulate` and `growth_propose_plan` refuse to run until a matching `growth_scout` result exists in the run.

**Tech Stack:** TypeScript, node:sqlite, zod 4, vitest.

**Spec:** [docs/superpowers/specs/2026-10-20-growth-session-and-tools-design.md](../specs/2026-10-20-growth-session-and-tools-design.md) section 2 and 3, build step 3.

## Global Constraints

- No `write` tool class. All new tools are `read`.
- Dropzone files stay untrusted: only plain files, size cap, no execution. Cell text is data.
- A bad file never replaces good stored data (existing rule).
- Re-ingesting replaces everything from that file in one transaction.
- Money parsing uses `toNumber` (handles `SAR8,450.00`); currency comes from the mapping, never guessed from a cell.
- Tests first; one commit per task; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not push until the owner says so.

## Part A: summary-report ingest

1. **Store migration v8:** table `fact_period (source_id, platform, period_start, period_end, dimension, key, spend, impressions, clicks, conversions, conv_value, currency)`; schema version 8; deleting a source removes its rows.
2. **Mapping kind `ad_summary`:** `{id, kind, platform, currency, file, delimiter, dimension, columns:{key, spend, clicks?, impressions?, conversions?, conv_value?}}`; strict schema; tests for accepted and rejected shapes.
3. **Normalize:** `normalizeAdSummary(file, text, mapping)`: period from a `(YYYY.MM.DD-YYYY.MM.DD)` file-name suffix, or from min/max of a `day` dimension; money and counts via `toNumber`; blank key rows skipped; unreadable numbers become issues. `Tue, Sep 1, 2026` parses as a day.
4. **Ingest wiring:** `IngestRepo.replace` writes `fact_period`; `ingestDropzone` reports rows and period for summary files.
5. **Autodetect:** recognise the Google Ads summary exports by headers (`Campaign Name`+`Cost`, `Search`+`Cost`, `Search Keyword`+`Cost`, `Device`+`Cost`, `Word`+`Cost`, `Date`+`Cost`) and write `ad_summary` mappings; Search Console files (`Clicks, Impressions, CTR, Position`) stay unmapped.
6. **Analysis `summary.ts`:** `periodSummary(store, {baseCurrency})` returns period, totals (from the campaign dimension), campaigns with cost per conversion, top zero-conversion search terms and keywords, device split, daily trend; `mdj scout --json` adds it as `summary`. When only summary data exists, the scout text output and the TUI performance answer use it instead of saying "no ad numbers".

## Part B: growth tools

7. **`growth_scout`:** returns the snapshot and the summary with a `snapshot_id` (hash of normalized data and period); card line for the live view.
8. **`growth_diagnose`:** requires a current `snapshot_id`; returns findings with source and date.
9. **`growth_context`:** unit economics, claims register, offer matrix and the tactics log (read-only, size-capped).
10. **`growth_simulate`:** requires a current `snapshot_id`; returns the existing simulation result or the missing-inputs list.
11. **Registration and prompt:** register the four tools; the system prompt says to call `growth_scout` before any performance claim; cards for the live view; precondition errors are tested.
12. **Live check and docs:** run against `etlaala-live` through the real terminal; SPEC section; commit.

Self-review: spec section 2 (tools 1-4) and section 3 rule 1 (hard precondition) are covered by tasks 7-11. The decision card, `growth_check_copy`, `growth_propose_plan` and permission prompts are later phases.
