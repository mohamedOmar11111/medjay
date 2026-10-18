// Workspace style context, read from plain files:
//   context/brand-voice.md   frontmatter: forbidden_phrases: [ "phrase" | { phrase, suggestion } ]
//   context/claims.md        frontmatter: claims: [ { id, values, text, source, date, status } ]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ClaimRegisterSchema, type ClaimRegister } from "./claims.js";
import type { BannedPhrase } from "./slop.js";

export class StyleContextError extends Error {
  constructor(
    summary: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(issues.length === 0 ? summary : `${summary}\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "StyleContextError";
  }
}

export interface StyleContext {
  forbiddenPhrases: BannedPhrase[];
  /** undefined: no register (number checks are skipped). An empty register means every number needs a claim. */
  claims: ClaimRegister | undefined;
}

const Forbidden = z.array(
  z.union([
    z.string().min(1).transform((phrase): BannedPhrase => ({ phrase })),
    z.object({ phrase: z.string().min(1), suggestion: z.string().min(1).optional() }).strict().transform((p): BannedPhrase => (p.suggestion ? { phrase: p.phrase, suggestion: p.suggestion } : { phrase: p.phrase })),
  ]),
);

const formatPath = (path: PropertyKey[]) => path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");

async function frontmatter(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  try {
    const parsed: unknown = parseYaml(match[1] as string, { uniqueKeys: true });
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    throw new StyleContextError(`${file} has invalid frontmatter`, [{ path: "", message: error instanceof Error ? (error.message.split("\n")[0] ?? "parse error") : "parse error" }]);
  }
}

export async function loadStyleContext(dir: string): Promise<StyleContext> {
  const brand = await frontmatter(join(dir, "context", "brand-voice.md"));
  const claimsFile = await frontmatter(join(dir, "context", "claims.md"));

  let forbiddenPhrases: BannedPhrase[] = [];
  if (brand && brand.forbidden_phrases !== undefined) {
    const parsed = Forbidden.safeParse(brand.forbidden_phrases);
    if (!parsed.success) {
      throw new StyleContextError(
        "context/brand-voice.md: forbidden_phrases is invalid",
        parsed.error.issues.map((i) => ({ path: `forbidden_phrases${formatPath(i.path)}`, message: i.message })),
      );
    }
    forbiddenPhrases = parsed.data;
  }

  let claims: ClaimRegister | undefined;
  if (claimsFile && claimsFile.claims !== undefined) {
    const parsed = ClaimRegisterSchema.safeParse({ claims: claimsFile.claims });
    if (!parsed.success) {
      throw new StyleContextError(
        "context/claims.md: the claim register is invalid",
        parsed.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
      );
    }
    claims = parsed.data;
  }
  return { forbiddenPhrases, claims };
}
