export const OMP_NATIVE_TOOL_NAMES: readonly string[];
export function normalizeOmpTaskToolsInput(input: unknown): {
  input: Record<string, unknown>;
  removed: string[];
  additionalContext: string;
} | null;
export const OMP_TASK_TOOLS_GUARD_EXTENSION: string;
