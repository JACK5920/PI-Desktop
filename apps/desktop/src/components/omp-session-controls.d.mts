export function normalizeOmpSessionControlState(value: unknown): Record<string, unknown>;
export function flattenOmpSessionTree(value: unknown, limit?: number): {
  leafId: string | null;
  rows: Array<{ id: string; parentId: string | null; type: string; role: string | null; depth: number; active: boolean; label: string | null; summary: string }>;
  truncated: boolean;
};
export function normalizeOmpForkableMessages(value: unknown, limit?: number): Array<{ entryId: string; text: string }>;
export function ompQueueRemovalPayload(queue: "steering" | "followUp", message: string): { queue: "steering" | "followUp"; message: string };
export function ompQueuePromotionPayload(message: string): { message: string };
