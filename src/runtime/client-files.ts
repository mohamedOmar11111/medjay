// Skills written for the owner's HQ repo ask for "the client's brand.md, icp.md, offers.md,
// STRATEGY.md". A workspace may keep them in different places, or not at all. This finds each one, in
// a fixed order, and says plainly which are missing so the model never invents them:
//   1. the workspace itself (context/<name>)
//   2. the client's own folder in the mount that holds client documents
//   3. Medjay's own equivalents (brand.md -> context/brand-voice.md, offers.md -> context/offer-matrix.md)
import { RunScope } from "./scope.js";

export const CLIENT_FILE_NAMES = ["brand.md", "icp.md", "offers.md", "STRATEGY.md"] as const;

export interface ClientFile {
  name: string;
  /** Path to read it with read_file, or null when no copy exists. */
  found: string | null;
  via: "workspace" | "client_folder" | "native" | null;
  /** Other files of the same kind in the client folder (for example icp-etlaala-com.md). */
  related: string[];
}

export interface ClientDocs {
  mount: string;
  folder: string;
}

const NATIVE: Record<string, string> = { "brand.md": "context/brand-voice.md", "offers.md": "context/offer-matrix.md" };

const variants = (name: string) => [...new Set([name, name.toLowerCase()])];

export async function resolveClientFiles(scope: RunScope, clientDocs: ClientDocs | undefined, names: readonly string[] = CLIENT_FILE_NAMES): Promise<ClientFile[]> {
  const out: ClientFile[] = [];
  const clientFolder = clientDocs ? `${clientDocs.mount}:${clientDocs.folder.replaceAll("\\", "/").replace(/\/+$/, "")}` : null;
  for (const name of names) {
    let found: string | null = null;
    let via: ClientFile["via"] = null;
    for (const v of variants(name)) {
      if (await scope.exists(`context/${v}`)) {
        found = `context/${v}`;
        via = "workspace";
        break;
      }
    }
    if (found === null && clientFolder) {
      for (const v of variants(name)) {
        if (await scope.exists(`${clientFolder}/${v}`)) {
          found = `${clientFolder}/${v}`;
          via = "client_folder";
          break;
        }
      }
    }
    const native = NATIVE[name];
    if (found === null && native && (await scope.exists(native))) {
      found = native;
      via = "native";
    }
    let related: string[] = [];
    if (clientFolder) {
      const stem = (name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name).toLowerCase();
      const entries = await scope.list(clientFolder).catch(() => []);
      // plain string checks: a name is text, never a pattern
      const isVariant = (file: string) => {
        const lower = file.toLowerCase();
        return lower !== name.toLowerCase() && lower.endsWith(".md") && lower.startsWith(stem) && "-_.".includes(lower.charAt(stem.length)) && lower.length > stem.length + 4;
      };
      related = entries
        .filter((e) => e.type === "file" && isVariant(e.name))
        .map((e) => `${clientFolder}/${e.name}`);
    }
    out.push({ name, found, via, related });
  }
  return out;
}
