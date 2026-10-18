// Caveman tactics: terse output for the harness's own prose. Cuts output tokens and makes mobile
// replies readable. It is a style for NARRATION only: structured fields (evidence, sources, dates,
// numbers, ids) are data and stay exact, and the surfaces where clarity matters are always plain.
import { StyleConfigSchema, type CavemanLevel, type StyleConfig } from "./config.js";

export { StyleConfigSchema, type CavemanLevel, type StyleConfig };

export type Surface = "internal" | "whatsapp" | "client_copy" | "approval" | "security";

/** Never terse: client copy (brand voice and anti-slop apply instead), approval prompts, warnings. */
export const ALWAYS_PLAIN_SURFACES: readonly Surface[] = Object.freeze(["client_copy", "approval", "security"] as const);

const PROTECT =
  "Keep numbers, ids, names, file paths, commands, code, quoted errors, and every source and date citation exactly as given.";
const CLARITY =
  "Write plain, full sentences for warnings about spending or security, for irreversible actions, for multi-step instructions where order matters, and whenever the reader asks you to clarify.";

const BASE: Record<Exclude<CavemanLevel, "off">, string> = {
  lite: `Cut filler, pleasantries and hedging, but keep articles and full sentences. Professional and tight. ${PROTECT} ${CLARITY}`,
  full: `Drop articles, filler (just, really, basically), pleasantries and hedging. Fragments are fine. Prefer short words. Do not narrate tool calls or restate the question. Pattern: thing, action, reason, next step. ${PROTECT} ${CLARITY}`,
  ultra: `Drop articles, filler, pleasantries and hedging. Fragments only. Abbreviate common prose words (DB, config, req, res, impl) and use arrows for cause (X → Y); one word when one will do. Never abbreviate identifiers, ids, metric names or quoted text. Do not narrate tool calls. ${PROTECT} ${CLARITY}`,
};

export function cavemanDirective(level: CavemanLevel): string {
  return level === "off" ? "" : BASE[level];
}

/**
 * The level for a surface. Always-plain surfaces are off whatever the config says. Anything that
 * is not English is capped at lite: the heavier levels are only defined for English prose.
 */
export function resolveLevel(config: StyleConfig, surface: Surface, language = "en"): CavemanLevel {
  if (ALWAYS_PLAIN_SURFACES.includes(surface)) return "off";
  const level = surface === "whatsapp" ? config.caveman.whatsapp : config.caveman.internal;
  if (language !== "en" && (level === "full" || level === "ultra")) return "lite";
  return level;
}

export function directiveFor(config: StyleConfig, surface: Surface, language = "en"): string {
  const level = resolveLevel(config, surface, language);
  if (level === "off") return "";
  const text = cavemanDirective(level);
  return language === "en" ? text : `${text} Reply in the user's language; compress the style, not the language.`;
}
