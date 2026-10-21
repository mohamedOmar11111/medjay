import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../../workspace/init.js";
import type { GrowthPort } from "../tools/growth.js";
import { NO_MODEL, openRun } from "./open.js";

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "medjay-open-"));
  dir = join(root, "ws");
  await initWorkspace({ dir, id: "ws", businessType: "agency" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const port: GrowthPort = {
  dataId: async () => "x",
  scout: async () => ({}),
  diagnose: async () => ({}),
  context: async () => ({}),
  simulate: async () => ({}),
};

describe("openRun tool set", () => {
  it("has the four built-in tools by default", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    opened.close();
  });

  it("adds the growth tools when a growth port is given", async () => {
    const opened = await openRun({ dir, slot: "reasoning", driver: NO_MODEL, growth: port });
    expect(opened.deps.registry.specs().map((s) => s.name)).toEqual(["growth_context", "growth_diagnose", "growth_scout", "growth_simulate", "lint_copy", "list_files", "propose_plan_actions", "read_file"]);
    opened.close();
  });
});
