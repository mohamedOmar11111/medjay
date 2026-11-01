// The workspace's profile (name, business type, currency, language, timezone, vertical): the few facts the
// AI model learns about the business in the first conversation and writes into workspace.yaml. It is the
// only part of workspace.yaml an agent may change, and only after the owner allows each change.
//
// The file is edited as a YAML document, so comments and the rest of the settings are left exactly as they
// were. The result is checked against the real workspace schema before anything is written; the old file is
// kept as a numbered version; the audit log records which fields changed, never their values.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { parseUnitEconomics } from "../analysis/simulate.js";
import { BUSINESS_TYPES, DEFAULT_PILLARS, type BusinessType } from "../pillars/catalog.js";
import { WORKSPACE_FILE } from "../workspace/errors.js";
import { WorkspaceSchema } from "../workspace/schema.js";

export { BUSINESS_TYPES };
export const PROFILE_FIELDS = ["name", "business_type", "base_currency", "timezone", "language", "vertical"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface ProfileChange {
  name?: string;
  business_type?: BusinessType;
  base_currency?: string;
  timezone?: string;
  /** Primary language code, for example en or ar. */
  language?: string;
  vertical?: string;
}

export interface ProfileProposal {
  changed: boolean;
  changes: { field: ProfileField; from: string | null; to: string }[];
  /** Changed lines marked "- " and "+ ". */
  diff: string;
}

export interface ProfileApplied extends ProfileProposal {
  version: number;
  /** What happened to context/unit-economics.md when the currency changed. */
  unit_economics?: string;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface ProfileStoreOptions {
  audit?: (event: Record<string, unknown>) => Promise<void>;
}

const PATHS: Record<ProfileField, string[]> = {
  name: ["workspace", "name"],
  business_type: ["workspace", "business_type"],
  base_currency: ["workspace", "base_currency"],
  timezone: ["workspace", "timezone"],
  language: ["localization", "languages", "primary"],
  vertical: ["workspace", "vertical"],
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function describeIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 4)
    .map((i) => `${i.path.filter((p) => typeof p === "string").slice(-1)[0] ?? "workspace"}: ${i.message}`)
    .join("; ");
}

export class ProfileStore {
  constructor(
    private readonly workspaceDir: string,
    private readonly options: ProfileStoreOptions = {},
  ) {}

  private get file(): string {
    return join(this.workspaceDir, WORKSPACE_FILE);
  }

  /** The edited document and the planned changes; throws a ProfileError when the result would not be a valid workspace. */
  private async plan(change: ProfileChange): Promise<{ before: string; after: string; proposal: ProfileProposal; oldCurrency: string | null }> {
    const wanted = PROFILE_FIELDS.filter((f) => change[f] !== undefined);
    if (wanted.length === 0) throw new ProfileError(`give at least one of: ${PROFILE_FIELDS.join(", ")}`);
    for (const f of wanted) {
      const v = change[f];
      if (typeof v !== "string" || v.trim() === "") throw new ProfileError(`${f}: must be some text`);
    }
    if (change.business_type !== undefined && !(BUSINESS_TYPES as readonly string[]).includes(change.business_type)) {
      throw new ProfileError(`business_type: must be one of ${BUSINESS_TYPES.join(", ")}`);
    }

    const before = await readFile(this.file, "utf8");
    const doc = parseDocument(before);
    if (doc.errors.length > 0) throw new ProfileError("workspace.yaml could not be read as YAML");
    const current = (path: string[]) => {
      const v = doc.getIn(path);
      return typeof v === "string" ? v : null;
    };
    const oldType = current(PATHS.business_type) as BusinessType | null;
    const oldCurrency = current(PATHS.base_currency);

    const changes: ProfileProposal["changes"] = [];
    for (const f of wanted) {
      const to = (change[f] as string).trim();
      const from = current(PATHS[f]);
      if (from === to) continue;
      doc.setIn(PATHS[f], to);
      changes.push({ field: f, from, to });
    }

    // the business type brings its default pillars, unless the owner chose their own
    if (changes.some((c) => c.field === "business_type") && oldType !== null && change.business_type !== undefined) {
      const active = doc.getIn(["pillars", "active"]);
      const plain = active !== null && typeof active === "object" && "toJSON" in active ? (active as { toJSON(): unknown }).toJSON() : active;
      if (isDeepStrictEqual(plain, DEFAULT_PILLARS[oldType])) doc.setIn(["pillars", "active"], DEFAULT_PILLARS[change.business_type]);
    }

    const checked = WorkspaceSchema.safeParse(doc.toJS());
    if (!checked.success) throw new ProfileError(describeIssues(checked.error.issues));
    const diff = changes.flatMap((c) => [c.from === null ? "" : `- ${c.field}: ${c.from}`, `+ ${c.field}: ${c.to}`]).filter(Boolean).join("\n");
    return { before, after: doc.toString(), proposal: { changed: changes.length > 0, changes, diff }, oldCurrency };
  }

  /** What would change. Writes nothing. */
  async propose(change: ProfileChange): Promise<ProfileProposal> {
    return (await this.plan(change)).proposal;
  }

  async apply(change: ProfileChange, who: { author: string; reason: string }): Promise<ProfileApplied> {
    const { before, after, proposal, oldCurrency } = await this.plan(change);
    if (!proposal.changed) return { ...proposal, version: 0 };

    const history = join(this.workspaceDir, ".medjay", "context-history", "workspace-profile");
    await mkdir(history, { recursive: true });
    let version = 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeFile(join(history, `v${version}.yaml`), before, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 500) throw error;
        version += 1;
      }
    }
    const temp = join(this.workspaceDir, ".workspace.yaml.tmp");
    await writeFile(temp, after, "utf8");
    await rename(temp, this.file);

    const currency = proposal.changes.find((c) => c.field === "base_currency");
    const unit_economics = currency && oldCurrency ? await this.followCurrency(oldCurrency, currency.to) : undefined;

    await this.options.audit?.({
      event: "workspace.profile_updated",
      author: who.author,
      fields: proposal.changes.map((c) => c.field),
      version,
      before_sha256: sha256(before),
      after_sha256: sha256(after),
      reason: who.reason.slice(0, 300),
    });
    return { ...proposal, version, ...(unit_economics === undefined ? {} : { unit_economics }) };
  }

  /** A unit-economics file that is still the template follows the new currency; one with numbers in it is left alone. */
  private async followCurrency(from: string, to: string): Promise<string> {
    const path = join(this.workspaceDir, "context", "unit-economics.md");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return "no unit-economics file to update";
    }
    if (Object.keys(parseUnitEconomics(text).inputs).length > 0) {
      return `context/unit-economics.md already has numbers in ${from}; left as it is. Ask the owner whether they are in ${to}, then update it with context_update`;
    }
    const next = text.replace(new RegExp(`^currency: ${from}$`, "m"), `currency: ${to}`);
    if (next === text) return "context/unit-economics.md had no matching currency line";
    await writeFile(path, next, "utf8");
    return `context/unit-economics.md currency changed from ${from} to ${to}`;
  }
}
