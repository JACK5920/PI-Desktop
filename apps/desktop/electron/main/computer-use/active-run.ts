import type { ComputerGrantView } from "@pi-desktop/shared";

export type ActiveComputerUseRun = {
  grant: ComputerGrantView;
  sessionId: string;
  toolCallId: string;
};

let activeRun: ActiveComputerUseRun | null = null;
const listeners = new Set<(grant: ComputerGrantView | null) => void>();

export function getActiveComputerUseRun(): ActiveComputerUseRun | null {
  return activeRun;
}

export function publishComputerUseRun(next: ActiveComputerUseRun | null): void {
  activeRun = next;
  for (const listener of listeners) listener(next?.grant ?? null);
}

export function subscribeComputerUseRun(listener: (grant: ComputerGrantView | null) => void): () => void {
  listeners.add(listener);
  listener(activeRun?.grant ?? null);
  return () => listeners.delete(listener);
}
