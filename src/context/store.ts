// The four context files the guide asks the owner to fill (unit economics, offers, brand voice, claims).
// This is the ONLY place an agent's words can reach a workspace file, and only these four, only after a
// person allowed the change (the policy asks first). The tool that calls it imports no filesystem module.
//
// A change keeps the previous text as a numbered version under .medjay/context-history/<file>/v<N>.md, is
// written atomically (temp file, then rename) and is reported to the audit log by hash, never by text.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { INPUTS, parseUnitEconomics } from "../analysis/simulate.js";
import { diffLines, type LineDiff } from "../drafts/diff.js";

export const CONTEXT_FILES = ["unit-economics", "offer-matrix", "brand-voice", "claims"] as const;
export type ContextFile = (typeof CONTEXT_FILES)[number];
export const MAX_CONTEXT_BYTES = 20_000;

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export interface ContextProposal {
  file: ContextFile;
  changed: boolean;
  before_sha256: string;
  after_sha256: string;
  diff: LineDiff;
}

export interface ContextApplied extends ContextProposal {
  /** The history number the previous text was saved under; 0 when nothing changed. */
  version: number;
}

export interface ContextStoreOptions {
  /** Told about every change: hashes and size, never the text. */
  audit?: (event: Record<string, unknown>) => Promise<void>;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const normalise = (text: string) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

function checkedFile(name: unknown): ContextFile {
  if (typeof name !== "string" || !(CONTEXT_FILES as readonly string[]).includes(name)) {
    throw new ContextError(`only these files can be updated: ${CONTEXT_FILES.join(", ")}`);
  }
  return name as ContextFile;
}

function frontMatter(file: ContextFile, text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) {
    if (file === "unit-economics") throw new ContextError("unit-economics needs a front matter block (--- ... ---) with the currency and the ranged inputs");
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] as string);
  } catch {
    throw new ContextError("the front matter (between the two --- lines) is not valid YAML");
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new ContextError("the front matter must be a list of name: value lines, not a plain list or a single value");
  return parsed as Record<string, unknown>;
}

/** Throws a ContextError saying what is wrong, in words the owner can act on. */
function validate(file: ContextFile, text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.trim() === "") throw new ContextError("the file would be empty");
  if (text.includes("\0")) throw new ContextError("the text contains a null character");
  if (bytes > MAX_CONTEXT_BYTES) throw new ContextError(`the text is too large (${bytes} bytes; the limit is ${MAX_CONTEXT_BYTES})`);
  const front = frontMatter(file, text);
  if (file === "unit-economics") {
    const parsed = parseUnitEconomics(text);
    const wrong = parsed.problems.filter((p) => p.problem !== "missing");
    if (wrong.length > 0) throw new ContextError(wrong.map((p) => `${p.input}: ${p.message}`).join("; "));
    const PLACEHOLDER = /^(?:|missing|unknown|n\/a|na|none|null|tbd|todo|-+)$/i;
    const flat = Object.entries(parsed.inputs).filter(([, v]) => v.low === v.high);
    if (flat.length > 0) {
      throw new ContextError(`${flat.map(([k]) => k).join(", ")}: low and high are the same, so there is no range. Give a plausible range (low < high), or leave the input as it is in the file if you do not have it`);
    }
    const unsourced = Object.entries(parsed.inputs).filter(([, v]) => PLACEHOLDER.test(v.source.trim()));
    if (unsourced.length > 0) {
      throw new ContextError(`${unsourced.map(([k]) => k).join(", ")}: needs a real source (where the number came from). Leave an input you do not have as it is in the file instead of filling it with 0 or "missing"`);
    }
    if (Object.keys(parsed.inputs).length === 0) {
      const keys = INPUTS.map((i) => i.key).join(", ");
      throw new ContextError(`unit-economics needs at least one input under its own name (${keys}), each as { value, low, high, source } in the front matter; keep the file's existing layout`);
    }
  }
  if (file === "claims" && front.claims !== undefined && !Array.isArray(front.claims)) throw new ContextError("claims must be a list");
  if (file === "brand-voice" && front.forbidden_phrases !== undefined && !Array.isArray(front.forbidden_phrases)) throw new ContextError("forbidden_phrases must be a list");
}

export class ContextStore {
  constructor(
    private readonly workspaceDir: string,
    private readonly options: ContextStoreOptions = {},
  ) {}

  private path(file: ContextFile): string {
    return join(this.workspaceDir, "context", `${file}.md`);
  }

  private async current(file: ContextFile): Promise<string> {
    try {
      return normalise(await readFile(this.path(file), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  /** What an update would change, after checking it could be saved. Writes nothing. */
  async propose(name: ContextFile, text: string): Promise<ContextProposal> {
    const file = checkedFile(name);
    const next = normalise(text);
    validate(file, next);
    const before = await this.current(file);
    return { file, changed: before !== next, before_sha256: sha256(before), after_sha256: sha256(next), diff: diffLines(before, next) };
  }

  async apply(name: ContextFile, text: string, who: { author: string; reason: string }): Promise<ContextApplied> {
    const proposal = await this.propose(name, text);
    if (!proposal.changed) return { ...proposal, version: 0 };
    const { file } = proposal;
    const next = normalise(text);
    const before = await this.current(file);

    const history = join(this.workspaceDir, ".medjay", "context-history", file);
    await mkdir(history, { recursive: true });
    let version = 1;
    // "wx" fails if the number is taken, so two updates at once cannot share a history slot
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeFile(join(history, `v${version}.md`), before, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 500) throw error;
        version += 1;
      }
    }

    const temp = join(this.workspaceDir, "context", `.${file}.tmp`);
    await writeFile(temp, next, "utf8");
    await rename(temp, this.path(file));
    await this.options.audit?.({
      event: "context.updated",
      author: who.author,
      file,
      version,
      before_sha256: proposal.before_sha256,
      after_sha256: proposal.after_sha256,
      bytes: Buffer.byteLength(next, "utf8"),
      reason: who.reason.slice(0, 300),
    });
    return { ...proposal, version };
  }
}
