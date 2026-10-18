import { z } from "zod";
import { defineTool } from "../registry.js";

export const listFilesTool = defineTool({
  name: "list_files",
  description:
    "List what a run may read in this client's workspace. With no dir, lists the readable top level. Returns names, types, sizes and the date each file is current as of.",
  class: "read",
  input: z.object({ dir: z.string().max(300).default("").describe("folder relative to the workspace; empty for the top level") }).strict(),
  paths: ({ dir }) => [dir],
  execute: async ({ dir }, ctx) => ({ dir, entries: await ctx.scope.list(dir) }),
  // File names in the dropzone come from outside and can carry text.
  trustOf: ({ dir }, _output, ctx) => (ctx.scope.isDropzone(dir) ? "untrusted" : "trusted"),
});
