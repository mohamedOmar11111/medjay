// A publish_post action is bound to ONE version of a draft and that version's SHA-256. This is the check
// that keeps the binding honest, used when the plan is proposed, when its files are written and when they
// are validated: the draft must exist, still match the hash saved with it, be a post (or landing page), and
// have passed the copy check. The plan layer only sees this small port; the drafts store satisfies it.
import type { CompiledAction } from "./types.js";

export interface DraftPort {
  read(workflow: string, slug: string, version?: number): Promise<{ meta: { kind: string; sha256: string; check: { status: string } }; text: string; intact: boolean }>;
}

/** Draft kinds that can become a WordPress post. */
export const PUBLISHABLE_KINDS: readonly string[] = ["post", "landing_page"];

export interface BoundDraft {
  text: string;
  sha256: string;
}

type PublishAction = Extract<CompiledAction, { type: "publish_post" }>;
const isPublish = (a: CompiledAction): a is PublishAction => a.type === "publish_post";

export async function resolvePublishDrafts(actions: readonly CompiledAction[], port: DraftPort | undefined): Promise<{ drafts: Map<string, BoundDraft>; problems: Map<string, string> }> {
  const drafts = new Map<string, BoundDraft>();
  const problems = new Map<string, string>();
  for (const action of actions.filter(isPublish)) {
    const { workflow, slug, version, sha256 } = action.draft;
    const name = `draft ${workflow}/${slug} v${version}`;
    if (!port) {
      problems.set(action.id, `${name}: this workspace has no drafts store to check it against, so it cannot be published`);
      continue;
    }
    let found;
    try {
      found = await port.read(workflow, slug, version);
    } catch (error) {
      problems.set(action.id, `${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!found.intact) problems.set(action.id, `${name} was changed after it was saved (its text no longer matches the saved SHA-256)`);
    else if (found.meta.sha256 !== sha256) problems.set(action.id, `${name}: the plan was made for sha256 ${sha256.slice(0, 12)} but that version has ${found.meta.sha256.slice(0, 12)}`);
    else if (!PUBLISHABLE_KINDS.includes(found.meta.kind)) problems.set(action.id, `${name}: a ${found.meta.kind} draft cannot be published as a post (only ${PUBLISHABLE_KINDS.join(" and ")} drafts can)`);
    else if (found.meta.check.status !== "pass") problems.set(action.id, `${name}: its copy check is ${found.meta.check.status}; fix the draft and save a new version`);
    else drafts.set(action.id, { text: found.text, sha256: found.meta.sha256 });
  }
  return { drafts, problems };
}
