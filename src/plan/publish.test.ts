import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupPlans, type PlanHarness } from "../../test/helpers/plans.js";
import { DraftStore, type DraftChecker } from "../drafts/store.js";
import { approvePlan } from "./approve.js";
import { PlanInputError } from "./compile.js";
import { markdownToHtml } from "./markdown.js";
import { proposePlan } from "./propose.js";
import { strikePlan } from "./strike.js";
import { validateExport } from "./validate.js";
import { readPlanFile } from "./files.js";

let h: PlanHarness;
beforeEach(async () => {
  h = await setupPlans({ require_simulation_for_scale: false });
});
afterEach(async () => {
  await h.cleanup();
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const passing: DraftChecker = () => ({ status: "pass", errors: 0, warnings: 0, rules: [] });
const failing: DraftChecker = () => ({ status: "fail", errors: 1, warnings: 0, rules: ["claims.unverified"] });

const POST_TEXT = "# Umrah in Ramadan\n\nPlan **early** and bring [the checklist](https://example.com/list).\n\n- Passport\n- Visa";

async function saved(kind: "post" | "email" | "landing_page" | "report" = "post", checker: DraftChecker | null = passing, text = POST_TEXT) {
  const drafts = new DraftStore(h.dir, checker ? { checker } : {});
  const meta = await drafts.save({ workflow: "posts", slug: "umrah-guide", kind, text, author: "agent:run_1" });
  return { drafts, meta };
}
const proposal = (meta: { version: number; sha256: string }, over: Record<string, unknown> = {}) => ({
  type: "publish_post" as const,
  site: "etlaala-trips",
  draft: { workflow: "posts", slug: "umrah-guide", version: meta.version, sha256: meta.sha256 },
  title: "Umrah in Ramadan: a calm guide",
  ...over,
});
const propose = (drafts: DraftStore | undefined, p: ReturnType<typeof proposal>) => proposePlan({ ...h.deps, ...(drafts ? { drafts } : {}) }, { workspace: "ws", origin: { job: "content", finding_ids: [] }, proposals: [p] });

describe("proposing a publish_post plan checks the draft it is bound to", () => {
  it("accepts a post draft that is intact, hash-matching and copy-checked", async () => {
    const { drafts, meta } = await saved();
    const { plan, row } = await propose(drafts, proposal(meta));
    expect(row.state).toBe("proposed");
    expect(plan.actions[0]).toMatchObject({ type: "publish_post", draft: { version: 1, sha256: meta.sha256 } });
  });

  it("refuses a draft that does not exist, or a version that does not", async () => {
    const { drafts, meta } = await saved();
    await expect(propose(drafts, proposal(meta, { draft: { workflow: "posts", slug: "nothing", version: 1, sha256: meta.sha256 } }))).rejects.toThrow(/no draft/);
    await expect(propose(drafts, proposal(meta, { draft: { workflow: "posts", slug: "umrah-guide", version: 9, sha256: meta.sha256 } }))).rejects.toThrow(/no version 9/);
  });

  it("refuses when the hash in the plan is not the hash of that version", async () => {
    const { drafts, meta } = await saved();
    await expect(propose(drafts, proposal({ version: meta.version, sha256: "f".repeat(64) }))).rejects.toThrow(/sha256/);
  });

  it("refuses a draft that was edited outside Medjay after it was saved", async () => {
    const { drafts, meta } = await saved();
    await writeFile(join(h.dir, "drafts", "posts", "umrah-guide", "v1.md"), "quietly changed", "utf8");
    await expect(propose(drafts, proposal(meta))).rejects.toThrow(/changed after it was saved/);
  });

  it("refuses a draft whose copy check failed or never ran, and drafts that are not posts", async () => {
    const bad = await saved("post", failing);
    await expect(propose(bad.drafts, proposal(bad.meta))).rejects.toThrow(/copy check is fail/);
    const unchecked = await saved("post", null, "Another post text");
    await expect(propose(unchecked.drafts, proposal(unchecked.meta))).rejects.toThrow(/copy check is not_checked/);
    const email = await saved("email", passing, "An email, not a post");
    await expect(propose(email.drafts, proposal(email.meta))).rejects.toThrow(/email draft cannot be published as a post/);
    const report = await saved("report", passing, "An internal report");
    await expect(propose(report.drafts, proposal(report.meta))).rejects.toThrow(/report draft cannot be published as a post/);
  });

  it("refuses to publish at all when the workspace has no drafts store to check against", async () => {
    const { meta } = await saved();
    await expect(propose(undefined, proposal(meta))).rejects.toThrow(PlanInputError);
    await expect(propose(undefined, proposal(meta))).rejects.toThrow(/drafts store/);
  });

  it("accepts a landing_page draft too", async () => {
    const { drafts, meta } = await saved("landing_page", passing, "# Offer page\n\nBook now.");
    expect((await propose(drafts, proposal(meta))).row.state).toBe("proposed");
  });
});

describe("striking a publish_post plan writes the WordPress request, bound to the approved draft", () => {
  async function approved(over: Record<string, unknown> = {}) {
    const { drafts, meta } = await saved();
    const { row } = await propose(drafts, proposal(meta, over));
    const deps = { ...h.deps, drafts };
    const r = await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    if (r.status === "confirmation_required") await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: r.code });
    return { deps, drafts, meta, number: row.number };
  }

  it("exports wordpress-posts.json with the HTML made from the draft, its hashes and the exact post fields", async () => {
    const { deps, meta, number } = await approved();
    const result = await strikePlan(deps, number, { actor: "cli:omar" });
    expect(result.results).toEqual([{ action_id: "a1", status: "exported", artifact: "wordpress-posts.json" }]);
    const file = JSON.parse(await readFile(join(result.exportDir, "wordpress-posts.json"), "utf8")) as { requests: Record<string, any>[]; note: string };
    const html = markdownToHtml(POST_TEXT);
    expect(file.note).toMatch(/Medjay has not sent/);
    expect(file.requests).toEqual([
      {
        action_id: "a1",
        site: "etlaala-trips",
        method: "POST",
        path: "/wp-json/wp/v2/posts",
        params: { title: "Umrah in Ramadan: a calm guide", content: html, status: "draft" },
        draft: { workflow: "posts", slug: "umrah-guide", version: 1, sha256: meta.sha256 },
        content_sha256: sha(html),
        expect_before: { note: "no post with this title exists yet on this site; stop if one does" },
      },
    ]);
    expect(html).toContain("<strong>early</strong>");
  });

  it("carries the post status and slug through, and never lists the post as a manual step", async () => {
    const { deps, number } = await approved({ post_status: "pending", wp_slug: "umrah-ramadan-guide" });
    const result = await strikePlan(deps, number, { actor: "cli:omar" });
    const file = JSON.parse(await readFile(join(result.exportDir, "wordpress-posts.json"), "utf8")) as { requests: { params: Record<string, string> }[] };
    expect(file.requests[0]!.params).toMatchObject({ status: "pending", slug: "umrah-ramadan-guide" });
    expect(await readFile(join(result.exportDir, "CHANGES.md"), "utf8")).not.toContain("WordPress post");
  });

  it("fails the action, and writes no request, when the draft changed after approval", async () => {
    const { deps, number } = await approved();
    await writeFile(join(h.dir, "drafts", "posts", "umrah-guide", "v1.md"), "edited after the approval", "utf8");
    const result = await strikePlan(deps, number, { actor: "cli:omar" });
    expect(result.results[0]).toMatchObject({ action_id: "a1", status: "failed" });
    expect(result.results[0]!.detail).toMatch(/changed after it was saved/);
    await expect(readFile(join(result.exportDir, "wordpress-posts.json"), "utf8")).rejects.toThrow();
  });
});

