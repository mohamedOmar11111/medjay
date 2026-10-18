// The only configurable path in a workspace is the dropzone. It must stay strictly inside the
// workspace root: no absolute paths, no .. escapes, no machine-state folder, no symlink or
// junction that leads outside. Everything else (ledger, database, policy, plans) is fixed.
import { realpath } from "node:fs/promises";
import path from "node:path";

export class DropzoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropzoneError";
  }
}

const MACHINE_STATE_DIR = ".medjay";

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** realpath of the deepest ancestor of `target` that exists (the target itself may not exist yet). */
async function realpathOfDeepestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = parent;
    }
  }
}

/** Resolve a configured dropzone folder to an absolute path inside `root`, or throw DropzoneError. */
export async function resolveDropzone(root: string, configured: string): Promise<string> {
  if (typeof configured !== "string" || configured.trim() === "") throw new DropzoneError("dropzone_dir is empty");
  if (configured.includes("\0")) throw new DropzoneError("dropzone_dir contains a null byte");
  if (path.win32.isAbsolute(configured) || path.posix.isAbsolute(configured)) {
    throw new DropzoneError("dropzone_dir must be relative to the workspace, not an absolute path");
  }
  const normalized = path.posix.normalize(configured.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") throw new DropzoneError("dropzone_dir cannot be the workspace root itself");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new DropzoneError("dropzone_dir escapes the workspace root");
  }
  if (normalized.split("/").some((segment) => segment.toLowerCase() === MACHINE_STATE_DIR)) {
    throw new DropzoneError(`dropzone_dir cannot be inside ${MACHINE_STATE_DIR}/ (machine state)`);
  }

  const lexical = path.resolve(root, normalized);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpathOfDeepestExisting(lexical)]);
  if (!isInside(realRoot, realTarget)) {
    throw new DropzoneError("dropzone_dir resolves outside the workspace (symlink or junction)");
  }
  return lexical;
}
