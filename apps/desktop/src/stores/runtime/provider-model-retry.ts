export type ProviderModelRetryState = {
  attempts: number;
  retryAt: number;
};

export const PROVIDER_MODEL_RETRY_INITIAL_DELAY_MS = 1_000;
export const PROVIDER_MODEL_RETRY_MAX_DELAY_MS = 30_000;

export function canRetryProviderModels(
  state: ProviderModelRetryState | undefined,
  now = Date.now(),
): boolean {
  return !state || now >= state.retryAt;
}

export function nextProviderModelRetryState(
  previous: ProviderModelRetryState | undefined,
  now = Date.now(),
): ProviderModelRetryState {
  const attempts = Math.min(10, (previous?.attempts ?? 0) + 1);
  const delay = Math.min(
    PROVIDER_MODEL_RETRY_MAX_DELAY_MS,
    PROVIDER_MODEL_RETRY_INITIAL_DELAY_MS * 2 ** (attempts - 1),
  );
  return { attempts, retryAt: now + delay };
}
