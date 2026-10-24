// The versioned drafts store: where an agent (or a person) keeps copy, briefs and reports before
// anything leaves Medjay. Every save is a NEW version; nothing is ever overwritten. Each version
// records the SHA-256 of its exact text and the result of the copy check, so a later publish or send
// plan can bind to "this version, this hash" and refuse a draft that changed or failed its check.
//
// Layout: <workspace>/drafts/<workflow>/<slug>/v<N>.md and v<N>.meta.json. Names are slugs only, so a
// path built here can never leave the drafts folder.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffLines, type LineDiff } from "./diff.js";

export const DRAFT_KINDS = ["internal", "report", "ad", "email", "post", "landing_page"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
/** Kinds a customer will read: these are copy-checked before a publish or send plan may use them. */
export const CUSTOMER_FACING: readonly DraftKind[] = ["ad", "email", "post", "landing_page"];

export type CheckStatus = "pass" | "fail" | "not_applicable" | "not_checked";

export interface DraftCheck {
  status: CheckStatus;
  errors: number;
  warnings: number;
  /** Rule ids that fired (never the matched text). */
  rules: string[];
  checked_at: string;
}

export interface DraftMeta {
  version: number;
  workflow: string;
  slug: string;
  kind: DraftKind;
  sha256: string;
  bytes: number;
  created_at: string;
  author: string;
  reverted_from?: number;
  check: DraftCheck;
}

export interface DraftSummary {
  workflow: string;
  slug: string;
  latest: number;
  versions: number;
  kind: DraftKind;
  check: CheckStatus;
  updated_at: string;
}

export type DraftChecker = (text: string, kind: DraftKind) => Omit<DraftCheck, "checked_at">;

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

export interface DraftStoreOptions {
  checker?: DraftChecker;
  /** Told about every save: hash, size and check result, never the text. */
  audit?: (event: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
export const MAX_DRAFT_BYTES = 100_000;
export const MAX_VERSIONS = 200;
const MAX_DIFF_LINES = 3000;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function checkedName(label: string, value: string): string {
  if (!NAME.test(value) || RESERVED.test(value)) {
    throw new DraftError(`${label} must be 1-64 characters: lowercase letters, digits and dashes, starting with a letter or digit (got "${value.slice(0, 40)}")`);
  }
  return value;
}

export class DraftStore {
  private readonly root: string;
  private readonly now: () => Date;

  constructor(
    workspaceDir: string,
    private readonly options: DraftStoreOptions = {},
  ) {
    this.root = join(workspaceDir, "drafts");
    this.now = options.now ?? (() => new Date());
  }

  private folder(workflow: string, slug: string): string {
    return join(this.root, checkedName("workflow", workflow), checkedName("slug", slug));
  }

  private async versionNumbers(folder: string): Promise<number[]> {
    try {
      return (await readdir(folder))
        .map((f) => /^v(\d+)\.md$/.exec(f)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(input: { workflow: string; slug: string; kind: DraftKind; text: string; author: string; revertedFrom?: number }): Promise<DraftMeta> {
    const folder = this.folder(input.workflow, input.slug);
    if (!(DRAFT_KINDS as readonly string[]).includes(input.kind)) throw new DraftError(`kind must be one of: ${DRAFT_KINDS.join(", ")}`);
    if (input.text.trim() === "") throw new DraftError("the draft is empty");
    if (input.text.includes("\0")) throw new DraftError("the draft contains a null character");
    const bytes = Buffer.byteLength(input.text, "utf8");
    if (bytes > MAX_DRAFT_BYTES) throw new DraftError(`the draft is too large (${bytes} bytes; the limit is ${MAX_DRAFT_BYTES})`);

    await mkdir(folder, { recursive: true });
    let version = ((await this.versionNumbers(folder)).pop() ?? 0) + 1;
    // "wx" fails if the file exists, so two saves at once can never write the same version
    for (let attempt = 0; ; attempt += 1) {
      if (version > MAX_VERSIONS) throw new DraftError(`this draft already has ${MAX_VERSIONS} versions; start a new slug`);
      try {
        await writeFile(join(folder, `v${version}.md`), input.text, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 20) throw error;
        version += 1;
      }
    }

    const checkedAt = this.now().toISOString();
    let check: DraftCheck;
    if (!CUSTOMER_FACING.includes(input.kind)) check = { status: "not_applicable", errors: 0, warnings: 0, rules: [], checked_at: checkedAt };
    else if (!this.options.checker) check = { status: "not_checked", errors: 0, warnings: 0, rules: [], checked_at: checkedAt };
    else check = { ...this.options.checker(input.text, input.kind), checked_at: checkedAt };

    const meta: DraftMeta = {
      version,
      workflow: input.workflow,
      slug: input.slug,
      kind: input.kind,
      sha256: sha256(input.text),
      bytes,
      created_at: checkedAt,
      author: input.author,
      ...(input.revertedFrom === undefined ? {} : { reverted_from: input.revertedFrom }),
      check,
    };
    await writeFile(join(folder, `v${version}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await this.options.audit?.({ event: "draft.saved", workflow: meta.workflow, slug: meta.slug, version, kind: meta.kind, sha256: meta.sha256, bytes, check: check.status, author: input.author, ...(input.revertedFrom === undefined ? {} : { reverted_from: input.revertedFrom }) });
    return meta;
  }

  private async metaOf(folder: string, version: number): Promise<DraftMeta | null> {
    try {
      return JSON.parse(await readFile(join(folder, `v${version}.meta.json`), "utf8")) as DraftMeta;
    } catch {
      return null;
    }
  }

  /** The metas of every version of one draft, oldest first. */
  async versions(workflow: string, slug: string): Promise<DraftMeta[]> {
    const folder = this.folder(workflow, slug);
    const metas: DraftMeta[] = [];
    for (const n of await this.versionNumbers(folder)) {
      const meta = await this.metaOf(folder, n);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  async read(workflow: string, slug: string, version?: number): Promise<{ meta: DraftMeta; text: string; intact: boolean }> {
    const metas = await this.versions(workflow, slug);
    if (metas.length === 0) throw new DraftError(`no draft "${workflow}/${slug}"`);
    const meta = version === undefined ? (metas[metas.length - 1] as DraftMeta) : metas.find((m) => m.version === version);
    if (!meta) throw new DraftError(`"${workflow}/${slug}" has no version ${version}; it has ${metas.map((m) => `v${m.version}`).join(", ")}`);
    const text = await readFile(join(this.folder(workflow, slug), `v${meta.version}.md`), "utf8");
    return { meta, text, intact: sha256(text) === meta.sha256 };
  }

  async list(workflow?: string): Promise<DraftSummary[]> {
    const out: DraftSummary[] = [];
    let workflows: string[];
    try {
      workflows = workflow ? [checkedName("workflow", workflow)] : (await readdir(this.root)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const w of workflows) {
      let slugs: string[];
      try {
        slugs = (await readdir(join(this.root, w))).sort();
      } catch {
        continue;
      }
      for (const slug of slugs) {
        if (!NAME.test(slug)) continue;
        const metas = await this.versions(w, slug);
        const last = metas[metas.length - 1];
        if (last) out.push({ workflow: w, slug, latest: last.version, versions: metas.length, kind: last.kind, check: last.check.status, updated_at: last.created_at });
      }
    }
    return out;
  }

  /** Every saved version whose text no longer matches the hash recorded when it was saved. */
  async verify(): Promise<{ workflow: string; slug: string; version: number; problem: string }[]> {
    const problems: { workflow: string; slug: string; version: number; problem: string }[] = [];
    for (const d of await this.list()) {
      for (const meta of await this.versions(d.workflow, d.slug)) {
        const { intact } = await this.read(d.workflow, d.slug, meta.version).catch(() => ({ intact: false }));
        if (!intact) problems.push({ workflow: d.workflow, slug: d.slug, version: meta.version, problem: "content no longer matches the saved SHA-256" });
      }
    }
    return problems;
  }

  async diff(workflow: string, slug: string, from: number, to: number): Promise<LineDiff> {
    const a = (await this.read(workflow, slug, from)).text;
    const b = (await this.read(workflow, slug, to)).text;
    if (a.split("\n").length > MAX_DIFF_LINES || b.split("\n").length > MAX_DIFF_LINES) throw new DraftError(`too large to compare (over ${MAX_DIFF_LINES} lines)`);
    return diffLines(a, b);
  }

  /** Save an earlier version's text as a new version (the history is kept). */
  async revert(workflow: string, slug: string, toVersion: number, author: string): Promise<DraftMeta> {
    const old = await this.read(workflow, slug, toVersion);
    return this.save({ workflow, slug, kind: old.meta.kind, text: old.text, author, revertedFrom: toVersion });
  }
}
