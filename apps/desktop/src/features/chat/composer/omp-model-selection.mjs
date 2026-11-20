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

/**
 * Add settings-owned display names to OMP models without changing their native
 * provider/model identity. Missing settings metadata leaves the RPC model intact.
 */
export function mapOmpProviderDisplayNames(models, customProviders) {
  const names = new Map();
  for (const provider of customProviders ?? []) {
    if (typeof provider?.providerId !== "string" || typeof provider?.providerName !== "string") continue;
    const providerId = provider.providerId.trim();
    const providerName = provider.providerName.trim();
    if (providerId && providerName) names.set(providerId, providerName);
  }

  return models.map((model) => {
    const providerName = names.get(model.provider);
    return providerName ? { ...model, providerName } : model;
  });
}

export function ompProviderDisplayName(model) {
  return typeof model.providerName === "string" && model.providerName.trim()
    ? model.providerName.trim()
    : model.provider;
}

export function filterOmpModelsBySearch(models, query) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;
  return models.filter((model) => [model.name, model.providerName, model.provider, model.id]
    .some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(normalized)));
}

/** Group for UI labels while retaining the native provider ID as stable identity. */
export function groupOmpModelsByProvider(models) {
  const groups = new Map();
  for (const model of models) {
    const group = groups.get(model.provider) ?? [];
    group.push(model);
    groups.set(model.provider, group);
  }
  return [...groups.entries()].map(([provider, groupedModels]) => ({
    provider,
    displayName: groupedModels[0] ? ompProviderDisplayName(groupedModels[0]) : provider,
    models: groupedModels,
  }));
}

/** The provider string sent to OMP is always its native ID, never its label. */
export function toOmpRpcModelIdentity(model) {
  return { provider: model.provider, modelId: model.id };
}
