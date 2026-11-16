import type { ComputerInspection } from "@pi-desktop/shared";

/**
 * Bounded re-read budget for the observation taken after a dispatched action.
 *
 * Fewer attempts than host-core's write confirmation (cua.rs
 * WRITE_CONFIRM_ATTEMPTS): confirming a write re-reads one row, while an
 * observation is a full accessibility walk, so each extra attempt costs far
 * more. Three attempts cover the render lag measured on a Chromium composer
 * without making a genuine no-op action expensive.
 */
export const POST_ACTION_SETTLE_ATTEMPTS = 3;
export const POST_ACTION_SETTLE_INTERVAL_MS = 120;

/**
 * Compare only the safe accessibility shape; values and captured pixels never
 * enter this signature.
 *
 * `identity`, never `uid`: the cua backend re-mints uid from a fresh snapshot on
 * every read, so including it would make two reads of an untouched window differ
 * every time. `bounds` and `parent` are omitted on purpose: the cua backend
 * reports bounds as absent, and `parent` is an array index that shifts whenever
 * a node is inserted, which would report "changed" for an unrelated edit.
 */
export function inspectionSignature(inspection: ComputerInspection): string {
  return JSON.stringify({
    bounds: inspection.bounds,
    fidelity: inspection.fidelity,
    truncated: inspection.truncated,
    secureInput: inspection.secureInput,
    nodes: inspection.nodes.map((node) => ({
      identity: node.identity ?? node.uid,
      role: node.role,
      label: node.label,
      hasValue: node.hasValue,
      enabled: node.enabled,
      focused: node.focused,
      actions: node.actions,
    })),
  });
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the post-action observation, re-reading while the tree is byte-for-byte
 * the same shape as before the action.
 *
 * Why: an action reaches the application through the input queue and the
 * accessibility tree is updated a moment later. Measured on a Chromium
 * composer, the first read after clicking Send still showed the typed text and
 * the Send button, so the caller received a pre-render snapshot and concluded
 * the send had failed when it had succeeded. The same race made
 * `observed-no-change` a false negative for actions that did work.
 *
 * host-core already retries its write read-back for exactly this reason; this
 * applies the same bounded retry to the observation handed to the model.
 *
 * Cost is paid only when nothing changed: the first differing read returns
 * immediately, so a reacting application adds no latency. No validation gate is
 * relaxed, and observe failures propagate unchanged.
 */
export async function observeUntilSettled<T>(
  before: T,
  observe: () => Promise<T>,
  signatureOf: (value: T) => string,
  options: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? POST_ACTION_SETTLE_ATTEMPTS);
  const intervalMs = options.intervalMs ?? POST_ACTION_SETTLE_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const beforeSignature = signatureOf(before);
  let current = await observe();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (signatureOf(current) !== beforeSignature) return current;
    await sleep(intervalMs);
    current = await observe();
  }
  return current;
}
