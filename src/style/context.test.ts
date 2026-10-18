import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStyleContext, StyleContextError } from "./context.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "medjay-style-"));
  await mkdir(join(dir, "context"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => writeFile(join(dir, "context", name), text, "utf8");

describe("loadStyleContext", () => {
  it("returns empty context when the files are missing", async () => {
    expect(await loadStyleContext(dir)).toEqual({ forbiddenPhrases: [], claims: undefined });
  });

  it("reads forbidden phrases from brand-voice.md frontmatter", async () => {
    await write("brand-voice.md", '---\nforbidden_phrases:\n  - "premium experience"\n  - { phrase: "once in a lifetime", suggestion: "give the date" }\n---\n# Voice\n');
    const ctx = await loadStyleContext(dir);
    expect(ctx.forbiddenPhrases).toEqual([{ phrase: "premium experience" }, { phrase: "once in a lifetime", suggestion: "give the date" }]);
  });

  it("reads the claims register from claims.md frontmatter", async () => {
    await write(
      "claims.md",
      "---\nclaims:\n  - id: CLM-001\n    values: ['+31%']\n    text: Lift in qualified chats\n    source: EXP-088\n    date: 2026-10-01\n    status: verified\n---\n# Claims\n",
    );
    const ctx = await loadStyleContext(dir);
    expect(ctx.claims?.claims[0]).toMatchObject({ id: "CLM-001", status: "verified", values: ["+31%"] });
  });

  it("treats an empty claims list as a register that exists (so every number needs a claim)", async () => {
    await write("claims.md", "---\nclaims: []\n---\n# Claims\n");
    expect((await loadStyleContext(dir)).claims).toEqual({ claims: [] });
  });

  it("explains problems with their path", async () => {
    await write("claims.md", "---\nclaims:\n  - id: nope\n    values: []\n    text: x\n    source: ''\n    date: yesterday\n    status: maybe\n---\n");
    const error = (await loadStyleContext(dir).catch((e) => e)) as StyleContextError;
    expect(error).toBeInstanceOf(StyleContextError);
    expect(error.issues.map((i) => i.path).join(" ")).toMatch(/claims\[0\]/);
    await write("claims.md", "---\nclaims: []\n---\n");
    await write("brand-voice.md", "---\nforbidden_phrases: 5\n---\n");
    await expect(loadStyleContext(dir)).rejects.toBeInstanceOf(StyleContextError);
  });

  it("rejects frontmatter that is not valid YAML, and ignores files without frontmatter", async () => {
    await write("claims.md", "---\nclaims: [unclosed\n---\n");
    await expect(loadStyleContext(dir)).rejects.toBeInstanceOf(StyleContextError);
    await write("claims.md", "# just prose, no frontmatter\n");
    expect((await loadStyleContext(dir)).claims).toBeUndefined();
  });
});
