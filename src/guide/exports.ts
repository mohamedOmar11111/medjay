// What a person exports to give Medjay data, one guide per kind of file the ingester reads. The columns
// listed are the ones the ingester needs (see src/ingest/autodetect.ts). The click paths are written from
// general knowledge of each platform and have NOT been checked against the live screens; menu names change,
// so every guide carries the date it was written and the notice below. Correct them from real use.

export interface ExportGuide {
  id: string;
  platform: string;
  report: string;
  file_type: string;
  required_columns: string[];
  optional_columns: string[];
  file_name_hint: string;
  save_to: "data/imports";
  steps: string[];
  written: string;
  /** True only after someone followed the steps on the real platform. None have been yet. */
  verified: false;
}

export const GUIDE_NOTICE =
  "These steps were written from general knowledge of each platform and have not been checked against the live screens. Menu names may differ; if you cannot find a step, search the platform's help for \"export report\" or \"download CSV\", then tell Medjay what you see and it will adjust.";

const WRITTEN = "2026-10-26";

export const EXPORT_GUIDES: readonly ExportGuide[] = [
  {
    id: "google_ads_daily",
    platform: "Google Ads",
    report: "Campaign report, one row per campaign per day",
    file_type: "CSV",
    required_columns: ["Day", "Campaign", "Cost"],
    optional_columns: ["Impressions", "Clicks", "Conversions", "Conv. value"],
    file_name_hint: "Put the word google in the file name, for example google-ads-daily.csv",
    save_to: "data/imports",
    steps: [
      "In Google Ads, open Campaigns (or Reports).",
      "Set the date range to the last 30 days (longer is fine).",
      "Segment by Time > Day, and make sure the columns above are shown.",
      "Click Download and choose CSV.",
      "Save the file into your workspace's data/imports folder.",
    ],
    written: WRITTEN,
    verified: false,
  },
  {
    id: "google_ads_summary",
    platform: "Google Ads",
    report: "Search terms report and campaigns report for a date range (no daily split)",
    file_type: "CSV",
    required_columns: ["Search term (or Campaign)", "Cost", "Clicks"],
    optional_columns: ["Impressions", "Conversions", "Conv. value"],
    file_name_hint: "Keep the date range in the file name as Google writes it, for example Search terms(2026.09.01-2026.09.30).csv",
    save_to: "data/imports",
    steps: [
      "In Google Ads, open Insights and reports > Search terms (or Campaigns).",
      "Pick one date range, for example the last full month.",
      "Click Download and choose CSV.",
      "Do not rename the date part of the file name: Medjay reads the period from it.",
      "Save the file into your workspace's data/imports folder.",
    ],
    written: WRITTEN,
    verified: false,
  },
  {
    id: "meta_ads",
    platform: "Meta Ads",
    report: "Ads Manager report, one row per campaign or ad set per day",
    file_type: "CSV",
    required_columns: ["Day", "Campaign name", "Amount spent"],
    optional_columns: ["Ad set name", "Impressions", "Link clicks", "Results"],
    file_name_hint: "Put the word meta in the file name, for example meta-ads-daily.csv",
    save_to: "data/imports",
    steps: [
      "In Meta Ads Manager, open Ads Reporting (or the Campaigns view).",
      "Set the date range to the last 30 days.",
      "Break down by Time > Day, and add the columns above.",
      "Click Export and choose CSV.",
      "Save the file into your workspace's data/imports folder.",
    ],
    written: WRITTEN,
    verified: false,
  },
  {
    id: "ga4",
    platform: "Google Analytics 4",
    report: "Landing pages with session source and campaign, one row per day",
    file_type: "CSV",
    required_columns: ["Date", "Landing page", "Session source", "Session campaign", "Sessions"],
    optional_columns: ["Key events"],
    file_name_hint: "Any name works, for example ga4-landing-pages.csv",
    save_to: "data/imports",
    steps: [
      "In GA4, open Explore and start a Free form exploration.",
      "Add the dimensions Date, Landing page, Session source and Session campaign, and the metrics Sessions and Key events.",
      "Set the date range to match your ad exports.",
      "Use the download button at the top right and choose CSV.",
      "Save the file into your workspace's data/imports folder.",
    ],
    written: WRITTEN,
    verified: false,
  },
  {
    id: "crm",
    platform: "CRM or sales sheet",
    report: "Every lead with when it came in, its current stage, and where it came from",
    file_type: "CSV",
    required_columns: ["Contact id", "Created date", "Stage", "UTM source", "UTM campaign"],
    optional_columns: ["Deal value", "Click id (gclid or fbclid)", "Phone"],
    file_name_hint: "Any name works, for example crm-leads.csv",
    save_to: "data/imports",
    steps: [
      "In your CRM (or the spreadsheet where you track leads), open the list of all contacts or deals.",
      "Make sure each row has the columns above; add the UTM columns if your forms capture them.",
      "Export or save as CSV.",
      "Save the file into your workspace's data/imports folder.",
    ],
    written: WRITTEN,
    verified: false,
  },
];

/** One short line per guide, for a first message to a newcomer. */
export function exportsNeeded(): string[] {
  return EXPORT_GUIDES.map((g) => `${g.platform}: ${g.report} (${g.file_type})`);
}

/** The guides in the shape the agent reads: everything a person needs, without internal fields. */
export function exportGuideSummaries(): { id: string; platform: string; report: string; save_to: string; file_name_hint: string; required_columns: string[]; steps: string[]; written: string; verified: false }[] {
  return EXPORT_GUIDES.map(({ id, platform, report, save_to, file_name_hint, required_columns, steps, written, verified }) => ({ id, platform, report, save_to, file_name_hint, required_columns, steps, written, verified }));
}
