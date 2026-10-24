// The copy check a customer-facing draft goes through when it is saved: the same anti-slop, forbidden
// phrase and claim-register rules the lint_copy tool applies, with this workspace's settings. Only the
// outcome is kept (status, counts, rule ids), never the matched text.
import { loadStyleContext } from "../style/context.js";
import { lintText, type Kind, type Pack, type SlopOptions } from "../style/slop.js";
import { loadWorkspace } from "../workspace/load.js";
import type { DraftChecker, DraftKind } from "./store.js";

const SLOP_KIND: Record<DraftKind, Kind> = { internal: "general", report: "general", ad: "ad", email: "message", post: "post", landing_page: "general" };
const MAX_RULES = 20;

/** The copy-check settings of a workspace (shared with the lint_copy tool). */
export async function copyCheckSettings(dir: string): Promise<Omit<SlopOptions, "kind">> {
  const { config } = await loadWorkspace(dir);
  const context = await loadStyleContext(dir);
  const languages = [config.localization.languages.primary, config.localization.languages.secondary].filter((l): l is string => Boolean(l));
  const packs: Pack[] = config.style.slop.packs ?? ["protocol", "extended", ...(languages.includes("ar") ? (["ar"] as const) : [])];
  return { packs, extraBanned: [...config.style.slop.extra_banned, ...context.forbiddenPhrases], allow: config.style.slop.allow, claims: context.claims, failOn: config.style.slop.fail_on };
}

export async function createDraftChecker(dir: string): Promise<DraftChecker> {
  const settings = await copyCheckSettings(dir);
  return (text, kind) => {
    const report = lintText(text, { ...settings, kind: SLOP_KIND[kind] });
    return {
      status: report.pass ? "pass" : "fail",
      errors: report.counts.error,
      warnings: report.counts.warn,
      rules: [...new Set(report.findings.map((f) => f.rule))].slice(0, MAX_RULES),
    };
  };
}
