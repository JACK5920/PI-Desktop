const PI_HISTORY_CAPABILITIES = Object.freeze({
  canEditUserMessage: true,
  canEditUserMessageInNativeBranch: false,
  canDeleteMessage: true,
  canRetryPrompt: true,
  canRetryPromptInNativeBranch: false,
  canRegenerateAssistant: true,
  canRegenerateAssistantInNativeBranch: false,
  canUseRevisions: true,
  canCreateGenericFork: true,
  canUseNativeSessionTree: false,
});

const OMP_HISTORY_CAPABILITIES = Object.freeze({
  // OMP owns its canonical message tree. Host-side edits, deletion, retries,
  // or revision activation would change only PI's mirror and split history.
  canEditUserMessage: false,
  canEditUserMessageInNativeBranch: true,
  canDeleteMessage: false,
  canRetryPrompt: false,
  canRetryPromptInNativeBranch: true,
  canRegenerateAssistant: false,
  canRegenerateAssistantInNativeBranch: true,
  canUseRevisions: false,
  canCreateGenericFork: false,
  canUseNativeSessionTree: true,
});

/**
 * Keep transcript controls aligned with the owning engine. Unknown/legacy
 * sessions retain PI behavior; only an explicitly OMP-owned session gets the
 * stricter native-history boundary.
 */
export function getTranscriptHistoryCapabilities(engineId) {
  return engineId === "omp" ? OMP_HISTORY_CAPABILITIES : PI_HISTORY_CAPABILITIES;
}
