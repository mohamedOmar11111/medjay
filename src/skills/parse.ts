// Reads one SKILL.md: YAML frontmatter between `---` lines, then the body. Tolerant on purpose: the
// owner's skills come from several tools, so unknown keys are kept and problems are reported, not thrown.
import { parse as parseYaml } from "yaml";

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  problems: string[];
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const MAX_DESCRIPTION = 400;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function parseSkill(raw: string, fallbackName: string): ParsedSkill {
  const text = raw.replace(/^﻿/, "");
  const problems: string[] = [];
  let frontmatter: Record<string, unknown> = {};
  let body = text;
  const match = FRONT.exec(text);
  if (match) {
    body = match[2] as string;
    try {
      const parsed = parseYaml(match[1] as string) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
    } catch (error) {
      problems.push(`frontmatter is not valid YAML: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`);
    }
  } else {
    problems.push("no frontmatter block (--- lines) at the top");
  }

  let name = fallbackName;
  if (typeof frontmatter.name === "string" && NAME.test(frontmatter.name.trim())) name = frontmatter.name.trim();
  else if (match) problems.push(`name is missing or not a plain identifier; using the folder name "${fallbackName}"`);

  let description = typeof frontmatter.description === "string" ? oneLine(frontmatter.description) : "";
  if (description === "") {
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#"));
    if (match) problems.push("description is missing");
    description = firstLine ? oneLine(firstLine) : "";
  }
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  return { name, description, body, frontmatter, problems };
}
