import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../workspace/init.js";
import { createDraftChecker } from "./checker.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-checker-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
  await writeFile(join(dir, "context", "brand-voice.md"), "---\nworkspace: ws\nlanguages: []\ndialects: []\nforbidden_phrases:\n  - guaranteed visa\n---\n# Brand voice\n", "utf8");
  await writeFile(
    join(dir, "context", "claims.md"),
    "---\nclaims:\n  - id: CLM-001\n    values: ['15 years']\n    text: Operating for 15 years\n    source: licence 2011\n    date: 2026-01-01\n    status: verified\n---\n# Claims\n",
    "utf8",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createDraftChecker", () => {
  it("fails copy that uses a forbidden phrase and names the rule, not the text", async () => {
    const check = await createDraftChecker(dir);
    const r = check("We offer a guaranteed visa for every family.", "email");
    expect(r.status).toBe("fail");
    expect(r.errors).toBeGreaterThan(0);
    expect(r.rules.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain("guaranteed visa");
  });

  it("fails a number that is not in the verified claims, and accepts one that is", async () => {
    const check = await createDraftChecker(dir);
    expect(check("Packages from SAR 4,200 only.", "ad").status).toBe("fail");
    expect(check("Operating for 15 years.", "ad").status).toBe("pass");
  });

  it("passes plain copy, and checks every customer-facing kind", async () => {
    const check = await createDraftChecker(dir);
    for (const kind of ["ad", "email", "post", "landing_page"] as const) expect(check("Tell us your dates and we will send a quote.", kind).status).toBe("pass");
  });

  it("caps the rule list so a very bad draft does not make a huge record", async () => {
    const check = await createDraftChecker(dir);
    const r = check("guaranteed visa. ".repeat(200), "post");
    expect(r.rules.length).toBeLessThanOrEqual(20);
  });
});
