// The words that identify a workspace, gathered for the leak check: names from workspace.yaml, the
// brand-voice.md frontmatter and first heading, and the campaign and ad set names in the ingested data.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const BRAND_KEYS = ["workspace", "brand", "brand_name", "client", "name", "company", "business"];
const GENERIC = new Set(["brand", "voice", "tone", "guidelines", "guide", "style"]);

export async function brandWords(workspaceDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(workspaceDir, "context", "brand-voice.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  if (front) {
    try {
      const data = parseYaml(front[1] as string) as Record<string, unknown> | null;
      for (const key of BRAND_KEYS) if (typeof data?.[key] === "string") out.push(data[key] as string);
    } catch {
      // unreadable frontmatter contributes nothing; the heading below still does
    }
  }
  const heading = /^#\s+(.+)$/m.exec(text)?.[1];
  if (heading) out.push(heading.split(/\s+/).filter((w) => !GENERIC.has(w.toLowerCase())).join(" "));
  return out.filter(Boolean);
}
