import type { AppSettings } from "@pi-desktop/shared";

const pauseRequests = new Set<string>();

export const PAUSED_TASK_CONTINUATION_PROMPT =
  "Continue the paused task from the latest completed state. Inspect the recorded conversation and tool results first. Do not repeat actions whose outcomes are already recorded; if an action's result is uncertain, ask the user before retrying it.";

export function requestTaskPause(sessionId: string): void {
  pauseRequests.add(sessionId);
}

export function cancelTaskPauseRequest(sessionId: string): void {
  pauseRequests.delete(sessionId);
}

export function consumeTaskPauseRequest(sessionId: string): boolean {
  const requested = pauseRequests.delete(sessionId);
  return requested;
}

export function withPausedTask(
  settings: AppSettings,
  sessionId: string,
): AppSettings {
  const pausedTaskSessionIds = [...new Set([...(settings.pausedTaskSessionIds ?? []), sessionId])];
  return { ...settings, pausedTaskSessionIds };
}

export function withoutPausedTask(
  settings: AppSettings,
  sessionId: string,
): AppSettings {
  return {
    ...settings,
    pausedTaskSessionIds: (settings.pausedTaskSessionIds ?? []).filter((id) => id !== sessionId),
  };
}
