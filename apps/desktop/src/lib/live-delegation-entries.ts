import type { TranscriptEntry } from "./assistant-turns";

/** Collect replies in the running turn across steering and compaction. */
export function collectLiveDelegationEntries(
  history: readonly TranscriptEntry[],
  tail: TranscriptEntry | undefined,
  running: boolean,
): ReadonlyMap<string, true> {
  const live = new Map<string, true>();
  if (!running) return live;
  for (let index = history.length; index >= 0; index -= 1) {
    const entry = index === history.length ? tail : history[index];
    if (!entry) continue;
    if (entry.kind === "assistant-turn") {
      live.set(entry.id, true);
    } else if (entry.kind === "message") {
      const { message } = entry;
      // System notices are part of the current run and must not settle prior delegates.
      if (message.role === "system") continue;
      if (message.role === "user" && message.steering) continue;
      if (message.role === "user") break;
    }
  }
  return live;
}
