export function archiveOmpTaskProgress(
  archive: { upsertAgent(sessionId: string, agent: Record<string, unknown>): Promise<unknown> },
  sessionId: string,
  frame: Record<string, any>,
): Promise<string[]>;
