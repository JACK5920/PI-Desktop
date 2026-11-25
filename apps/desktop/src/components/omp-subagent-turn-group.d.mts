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
    status: "running" | "waiting" | "retrying" | "completed" | "timed_out" | "aborted" | "stopped" | "failed" | "denied" | "unknown";
    statusKey: string;
  }>;
  runningCount: number;
  waitingCount: number;
  retryingCount: number;
  completedCount: number;
  failedCount: number;
  abortedCount: number;
  unknownCount: number;
  unconfirmedCount: number;
};
export function isOmpSubagentTurnBatchItem(item: { message: Record<string, any> }): boolean;
