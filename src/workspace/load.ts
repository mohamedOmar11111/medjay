import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { FORBIDDEN_CONFIG_KEYS } from "../shield/invariants.js";
import { WORKSPACE_FILE, WorkspaceError, type WorkspaceIssue } from "./errors.js";
import { migrateV0Config } from "./migrate.js";
import { DropzoneError, resolveDropzone } from "./paths.js";
import { findSecretLeaks, type SecretLeak } from "../shield/secrets.js";
import { WorkspaceSchema, type WorkspaceConfig } from "./schema.js";

export { WORKSPACE_FILE, WorkspaceError, type WorkspaceIssue };

export interface LoadedWorkspace {
  dir: string;
  config: WorkspaceConfig;
  /** Absolute, validated dropzone folder (always inside the workspace). */
  dropzoneDir: string;
  /** True when the file was schema 0 and was converted in memory only; run `mdj migrate`. */
  migrated: boolean;
  notes: string[];
}

const LEAK_MESSAGE: Record<SecretLeak["reason"], string> = {
  key_name: "key name suggests a secret",
  value_pattern: "value looks like an API key",
  phone_number: "raw phone number; use a SHA-256 hash of the E.164 number or an env/keychain reference",
};

/** Messages for keys that were removed on purpose, so the error teaches instead of just refusing. */
function hintForUnknownKey(key: string, parentPath: string): string {
  if (FORBIDDEN_CONFIG_KEYS.includes(key)) {
    return "voice and confirmation rules are engine invariants (voice can read and draft, never strike; a strike needs a typed command or button tap) and cannot be configured";
  }
  if (parentPath === "" && key === "paths") {
    return "paths are fixed by convention (ledger, database, policy, plans); only ingestion.dropzone_dir is configurable";
  }
  if (["client_copy", "approval", "security"].includes(key)) {
    return "client copy, approval prompts and security/spend warnings are always plain full sentences and cannot be made terse";
  }
  if (key === "display_currencies") {
    return "removed: Medjay performs no silent currency conversion; keep base_currency only (dated FX tables belong in context/unit-economics.md)";
  }
  if (["authorized_senders", "approvers", "senders", "acl"].includes(key)) {
    return "approver allowlists and permissions live in shield.policy.yaml so changes are policy-governed";
  }
  return "unknown key";
}

function describeIssues(error: { issues: readonly { code: string; path: PropertyKey[]; message: string; keys?: string[] }[] }): WorkspaceIssue[] {
  return error.issues.flatMap((issue) => {
    const parent = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys" && issue.keys) {
      return issue.keys.map((key) => ({ path: parent === "" ? key : `${parent}.${key}`, message: hintForUnknownKey(key, parent) }));
    }
    return [{ path: parent, message: issue.message }];
  });
}

export async function loadWorkspace(dir: string): Promise<LoadedWorkspace> {
  const root = resolve(dir);
  const file = join(root, WORKSPACE_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceError(`${WORKSPACE_FILE} not found in ${root}; run \`mdj init\` first`);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = parseYaml(text, { uniqueKeys: true });
  } catch (error) {
    throw new WorkspaceError(`${WORKSPACE_FILE} is not valid YAML`, [
      { path: "", message: error instanceof Error ? error.message.split("\n")[0] ?? "parse error" : "parse error" },
    ]);
  }

  const leaks = findSecretLeaks(raw);
  if (leaks.length > 0) {
    throw new WorkspaceError(
      `${WORKSPACE_FILE} contains secrets or personal data; keep keys out of workspace files (use the OS keychain via \`mdj auth set <ref>\` or MEDJAY_* environment variables)`,
      leaks.map((leak) => ({ path: leak.path, message: LEAK_MESSAGE[leak.reason] })),
    );
  }

  const isV0 = typeof raw === "object" && raw !== null && !("schema_version" in raw);
  let config: WorkspaceConfig;
  let notes: string[] = [];
  if (isV0) {
    ({ config, notes } = migrateV0Config(raw));
  } else {
    const parsed = WorkspaceSchema.safeParse(raw);
    if (!parsed.success) throw new WorkspaceError(`${WORKSPACE_FILE} is invalid`, describeIssues(parsed.error));
    config = parsed.data;
  }

  let dropzoneDir: string;
  try {
    dropzoneDir = await resolveDropzone(root, config.ingestion.dropzone_dir);
  } catch (error) {
    if (error instanceof DropzoneError) {
      throw new WorkspaceError(`${WORKSPACE_FILE} is invalid`, [{ path: "ingestion.dropzone_dir", message: error.message }]);
    }
    throw error;
  }
  return { dir: root, config, dropzoneDir, migrated: isV0, notes };
}

/** Walk up from `start` to the nearest folder containing workspace.yaml. */
export async function findWorkspace(start: string): Promise<string | null> {
  let current = resolve(start);
  for (;;) {
    const found = await stat(join(current, WORKSPACE_FILE)).then(
      (s) => s.isFile(),
      () => false,
    );
    if (found) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
