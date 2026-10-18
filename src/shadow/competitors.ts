// Competitor snapshots: pages and ad exports that a person saved into data/imports/competitors/.
// Nothing is fetched from the web here. Only plain files directly in the folder are read (no
// symlinks, no sub-folders), each under a size cap, and the content is treated as untrusted data.
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const MAX_COMPETITOR_BYTES = 5 * 1024 * 1024;
const SUPPORTED = new Set([".html", ".htm", ".txt", ".md", ".json"]);

export interface Competitor {
  /** The file name without its extension (with it, when two files share a stem). */
  name: string;
  file: string;
  text: string;
  /** When the file was last written: the date the snapshot is current as of. */
  asOf: string;
}

export interface Skipped {
  file: string;
  reason: string;
}

export async function loadCompetitors(folder: string): Promise<{ competitors: Competitor[]; skipped: Skipped[] }> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { competitors: [], skipped: [] };
    throw error;
  }
  const competitors: Competitor[] = [];
  const skipped: Skipped[] = [];
  const stems = new Map<string, number>();
  for (const n of names) stems.set(n.slice(0, n.length - extname(n).length), (stems.get(n.slice(0, n.length - extname(n).length)) ?? 0) + 1);

  for (const file of names.sort()) {
    const info = await lstat(join(folder, file));
    if (info.isDirectory()) continue;
    if (info.isSymbolicLink()) {
      skipped.push({ file, reason: "symbolic link" });
      continue;
    }
    const ext = extname(file).toLowerCase();
    if (!SUPPORTED.has(ext)) {
      skipped.push({ file, reason: "unsupported type" });
      continue;
    }
    if (info.size > MAX_COMPETITOR_BYTES) {
      skipped.push({ file, reason: "larger than 5 MB" });
      continue;
    }
    const stem = file.slice(0, file.length - ext.length);
    competitors.push({ name: (stems.get(stem) ?? 0) > 1 ? file : stem, file, text: await readFile(join(folder, file), "utf8"), asOf: info.mtime.toISOString() });
  }
  return { competitors, skipped };
}
