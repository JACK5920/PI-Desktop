import type { GoalLifecycle } from "@pi-desktop/shared";

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
