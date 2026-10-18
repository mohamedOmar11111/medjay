import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../audit/ledger.js";
import { KeyringStore } from "../models/credentials.js";
import { ensureSigningKey, type SigningKeys } from "../plan/signing.js";
import { PlanRepo } from "../plan/repo.js";
import type { PlanDeps } from "../plan/propose.js";
import { loadPolicy } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { findWorkspace, loadWorkspace } from "../workspace/load.js";

export const LEDGER_FILE = join(".medjay", "audit-log.jsonl");
export const STORE_FILE = join(".medjay", "experiments.db");

export async function guarded(action: () => Promise<number | void>): Promise<void> {
  try {
    const code = await action();
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export async function workspaceDirOrThrow(explicit?: string): Promise<string> {
  const dir = explicit ? resolve(explicit) : await findWorkspace(process.cwd());
  if (dir === null) throw new Error("no workspace found here; run `mdj init` or pass --workspace <dir>");
  return dir;
}

/** The local operator, recorded as the approver for CLI actions. */
export const cliActor = () => `cli:${userInfo().username}`;

export interface OpenedPlanContext {
  deps: PlanDeps;
  workspaceId: string;
  close: () => void;
}

/** Open everything a plan command needs. Signing keys are only loaded when asked for. */
export async function openPlanContext(workspaceOption: string | undefined, needSigning: boolean): Promise<OpenedPlanContext> {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config } = await loadWorkspace(dir);
  const policy = await loadPolicy(dir);
  const store = Store.open(join(dir, STORE_FILE));
  let signing: SigningKeys | undefined;
  try {
    if (needSigning) {
      signing = await ensureSigningKey({ dir, workspaceId: config.workspace.id, keystore: new KeyringStore(), env: process.env });
    }
  } catch (error) {
    store.close();
    throw error;
  }
  return {
    deps: {
      dir,
      repo: new PlanRepo(store),
      ledger: new Ledger(join(dir, LEDGER_FILE)),
      policy,
      ...(signing ? { signing } : {}),
      now: () => new Date(),
    },
    workspaceId: config.workspace.id,
    close: () => store.close(),
  };
}
