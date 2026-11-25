const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
  role,
  thinkingLevel,
  onModelApplied,
  onThinkingLevels,
  onThinkingLevelsError,
}) {
  await rpcCommand({
    sessionId,
    command: "set_model",
    fields: {
      provider,
      modelId,
      ...(typeof role === "string" && role ? { role } : {}),
      ...(typeof thinkingLevel === "string" && thinkingLevel ? { thinkingLevel } : {}),
    },
  });
  onModelApplied?.();

  try {
    return await readOmpThinkingLevels({ rpcCommand, sessionId, onThinkingLevels });
  } catch (error) {
    // The model switch is already committed by OMP. A follow-up capability
    // lookup failure must not be reported as if the selected model was
    // rejected, and the old model's reasoning options must not remain visible.
    onThinkingLevels?.([]);
    onThinkingLevelsError?.(error);
    return [];
  }
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

/** Accept only model-picker rows with a usable native identity; newer OMP rows
 * may carry a quick role and role-specific effort that must survive selection. */
export function normalizeOmpModelPickerRows(value) {
  const data = asRecord(value?.data) ?? asRecord(value);
  if (!Array.isArray(data?.rows)) return [];
  return data.rows.flatMap((value) => {
    const row = asRecord(value);
    if (typeof row?.provider !== "string" || typeof row.id !== "string" || !row.provider || !row.id) return [];
    const normalized = {
      provider: row.provider,
      id: row.id,
      name: typeof row.name === "string" ? row.name : row.id,
      ...(typeof row.role === "string" && row.role ? { role: row.role } : {}),
      ...(typeof row.thinkingLevel === "string" && THINKING_LEVELS.has(row.thinkingLevel) ? { thinkingLevel: row.thinkingLevel } : {}),
      ...(row.current === true ? { current: true } : {}),
      ...(Array.isArray(row.roles) ? { roles: row.roles.filter((role) => asRecord(role) && typeof role.role === "string") } : {}),
      ...(Array.isArray(row.thinking) ? { thinking: row.thinking.filter((level) => typeof level === "string" && THINKING_LEVELS.has(level)) } : {}),
    };
    return [normalized];
  });
}

/** The provider string sent to OMP is always its native ID, never its label. */
export function toOmpRpcModelIdentity(model) {
  return { provider: model.provider, modelId: model.id };
}
