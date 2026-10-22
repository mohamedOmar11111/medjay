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

/** A named, read-only folder outside the workspace (for example the owner's HQ repo), read as `name:path`. */
export interface ScopeMount {
  name: string;
  path: string;
  /** owner: the owner's own words. untrusted: handled like outside data. */
  trust: "owner" | "untrusted";
  /** Folders inside the mount a run may read; leave out to open the whole mount. */
  allow?: readonly string[];
}

export interface RunScopeOptions {
  workspaceDir: string;
  workspaceId: string;
  client?: string;
  dropzoneDir: string;
  maxReadBytes?: number;
  mounts?: readonly ScopeMount[];
}

const MOUNT_REF = /^([a-z][a-z0-9_-]+):(.*)$/s;
const MOUNT_DENIED_SEGMENT = /^(?:\.medjay|\.git|node_modules|secrets)$/i;
const MOUNT_DENIED_NAME = /^\.env(?:\..*)?$|\.(?:pem|key|p12|pfx|jks)$|^signing|^credentials/i;

interface Mounted {
  root: string;
  trust: "owner" | "untrusted";
  /** Lower-cased folder prefixes a run may read; null when the whole mount is open. */
  allow: string[] | null;
}

const cleanPrefix = (p: string): string => path.posix.normalize(p.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "").toLowerCase();

