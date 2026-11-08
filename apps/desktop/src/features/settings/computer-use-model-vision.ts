import { modelMatchesFilter, type ModelInfo, type ProviderPublic } from "@pi-desktop/shared";

/** Resolve image input from an explicit per-model override before catalog metadata. */
export function computerModelSupportsVision(
  provider: ProviderPublic | undefined,
  modelId: string | undefined,
  info?: ModelInfo | null,
): boolean | null {
  if (!provider || !modelId) return null;
  const binding = provider.models.find((model) => model.id === modelId);
  if (typeof binding?.supportsImages === "boolean") return binding.supportsImages;
  if (provider.defaultModelId === modelId && typeof provider.supportsVision === "boolean") {
    return provider.supportsVision;
  }
  return info ? modelMatchesFilter(info, "vision") : null;
}
