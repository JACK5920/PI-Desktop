const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function asRecord(value) {
  return value !== null && typeof value === "object" ? value : null;
}

/**
 * Apply an OMP model before reading its thinking capabilities. The callbacks
 * let the picker invalidate stale model-specific UI as soon as the engine has
 * accepted the switch, then publish only the newly reported capability list.
 */
export async function selectOmpModelAndRefreshThinkingLevels({
  rpcCommand,
  sessionId,
  provider,
  modelId,
  onModelApplied,
  onThinkingLevels,
}) {
  await rpcCommand({ sessionId, command: "set_model", fields: { provider, modelId } });
  onModelApplied?.();

  return readOmpThinkingLevels({ rpcCommand, sessionId, onThinkingLevels });
}

export async function readOmpThinkingLevels({ rpcCommand, sessionId, onThinkingLevels }) {
  const result = asRecord(await rpcCommand({ sessionId, command: "get_available_thinking_levels" }));
  const data = asRecord(result?.data);
  const reported = data?.levels;
  const levels = Array.isArray(reported)
    ? reported.filter((level) => typeof level === "string" && THINKING_LEVELS.has(level))
    : [];

  onThinkingLevels?.(levels);
  return levels;
}
