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
};

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
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
    default:
      return { label, summary: "done" };
  }
}
