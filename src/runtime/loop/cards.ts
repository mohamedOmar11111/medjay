// One short, safe line per tool call for the live view. It reads only the shape of a tool's output
// (counts, sizes, pass/fail), never the content, so no file text or customer data reaches the stream.
export interface Card {
  label: string;
  summary: string;
}

const LABELS: Record<string, string> = {
  read_file: "Read file",
  list_files: "List files",
  lint_copy: "Copy check",
  propose_plan_actions: "Proposed changes",
  growth_scout: "Truth check",
  growth_diagnose: "Diagnosis",
  growth_context: "Your context",
  growth_simulate: "Simulation",
  skill_search: "Skill search",
  skill_load: "Skill",
};

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d ?? 0} ${MONTHS[(m ?? 1) - 1] ?? ""}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function cardFor(tool: string, input: unknown, output: unknown, ok: boolean, errorKind?: string): Card {
  const label = LABELS[tool] ?? tool;
  if (!ok) return { label, summary: `failed${errorKind ? ` (${errorKind})` : ""}` };
  const out = rec(output);
  switch (tool) {
    case "read_file": {
      const kb = Math.max(1, Math.round(num(out.bytes) / 1024));
      return { label, summary: `${String(out.path ?? rec(input).path ?? "file")} · ${kb} KB${out.truncated === true ? " (truncated)" : ""}` };
    }
    case "list_files": {
      const dir = String(out.dir ?? "") || "workspace";
      const entries = Array.isArray(out.entries) ? out.entries.length : 0;
      return { label, summary: `${dir} · ${plural(entries, "entry", "entries")}` };
    }
    case "lint_copy": {
      if (out.pass === true) return { label, summary: "passes" };
      const counts = rec(out.counts);
      return { label, summary: `${plural(num(counts.error), "error")}, ${plural(num(counts.warn), "warning")}` };
    }
    case "propose_plan_actions": {
      const n = Array.isArray(out.proposals) ? out.proposals.length : 0;
      const status = rec(out.policy).status;
      return { label, summary: `${plural(n, "proposal")}${typeof status === "string" ? ` · policy check: ${status}` : ""}` };
    }
    case "growth_scout": {
      const snapshot = rec(out.snapshot);
      const summary = rec(out.summary);
      const range = (p: unknown) => {
        const period = rec(p);
        return typeof period.start === "string" && typeof period.end === "string" ? ` · ${shortDay(period.start)} – ${shortDay(period.end)}` : "";
      };
      if (snapshot.status === "ok") {
        const totals = rec(snapshot.totals);
        return { label, summary: `${String(snapshot.currency ?? "")} ${Math.round(num(totals.spend)).toLocaleString("en-US")} · ${plural(num(totals.leads), "lead")}${range(snapshot.period)}`.trim() };
      }
      if (Object.keys(summary).length > 0) {
        const campaigns = Array.isArray(summary.campaigns) ? summary.campaigns.length : 0;
        return { label, summary: `${String(summary.currency ?? "")} ${Math.round(num(rec(summary.totals).spend)).toLocaleString("en-US")} · ${plural(campaigns, "campaign")}${range(summary.period)}`.trim() };
      }
      return { label, summary: "no ad data found" };
    }
    case "growth_diagnose": {
      const findings = Array.isArray(out.findings) ? out.findings.length : 0;
      const zero = rec(rec(out.summary).zero_conversion_total);
      if (findings === 0 && num(zero.terms) > 0) return { label, summary: `${num(zero.terms)} search terms never converted` };
      return { label, summary: plural(findings, "finding") };
    }
    case "growth_context":
      return { label, summary: `economics, claims, offers · ${plural(Array.isArray(out.tactics) ? out.tactics.length : 0, "tactic")}` };
    case "growth_simulate": {
      const result = rec(out.result);
      if (result.status === "ok") return { label, summary: `${Math.round(num(rec(result.monte_carlo).p_positive) * 100)}% chance it pays off` };
      if (result.status === "insufficient_inputs") return { label, summary: `missing ${plural(Array.isArray(result.problems) ? result.problems.length : 0, "number")}` };
      return { label, summary: String(result.status ?? "done") };
    }
    case "skill_search": {
      const matches = Array.isArray(out.matches) ? (out.matches as { name?: unknown }[]) : [];
      if (matches.length === 0) return { label, summary: `no match among ${num(out.searched)}` };
      return { label, summary: `${plural(matches.length, "match", "matches")}: ${matches.slice(0, 3).map((m) => String(m.name)).join(", ")}` };
    }
    case "skill_load":
      return { label, summary: `${String(out.name ?? "skill")} (${String(out.source ?? "?")}, ${out.trust === "owned" ? "yours" : "from another author"})` };
    default:
      return { label, summary: "done" };
  }
}
