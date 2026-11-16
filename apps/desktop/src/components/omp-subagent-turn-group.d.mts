export function buildOmpSubagentTurnGroup(
  items: Array<{ message: Record<string, any> }>,
  roster: Array<Record<string, any>>,
): {
  batches: Array<{ message: Record<string, any> }>;
  toolCallIds: string[];
  requestedCount: number;
  agents: Array<{
    agent: Record<string, any> & { id: string };
    toolCallId: string;
    status: "running" | "completed" | "timed_out" | "aborted" | "stopped" | "failed" | "denied" | "unknown";
    statusKey: string;
  }>;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  unknownCount: number;
};
export function isOmpSubagentTurnBatchItem(item: { message: Record<string, any> }): boolean;
