import type { ComputerGrantView, ComputerRunActivity } from "@pi-desktop/shared";

export type ActiveComputerUseRun = {
  grant: ComputerGrantView;
  sessionId: string;
  toolCallId: string;
};

let activeRun: ActiveComputerUseRun | null = null;
const listeners = new Set<(grant: ComputerGrantView | null) => void>();
let activeActivity: ComputerRunActivity | null = null;
const activityListeners = new Set<(activity: ComputerRunActivity | null) => void>();

const MAX_ACTIVITY_TEXT_LENGTH = 80;
const MAX_RECENT_ACTIVITY_STEPS = 3;

function safeActivityText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_ACTIVITY_TEXT_LENGTH) : undefined;
}

function notifyActivity(): void {
  for (const listener of activityListeners) listener(activeActivity);
}

export function getActiveComputerUseRun(): ActiveComputerUseRun | null {
  return activeRun;
}

export function publishComputerUseRun(next: ActiveComputerUseRun | null): void {
  const resetActivity = !next || activeRun?.grant.grantId !== next.grant.grantId;
  activeRun = next;
  for (const listener of listeners) listener(next?.grant ?? null);
  if (resetActivity) {
    activeActivity = null;
    notifyActivity();
  }
}

export function subscribeComputerUseRun(listener: (grant: ComputerGrantView | null) => void): () => void {
  listeners.add(listener);
  listener(activeRun?.grant ?? null);
  return () => listeners.delete(listener);
}

export function getActiveComputerUseActivity(): ComputerRunActivity | null {
  return activeActivity;
}

/** Activity is ephemeral UI state, bound to the one grant currently owned by Main. */
export function publishComputerUseActivity(next: ComputerRunActivity): void {
  if (!activeRun || activeRun.grant.grantId !== next.grantId) return;
  const recentSteps = next.recentSteps
    .slice(-MAX_RECENT_ACTIVITY_STEPS)
    .map((step) => ({
      index: step.index,
      action: step.action,
      ok: step.ok,
      ...(step.ok && safeActivityText(step.target) ? { target: safeActivityText(step.target) } : {}),
      ...(step.errorCode?.startsWith("COMPUTER_") ? { errorCode: step.errorCode.slice(0, 64) } : {}),
    }));
  activeActivity = {
    grantId: next.grantId,
    phase: next.phase,
    recentSteps,
    ...(typeof next.stepIndex === "number" && Number.isSafeInteger(next.stepIndex) ? { stepIndex: next.stepIndex } : {}),
    ...(next.action ? { action: next.action } : {}),
    ...(safeActivityText(next.target) ? { target: safeActivityText(next.target) } : {}),
    ...(next.errorCode?.startsWith("COMPUTER_") ? { errorCode: next.errorCode.slice(0, 64) } : {}),
  };
  notifyActivity();
}

export function subscribeComputerUseActivity(listener: (activity: ComputerRunActivity | null) => void): () => void {
  activityListeners.add(listener);
  listener(activeActivity);
  return () => activityListeners.delete(listener);
}
