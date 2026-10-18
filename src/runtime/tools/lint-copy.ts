import { z } from "zod";
import { lintText, type SlopOptions } from "../../style/slop.js";
import { defineTool } from "../registry.js";

const MAX_FINDINGS = 100;

export function lintCopyTool(settings: Omit<SlopOptions, "kind">) {
  return defineTool({
    name: "lint_copy",
    description:
      "Check customer-facing copy against the anti-slop rules (the Anti-AI Writing Protocol, this brand's forbidden phrases, and the claim register: every number must be a verified claim). Deterministic. Fix every error before showing copy to a human.",
    class: "draft",
    input: z
      .object({
        text: z.string().min(1).max(20_000),
        kind: z.enum(["general", "post", "ad", "message"]).default("general"),
      })
      .strict(),
    execute: async ({ text, kind }) => {
      const report = lintText(text, { ...settings, kind });
      return { pass: report.pass, counts: report.counts, stats: report.stats, findings: report.findings.slice(0, MAX_FINDINGS), truncated: report.findings.length > MAX_FINDINGS };
    },
    trustOf: () => "trusted",
  });
}
