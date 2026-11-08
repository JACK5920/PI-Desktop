import { describe, expect, it } from "vitest";
import type { ModelInfo, ProviderPublic } from "@pi-desktop/shared";
import { computerModelSupportsVision } from "./computer-use-model-vision";

const provider = {
  id: "provider-1",
  name: "Fixture",
  vendorKey: "fixture",
  type: "openai_compatible",
  protocol: "openai_compatible",
  enabled: true,
  baseUrl: "http://127.0.0.1",
  authKind: "none",
  hasSecret: false,
  models: [{ id: "vision-model", contextWindow: 10_000, maxTokens: 1_000, thinkingLevels: [], defaultThinkingLevel: null }],
  supportsReasoning: false,
  supportsVision: false,
  supportedThinkingLevels: ["off"],
  defaultModelId: "text-model",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as ProviderPublic;

function model(capabilities: ModelInfo["capabilities"]): ModelInfo {
  return {
    providerId: "fixture",
    modelId: "vision-model",
    displayName: "Fixture model",
    capabilities,
    source: "discovered",
  } as ModelInfo;
}

describe("computerModelSupportsVision", () => {
  it("uses a model-specific image override before provider or catalog defaults", () => {
    expect(computerModelSupportsVision({ ...provider, models: [{ ...provider.models[0], supportsImages: false }] }, "vision-model", model(["vision"]))).toBe(false);
    expect(computerModelSupportsVision({ ...provider, models: [{ ...provider.models[0], supportsImages: true }] }, "vision-model", model([]))).toBe(true);
  });

  it("uses provider capability only for its matching default model", () => {
    expect(computerModelSupportsVision(provider, "text-model")).toBe(false);
    expect(computerModelSupportsVision(provider, "vision-model")).toBeNull();
  });

  it("falls back to the exact selected model's catalog record", () => {
    expect(computerModelSupportsVision(provider, "vision-model", model(["vision"]))).toBe(true);
    expect(computerModelSupportsVision(provider, "vision-model", model([]))).toBe(false);
    expect(computerModelSupportsVision(undefined, "vision-model", model(["vision"]))).toBeNull();
  });
});
