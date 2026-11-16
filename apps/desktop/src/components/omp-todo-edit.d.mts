export function normalizeEditableOmpTodos(phases: unknown): Array<Record<string, unknown> & { name: string; tasks: Array<Record<string, unknown> & { content: string; status: string }> }> | null;
export function updateEditableOmpTodoTask(phases: unknown, phaseIndex: number, taskIndex: number, patch: { content?: string; status?: string; details?: string; notes?: string | string[] }): Array<Record<string, unknown> & { name: string; tasks: Array<Record<string, unknown> & { content: string; status: string }> }>;
export function sameOmpTodoCore(left: unknown, right: unknown): boolean;
export function activeOmpTreeEntries(tree: unknown, leafId: unknown): Record<string, unknown>[];
export function mergeOmpTodoMetadata(phases: unknown, tree: unknown, leafId: unknown): Array<Record<string, unknown>> | null;
export function hasOmpTodoSnapshot(tree: unknown, leafId: unknown, phases: unknown): boolean;
