import type { GoalLifecycle, GoalProgressEvent } from "@pi-desktop/shared";

function timestamp(value: GoalLifecycle): number {
  const parsed = Date.parse(value.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ignore an out-of-order Host snapshot/event without losing a newer lifecycle. */
export function newerGoalLifecycle(
  current: GoalLifecycle | undefined,
  incoming: GoalLifecycle,
): GoalLifecycle {
  if (!current) return incoming;
  if (current.proposalId === incoming.proposalId) {
    if (current.version > incoming.version) return current;
    if (current.version === incoming.version && timestamp(current) > timestamp(incoming)) {
      return current;
    }
    return incoming;
  }
  return timestamp(current) > timestamp(incoming) ? current : incoming;
}

/** Merge a startup snapshot with live changes received while bootstrap was in flight. */
export function mergeGoalLifecycleSnapshots(
  snapshot: Record<string, GoalLifecycle>,
  live: Record<string, GoalLifecycle>,
): Record<string, GoalLifecycle> {
  const merged = { ...snapshot };
  for (const [sessionId, lifecycle] of Object.entries(live)) {
    merged[sessionId] = newerGoalLifecycle(merged[sessionId], lifecycle);
  }
  return merged;
}

export function goalProgressMatches(
  goal: GoalLifecycle | undefined,
  progress: GoalProgressEvent | undefined,
): progress is GoalProgressEvent {
  return Boolean(
    goal &&
      progress &&
      goal.status === "active" &&
      goal.sessionId === progress.sessionId &&
      goal.proposalId === progress.proposalId &&
      goal.currentExecutionId === progress.executionId,
  );
}

/** Keep only monotonic, current-execution progress for one lifecycle. */
export function mergeGoalProgress(
  goal: GoalLifecycle | undefined,
  current: GoalProgressEvent | undefined,
  incoming: GoalProgressEvent,
): GoalProgressEvent | undefined {
  if (!goalProgressMatches(goal, incoming)) {
    return goalProgressMatches(goal, current) ? current : undefined;
  }
  if (
    goalProgressMatches(goal, current) &&
    current.tokensUsed >= incoming.tokensUsed
  ) {
    return current;
  }
  return incoming;
}

export function goalTokensUsed(
  goal: GoalLifecycle,
  progress: GoalProgressEvent | undefined,
): number {
  return goalProgressMatches(goal, progress)
    ? Math.max(goal.tokensUsed, progress.tokensUsed)
    : goal.tokensUsed;
}

/** Drop progress overlays when a session no longer owns their execution. */
export function retainMatchingGoalProgress(
  lifecycles: Record<string, GoalLifecycle>,
  progressBySession: Record<string, GoalProgressEvent>,
): Record<string, GoalProgressEvent> {
  return Object.fromEntries(
    Object.entries(progressBySession).filter(([sessionId, progress]) =>
      goalProgressMatches(lifecycles[sessionId], progress),
    ),
  );
}

/** Active cycles use their start timestamp; stopped lifecycles stay frozen. */
export function goalElapsedMs(goal: GoalLifecycle, nowMs: number): number {
  if (
    goal.status !== "active" ||
    typeof goal.cycleStartedAt !== "number" ||
    !Number.isFinite(goal.cycleStartedAt) ||
    !Number.isFinite(nowMs)
  ) {
    return goal.elapsedMs;
  }
  return Math.max(goal.elapsedMs, Math.max(0, Math.floor(nowMs - goal.cycleStartedAt)));
}

/** Format elapsed duration through seconds using the active UI locale. */
export function formatGoalElapsed(durationMs: number, locale: string): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const formatUnit = (value: number, unit: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(value);

  const parts: string[] = [];
  if (hours > 0) parts.push(formatUnit(hours, "hour"));
  if (minutes > 0 || hours > 0) parts.push(formatUnit(minutes, "minute"));
  parts.push(formatUnit(seconds, "second"));
  return parts.join(" ");
}
