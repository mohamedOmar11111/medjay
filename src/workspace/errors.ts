export const WORKSPACE_FILE = "workspace.yaml";

export interface WorkspaceIssue {
  path: string;
  message: string;
}

export class WorkspaceError extends Error {
  constructor(
    summary: string,
    readonly issues: WorkspaceIssue[] = [],
  ) {
    super(
      issues.length === 0
        ? summary
        : `${summary}\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`,
    );
    this.name = "WorkspaceError";
  }
}
