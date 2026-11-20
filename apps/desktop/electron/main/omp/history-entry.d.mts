export function resolveOmpNativeMessageEntryId(input: {
  messageId: string;
  messagesSnapshot: unknown;
  treeSnapshot: unknown;
  requiredRole?: "user" | "assistant";
  nativeEntryId?: string | null;
}): string | null;

export function findNewOmpNativeUserEntryId(input: {
  beforeTreeSnapshot: unknown;
  afterTreeSnapshot: unknown;
  expectedText: string;
  expectedImageCount?: number;
}): string | null;

export function describeOmpNativePromptMappingSkip(input: {
  messageId?: string;
  commandType?: "prompt" | "steer";
  streamingBehavior?: "steer" | "followUp";
  sessionBusy?: boolean;
  pendingCommandCount?: number;
  nativeState?: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    hasPendingAsyncWork?: boolean;
    isSettled?: boolean;
  } | null;
}): string | null;

export function canCaptureOmpNativePromptMapping(input: {
  messageId?: string;
  commandType?: "prompt" | "steer";
  streamingBehavior?: "steer" | "followUp";
  sessionBusy?: boolean;
  pendingCommandCount?: number;
  nativeState?: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    hasPendingAsyncWork?: boolean;
    isSettled?: boolean;
  } | null;
}): boolean;

export function lookupOmpNativeEntryIdForLegacyMessage(input: {
  messagesSnapshot: unknown;
  treeSnapshot: unknown;
  text: string;
  timestampMs?: number;
  role?: "user" | "assistant";
  maxDistanceMs?: number;
}): string | null;

export function describeOmpNativeLegacyLookup(input: {
  messagesSnapshot: unknown;
  treeSnapshot: unknown;
  text: string;
  timestampMs?: number;
  role?: "user" | "assistant";
  maxDistanceMs?: number;
}): {
  entryId: string | null;
  reason: string | null;
  messageCount: number;
  pathMessageCount: number;
};

export function findOmpNativeTreeEntry(treeSnapshot: unknown, entryId: string): Record<string, unknown> | null;
