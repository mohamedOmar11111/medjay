// What one agent run may read. A run is bound to ONE workspace (one client): it can read only a
// short allowlist of folders inside that workspace, never machine state (.medjay: ledger, keys,
// database), never anything that looks like a secret, and never anything another workspace holds,
// even through a symlink or junction. Tools get this reader and no raw file access.
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ScopeErrorCode = "denied" | "outside" | "missing" | "not_file" | "not_dir" | "binary";

export class ScopeError extends Error {
  constructor(
    message: string,
    readonly code: ScopeErrorCode,
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

const READ_ROOTS = ["context", "tactics", "plans"] as const;
const READ_FILES = ["workspace.yaml", "shield.policy.yaml"] as const;
const DENIED_SEGMENT = /^(?:\.medjay|\.git)$/i;
const DENIED_NAME = /^\.env(?:\..*)?$|\.(?:pem|key|p12|pfx|jks)$|^signing/i;
const DEFAULT_MAX_READ_BYTES = 120_000;
const BINARY_SNIFF_BYTES = 8192;

export interface RunScopeOptions {
  workspaceDir: string;
  workspaceId: string;
  client?: string;
  dropzoneDir: string;
  maxReadBytes?: number;
}

export interface ReadResult {
  text: string;
  /** Size of the whole file, even when only a prefix was returned. */
  bytes: number;
  truncated: boolean;
  /** When the file was last modified (ISO 8601): the date the content is true as of. */
  as_of: string;
  source: string;
}

export interface ListEntry {
  name: string;
  type: "file" | "dir";
  bytes?: number;
  as_of: string;
}

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Cut a UTF-8 buffer back to its last complete character. */
function trimToUtf8Boundary(buffer: Buffer): Buffer {
  let end = buffer.length;
  let back = 0;
  while (end > 0 && back < 4 && ((buffer[end - 1] as number) & 0xc0) === 0x80) {
    end -= 1;
    back += 1;
  }
  if (end === 0) return buffer.subarray(0, 0);
  const lead = buffer[end - 1] as number;
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return needed === back + 1 ? buffer : buffer.subarray(0, end - 1);
}

export class RunScope {
  private constructor(
    readonly workspaceId: string,
    readonly client: string | undefined,
    private readonly root: string,
    private readonly dropzoneRel: string,
    private readonly maxReadBytes: number,
  ) {}

  static async create(options: RunScopeOptions): Promise<RunScope> {
    const root = await realpath(path.resolve(options.workspaceDir));
    const lexicalRoot = path.resolve(options.workspaceDir);
    const dropzoneRel = path.relative(lexicalRoot, path.resolve(options.dropzoneDir)).split(path.sep).join("/");
    if (dropzoneRel === "" || dropzoneRel.startsWith("..") || path.isAbsolute(dropzoneRel)) {
      throw new Error("the dropzone must be a folder inside the workspace");
    }
    return new RunScope(options.workspaceId, options.client, root, dropzoneRel, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  }

  /** Whether a relative path is in the dropzone, where files come from outside and are untrusted. */
  isDropzone(rel: string): boolean {
    try {
      const n = this.normalize(rel);
      return n === this.dropzoneRel || n.startsWith(`${this.dropzoneRel}/`);
    } catch {
      return false;
    }
  }

  /** Lexical check only (no disk access): used to refuse a path before a tool runs. */
  assertAllowed(rel: string): void {
    const n = this.normalize(rel, true);
    if (n !== "" && !this.allowed(n)) throw new ScopeError(`"${rel}" is outside what a run may read`, "denied");
  }

  async readText(rel: string): Promise<ReadResult> {
    const { abs, rel: n } = await this.resolve(rel, "file");
    const info = await stat(abs);
    const handle = await open(abs, "r");
    try {
      const want = Math.min(info.size, this.maxReadBytes);
      const buffer = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buffer, 0, want, 0);
      let data: Buffer = buffer.subarray(0, bytesRead);
      if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new ScopeError(`"${rel}" looks like a binary file`, "binary");
      const truncated = info.size > this.maxReadBytes;
      if (truncated) data = trimToUtf8Boundary(data);
      return { text: data.toString("utf8"), bytes: info.size, truncated, as_of: info.mtime.toISOString(), source: `file:${n}` };
    } finally {
      await handle.close();
    }
  }

  async list(rel: string): Promise<ListEntry[]> {
    const n = this.normalize(rel, true);
    if (n === "") return this.listTop();
    const { abs } = await this.resolve(n, "dir");
    const out: ListEntry[] = [];
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || DENIED_SEGMENT.test(entry.name) || DENIED_NAME.test(entry.name)) continue;
      const info = await stat(path.join(abs, entry.name)).catch(() => undefined);
      if (!info) continue;
      out.push(
        entry.isDirectory()
          ? { name: entry.name, type: "dir", as_of: info.mtime.toISOString() }
          : { name: entry.name, type: "file", bytes: info.size, as_of: info.mtime.toISOString() },
      );
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async listTop(): Promise<ListEntry[]> {
    const out: ListEntry[] = [];
    for (const name of [...READ_ROOTS, this.dropzoneRel]) {
      const info = await stat(path.join(this.root, name)).catch(() => undefined);
      if (info?.isDirectory()) out.push({ name, type: "dir", as_of: info.mtime.toISOString() });
    }
    for (const name of READ_FILES) {
      const info = await stat(path.join(this.root, name)).catch(() => undefined);
      if (info?.isFile()) out.push({ name, type: "file", bytes: info.size, as_of: info.mtime.toISOString() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private normalize(rel: string, allowRoot = false): string {
    if (typeof rel !== "string") throw new ScopeError("path must be a string", "denied");
    if (rel.includes("\0")) throw new ScopeError("path contains a null byte", "denied");
    if (path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) throw new ScopeError("absolute paths are not allowed; use a path relative to the workspace", "outside");
    const n = path.posix.normalize(rel.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/\/+$/, "");
    if (n === ".." || n.startsWith("../")) throw new ScopeError("path escapes the workspace", "outside");
    if (n === "" || n === ".") {
      if (allowRoot) return "";
      throw new ScopeError("a file path is required", "denied");
    }
    const segments = n.split("/");
    if (segments.some((s) => DENIED_SEGMENT.test(s))) throw new ScopeError("machine state is not readable by a run", "denied");
    if (DENIED_NAME.test(segments[segments.length - 1] as string)) throw new ScopeError("files that look like secrets are not readable by a run", "denied");
    return n;
  }

  private allowed(n: string): boolean {
    if ((READ_FILES as readonly string[]).includes(n)) return true;
    const first = n.split("/")[0] as string;
    if ((READ_ROOTS as readonly string[]).includes(first)) return true;
    return n === this.dropzoneRel || n.startsWith(`${this.dropzoneRel}/`);
  }

  private async resolve(rel: string, kind: "file" | "dir"): Promise<{ abs: string; rel: string }> {
    const n = this.normalize(rel);
    if (!this.allowed(n)) throw new ScopeError(`"${rel}" is outside what a run may read`, "denied");
    let real: string;
    try {
      real = await realpath(path.resolve(this.root, n));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ScopeError(`"${rel}" does not exist`, "missing");
      throw error;
    }
    if (!isInside(this.root, real)) throw new ScopeError(`"${rel}" resolves outside the workspace`, "outside");
    const relReal = path.relative(this.root, real).split(path.sep).join("/");
    // a link inside an allowed folder must not lead into machine state or a non-readable folder
    if (relReal.split("/").some((s) => DENIED_SEGMENT.test(s)) || !this.allowed(relReal)) {
      throw new ScopeError(`"${rel}" resolves to a location a run may not read`, "outside");
    }
    const info = await stat(real);
    if (kind === "file" && !info.isFile()) throw new ScopeError(`"${rel}" is not a file`, "not_file");
    if (kind === "dir" && !info.isDirectory()) throw new ScopeError(`"${rel}" is not a folder`, "not_dir");
    return { abs: real, rel: n };
  }
}
