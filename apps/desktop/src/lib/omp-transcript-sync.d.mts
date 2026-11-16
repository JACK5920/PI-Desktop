import type { UiMessage } from "@pi-desktop/shared";

export function normalizeOmpTranscriptSnapshot(value: unknown): {
  ok: boolean;
  reason: string | null;
  messages: UiMessage[];
};

export function persistOmpForkTranscriptSnapshots(input: {
  parentSessionId: string;
  childSessionId: string;
  parentMessages: UiMessage[];
  childMessages: UiMessage[];
  replaceMessages: (sessionId: string, messages: UiMessage[]) => Promise<unknown>;
  complete: (parentSessionId: string, childSessionId: string) => Promise<unknown>;
}): Promise<void>;
