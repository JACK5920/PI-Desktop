import { describe, expect, it } from "vitest";
import {
  canRetryProviderModels,
  nextProviderModelRetryState,
  PROVIDER_MODEL_RETRY_MAX_DELAY_MS,
} from "./provider-model-retry";

describe("provider model refresh backoff", () => {
  it("allows the first request and backs off repeated failures exponentially", () => {
    expect(canRetryProviderModels(undefined, 0)).toBe(true);

    const first = nextProviderModelRetryState(undefined, 100);
    expect(first).toEqual({ attempts: 1, retryAt: 1_100 });
    expect(canRetryProviderModels(first, 1_099)).toBe(false);
    expect(canRetryProviderModels(first, 1_100)).toBe(true);

    const second = nextProviderModelRetryState(first, 1_100);
    expect(second).toEqual({ attempts: 2, retryAt: 3_100 });
    const capped = Array.from({ length: 10 }).reduce<ReturnType<typeof nextProviderModelRetryState>>(
      (state) => nextProviderModelRetryState(state, 5_000),
      second,
    );
    expect(capped.retryAt).toBe(5_000 + PROVIDER_MODEL_RETRY_MAX_DELAY_MS);
  });

  it("can be reset after a successful refresh", () => {
    const failed = nextProviderModelRetryState(undefined, 10);
    // CatalogRuntime deletes this state on success; absence allows immediate refresh.
    expect(canRetryProviderModels(undefined, 10)).toBe(true);
    expect(canRetryProviderModels(failed, 10)).toBe(false);
  });
});
