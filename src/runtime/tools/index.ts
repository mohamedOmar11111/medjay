import type { Policy } from "../../shield/policy.js";
import type { SlopOptions } from "../../style/slop.js";
import type { ToolDef } from "../registry.js";
import { lintCopyTool } from "./lint-copy.js";
import { listFilesTool } from "./list-files.js";
import { proposePlanActionsTool } from "./propose-actions.js";
import { readFileTool } from "./read-file.js";

export interface BuiltinServices {
  policy: Policy;
  style: Omit<SlopOptions, "kind">;
}

/** The built-in tools. Read, draft and propose only: none of them can change a platform or a file. */
export function createBuiltinTools(services: BuiltinServices): ToolDef[] {
  return [readFileTool, listFilesTool, lintCopyTool(services.style), proposePlanActionsTool(services.policy)] as unknown as ToolDef[];
}