/** Whether `n` is one of the allowed folders or inside one. */
const insideAllowed = (mounted: Mounted, n: string): boolean => mounted.allow === null || mounted.allow.some((p) => n.toLowerCase() === p || n.toLowerCase().startsWith(`${p}/`));
/** Whether `n` is a folder on the way down to an allowed folder (so it may be listed, not read into). */
const leadsToAllowed = (mounted: Mounted, n: string): boolean => mounted.allow !== null && (n === "" || mounted.allow.some((p) => p.startsWith(`${n.toLowerCase()}/`)));

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
    private readonly mounts: ReadonlyMap<string, Mounted> = new Map(),
  ) {}

  static async create(options: RunScopeOptions): Promise<RunScope> {
    const mounts = new Map<string, Mounted>();
    for (const mount of options.mounts ?? []) {
      if (!/^[a-z][a-z0-9_-]+$/.test(mount.name)) continue;
      try {
        const real = await realpath(path.resolve(mount.path));
        const allow = (mount.allow ?? []).map(cleanPrefix).filter((p) => p !== "" && p !== ".");
        if ((await stat(real)).isDirectory()) mounts.set(mount.name, { root: real, trust: mount.trust, allow: allow.length > 0 ? allow : null });
      } catch {
        /* a mount whose folder is not there is simply not mounted */
      }
    }
    const root = await realpath(path.resolve(options.workspaceDir));
    const lexicalRoot = path.resolve(options.workspaceDir);
    const dropzoneRel = path.relative(lexicalRoot, path.resolve(options.dropzoneDir)).split(path.sep).join("/");
    if (dropzoneRel === "" || dropzoneRel.startsWith("..") || path.isAbsolute(dropzoneRel)) {
      throw new Error("the dropzone must be a folder inside the workspace");
    }
    return new RunScope(options.workspaceId, options.client, root, dropzoneRel, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES, mounts);
  }

  /** `hq:03_Global_Assets/x.md` becomes the mount and the path inside it; null for an ordinary workspace path. */
  private mountRef(rel: string): { name: string; inner: string } | null {
    const m = typeof rel === "string" ? MOUNT_REF.exec(rel) : null;
    return m ? { name: m[1] as string, inner: m[2] as string } : null;
  }

  private mountOrThrow(name: string): Mounted {
    const mounted = this.mounts.get(name);
    if (!mounted) throw new ScopeError(`"${name}:" is not a mounted folder`, "denied");
    return mounted;
  }

  /** The path inside a mount, checked lexically: relative, no "..", no machine state or secrets. */
  private normalizeInner(inner: string, allowRoot: boolean): string {
    if (inner.includes("\0")) throw new ScopeError("path contains a null byte", "denied");
    if (path.win32.isAbsolute(inner) || path.posix.isAbsolute(inner)) throw new ScopeError("absolute paths are not allowed; use a path relative to the mounted folder", "outside");
    const n = path.posix.normalize(inner.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/\/+$/, "");
    if (n === ".." || n.startsWith("../")) throw new ScopeError("path escapes the mounted folder", "outside");
    if (n === "" || n === ".") {
      if (allowRoot) return "";
      throw new ScopeError("a file path is required", "denied");
    }
    const segments = n.split("/");
    if (segments.some((s) => MOUNT_DENIED_SEGMENT.test(s))) throw new ScopeError("that folder is never readable by a run", "denied");
    if (MOUNT_DENIED_NAME.test(segments[segments.length - 1] as string)) throw new ScopeError("files that look like secrets are not readable by a run", "denied");
    return n;
  }

  private async resolveMount(name: string, inner: string, kind: "file" | "dir"): Promise<{ abs: string; rel: string }> {
    const mounted = this.mountOrThrow(name);
    const n = this.normalizeInner(inner, kind === "dir");
    this.assertInsideAllowed(mounted, name, n, kind);
    let real: string;
    try {
      real = await realpath(path.resolve(mounted.root, n));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ScopeError(`"${name}:${n}" does not exist`, "missing");
      throw error;
    }
    if (!isInside(mounted.root, real)) throw new ScopeError(`"${name}:${n}" resolves outside the mounted folder`, "outside");
    const relReal = path.relative(mounted.root, real).split(path.sep).join("/");
    if (relReal.split("/").some((s) => MOUNT_DENIED_SEGMENT.test(s))) throw new ScopeError(`"${name}:${n}" resolves to a location a run may not read`, "outside");
    // a link inside an allowed folder must not lead into a folder that is not allowed
    if (!insideAllowed(mounted, relReal) && !(kind === "dir" && leadsToAllowed(mounted, relReal))) throw new ScopeError(`"${name}:${n}" resolves to a part of the mounted folder this workspace may not read`, "outside");
    const info = await stat(real);
    if (kind === "file" && !info.isFile()) throw new ScopeError(`"${name}:${n}" is not a file`, "not_file");
    if (kind === "dir" && !info.isDirectory()) throw new ScopeError(`"${name}:${n}" is not a folder`, "not_dir");
    return { abs: real, rel: `${name}:${n}` };
  }

  private assertInsideAllowed(mounted: Mounted, name: string, n: string, kind: "file" | "dir"): void {
    if (insideAllowed(mounted, n) || (kind === "dir" && leadsToAllowed(mounted, n))) return;
    throw new ScopeError(`"${name}:${n}" is not part of what this workspace may read from "${name}:" (its own client folder and the shared folders)`, "denied");
  }

  /** True for the owner's own words: workspace files outside the dropzone, and files from an owner mount. */
  isOwnerText(rel: string): boolean {
    const ref = this.mountRef(rel);
    if (ref) return this.mounts.get(ref.name)?.trust === "owner";
    return !this.isDropzone(rel);
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
    const ref = this.mountRef(rel);
    if (ref) {
      const mounted = this.mountOrThrow(ref.name);
      const n = this.normalizeInner(ref.inner, true);
      // the kind is not known without touching the disk; a folder on the way down is allowed here and checked on read
      if (n !== "" && !insideAllowed(mounted, n) && !leadsToAllowed(mounted, n)) throw new ScopeError(`"${rel}" is not part of what this workspace may read from "${ref.name}:"`, "denied");
      return;
    }
    const n = this.normalize(rel, true);
    if (n !== "" && !this.allowed(n)) throw new ScopeError(`"${rel}" is outside what a run may read`, "denied");
  }

  async readText(rel: string): Promise<ReadResult> {
    const ref = this.mountRef(rel);
    const { abs, rel: n } = ref ? await this.resolveMount(ref.name, ref.inner, "file") : await this.resolve(rel, "file");
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
    const ref = this.mountRef(rel);
    const n = ref ? "mount" : this.normalize(rel, true);
    if (n === "") return this.listTop();
    const mountScoped = ref !== null;
    const { abs, rel: resolvedRel } = ref ? await this.resolveMount(ref.name, ref.inner, "dir") : await this.resolve(n, "dir");
    const mountedHere = ref ? this.mounts.get(ref.name) : undefined;
    const innerHere = ref ? resolvedRel.slice(ref.name.length + 1) : "";
    const out: ListEntry[] = [];
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const child = innerHere === "" ? entry.name : `${innerHere}/${entry.name}`;
      if (mountedHere && !insideAllowed(mountedHere, child) && !leadsToAllowed(mountedHere, child)) continue;
      if (entry.isSymbolicLink() || (mountScoped ? MOUNT_DENIED_SEGMENT.test(entry.name) || MOUNT_DENIED_NAME.test(entry.name) : DENIED_SEGMENT.test(entry.name) || DENIED_NAME.test(entry.name))) continue;
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
    for (const [name, mounted] of this.mounts) {
      const info = await stat(mounted.root).catch(() => undefined);
      if (info?.isDirectory()) out.push({ name: `${name}:`, type: "dir", as_of: info.mtime.toISOString() });
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
