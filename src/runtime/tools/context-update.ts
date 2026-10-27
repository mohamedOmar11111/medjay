// context_update: the one tool that can change a workspace file, and only these four. It never runs
// without a person: the registry asks first (always, whatever the policy says), the person sees the
// change, and the store keeps the old text as a numbered version. The tool itself touches no disk.
import { z } from "zod";
import { CONTEXT_FILES, MAX_CONTEXT_BYTES, type ContextStore } from "../../context/store.js";
import { defineTool, type ToolDef } from "../registry.js";

export function contextTools(store: ContextStore): ToolDef[] {
  const update = defineTool({
    name: "context_update",
    description:
      "Fill in or correct one of the four context files with facts the owner just told you: unit-economics (currency and ranged inputs: value, low, high, source), offer-matrix (packages, prices, payment options), brand-voice (tone, forbidden phrases), claims (public numbers with a source). Send the WHOLE new text of the file, keeping its front matter (the block between the two --- lines) valid; read the file first so nothing the owner already wrote is lost. Never invent a number: write only what the owner said, and put where it came from in source. The owner sees the change and must allow it; if it is denied, do not send the same text again. Unit-economics values must be ranges, never a bare number.",
    class: "context",
    input: z.object({ file: z.enum(CONTEXT_FILES), text: z.string().min(1).max(MAX_CONTEXT_BYTES), reason: z.string().min(1).max(300) }).strict(),
    paths: ({ file }) => [`context/${file}.md`],
    resources: ({ file }) => [`context:${file}`],
    preview: async ({ file, text, reason }) => {
      const p = await store.propose(file, text);
      return { summary: `${file}: ${p.changed ? `+${p.diff.added} / -${p.diff.removed} lines` : "no change"} (${reason})`, diff: p.diff.text };
    },
    execute: async ({ file, text, reason }, ctx) => {
      const r = await store.apply(file, text, { author: `agent:${ctx.runId}`, reason });
      return {
        file,
        saved: r.changed,
        version: r.version,
        sha256_before: r.before_sha256,
        sha256_after: r.after_sha256,
        lines_added: r.diff.added,
        lines_removed: r.diff.removed,
        note: r.changed ? "Saved. The previous text is kept as a numbered version." : "Nothing changed: the file already says this.",
      };
    },
    trustOf: () => "trusted",
  });
  return [update] as unknown as ToolDef[];
}
