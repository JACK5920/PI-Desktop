export interface TranscriptHistoryCapabilities {
  canEditUserMessage: boolean;
  canEditUserMessageInNativeBranch: boolean;
  canDeleteMessage: boolean;
  canRetryPrompt: boolean;
  canRetryPromptInNativeBranch: boolean;
  canRegenerateAssistant: boolean;
  canRegenerateAssistantInNativeBranch: boolean;
  canUseRevisions: boolean;
  canCreateGenericFork: boolean;
  canUseNativeSessionTree: boolean;
}

export function getTranscriptHistoryCapabilities(
  engineId: string | null | undefined,
): TranscriptHistoryCapabilities;
