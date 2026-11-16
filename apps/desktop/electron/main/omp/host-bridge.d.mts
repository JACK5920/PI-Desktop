export function normalizeOmpWorkspacePath(value: unknown): string;
export function workspacePathFromOmpUri(value: unknown): string;
export function normalizeOmpHostToolRequest(toolName: unknown, args: unknown): {
  toolName: "Read" | "Write" | "Edit";
  args: Record<string, unknown>;
};
export const OMP_WORKSPACE_FILE_LIMIT: number;
