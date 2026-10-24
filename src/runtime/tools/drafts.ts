// The drafts store as agent tools. Saving is the only thing the agent can write, and it can write
// only here: a new version, in a sandboxed folder, with its copy check recorded. Nothing a draft says
// reaches a customer until a plan binds to a specific version and hash and a human approves it.
import { z } from "zod";
import { DRAFT_KINDS, type DraftStore } from "../../drafts/store.js";
import { defineTool, type ToolDef } from "../registry.js";

const Name = z.string().min(1).max(64);

export function draftTools(store: DraftStore): ToolDef[] {
  const save = defineTool({
    name: "draft_save",
    description:
      "Save text as a new version of a draft (copy, an email sequence, a brief, a report). Every save is a new version; nothing is overwritten. workflow and slug are short names using lowercase letters, digits and dashes (for example workflow 'email', slug 'umrah-follow-up'). Customer-facing kinds (ad, email, post, landing_page) are checked against the anti-slop rules and the claim register; the result comes back with the version. If the check fails, fix what it lists and save again as a new version.",
    class: "draft",
    input: z.object({ workflow: Name, slug: Name, kind: z.enum(DRAFT_KINDS), text: z.string().min(1).max(100_000) }).strict(),
    execute: async ({ workflow, slug, kind, text }, ctx) => {
      const meta = await store.save({ workflow, slug, kind, text, author: `agent:${ctx.runId}` });
      return {
        workflow: meta.workflow,
        slug: meta.slug,
        version: meta.version,
        kind: meta.kind,
        sha256: meta.sha256,
        bytes: meta.bytes,
        check: { status: meta.check.status, errors: meta.check.errors, warnings: meta.check.warnings, rules: meta.check.rules },
        note:
          meta.check.status === "fail"
            ? "The copy check failed. Fix what the rules list and save again as a new version; this version cannot be used for a publish or send plan."
            : meta.check.status === "not_checked"
              ? "This customer-facing draft could not be checked, so it cannot be used for a publish or send plan yet."
              : "Saved.",
      };
    },
  });

  const read = defineTool({
    name: "draft_read",
    description: "Read a draft: the latest version, or a given one. Returns the text, its SHA-256, its copy-check result, and whether the file still matches the hash saved with it.",
    class: "read",
    input: z.object({ workflow: Name, slug: Name, version: z.number().int().min(1).optional() }).strict(),
    execute: async ({ workflow, slug, version }) => {
      const { meta, text, intact } = await store.read(workflow, slug, version);
      return { workflow, slug, version: meta.version, kind: meta.kind, sha256: meta.sha256, created_at: meta.created_at, author: meta.author, check: meta.check, intact, text };
    },
  });

  const list = defineTool({
    name: "draft_list",
    description: "List drafts (all, or one workflow): latest version, how many versions, kind and copy-check status.",
    class: "read",
    input: z.object({ workflow: Name.optional() }).strict(),
    execute: async ({ workflow }) => ({ drafts: await store.list(workflow) }),
  });

  const diff = defineTool({
    name: "draft_diff",
    description: "Show what changed between two versions of a draft (lines added and removed).",
    class: "read",
    input: z.object({ workflow: Name, slug: Name, from: z.number().int().min(1), to: z.number().int().min(1) }).strict(),
    execute: async ({ workflow, slug, from, to }) => {
      const changes = await store.diff(workflow, slug, from, to);
      const [a, b] = [await store.read(workflow, slug, from), await store.read(workflow, slug, to)];
      return { workflow, slug, from, to, from_sha256: a.meta.sha256, to_sha256: b.meta.sha256, ...changes };
    },
  });

  return [diff, list, read, save] as unknown as ToolDef[];
}