describe("validateExport covers the WordPress file", () => {
  async function struck() {
    const { drafts, meta } = await saved();
    const { row } = await propose(drafts, proposal(meta));
    const deps = { ...h.deps, drafts };
    const r = await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli" });
    if (r.status === "confirmation_required") await approvePlan(deps, row.number, { approver: "cli:omar", channel: "cli", confirmationCode: r.code });
    const result = await strikePlan(deps, row.number, { actor: "cli:omar" });
    const plan = await readPlanFile(h.dir, deps.repo.require(row.number));
    return { drafts, plan, exportDir: result.exportDir };
  }

  it("passes on a fresh export", async () => {
    const { drafts, plan } = await struck();
    const v = await validateExport({ dir: h.dir, plan, drafts });
    expect(v.issues).toEqual([]);
    expect(v.checked).toContain("wordpress-posts.json");
  });

  it("catches a hand-edited request file", async () => {
    const { drafts, plan, exportDir } = await struck();
    const path = join(exportDir, "wordpress-posts.json");
    await writeFile(path, (await readFile(path, "utf8")).replace("Umrah in Ramadan: a calm guide", "Something else entirely"), "utf8");
    const v = await validateExport({ dir: h.dir, plan, drafts });
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.message).join("\n")).toMatch(/does not match what the approved plan produces/);
  });

  it("catches a missing file, a draft that changed since, and a check that cannot be made without the drafts store", async () => {
    const { drafts, plan, exportDir } = await struck();
    await writeFile(join(h.dir, "drafts", "posts", "umrah-guide", "v1.md"), "edited later", "utf8");
    expect((await validateExport({ dir: h.dir, plan, drafts })).issues.map((i) => i.message).join("\n")).toMatch(/changed after it was saved/);
    expect((await validateExport({ dir: h.dir, plan })).issues.map((i) => i.message).join("\n")).toMatch(/drafts store/);
    await writeFile(join(exportDir, "wordpress-posts.json"), "", "utf8");
    expect((await validateExport({ dir: h.dir, plan, drafts })).ok).toBe(false);
  });
});
