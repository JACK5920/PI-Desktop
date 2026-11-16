import type { UiMessage } from "@pi-desktop/shared";
import { getSessionMessageSnapshot } from "./session-transcript-updates";

/** Approximate renderer-side text payload size; deliberately excludes images. */
const messageWeights = new WeakMap<UiMessage, number>();
const blockWeights = new WeakMap<readonly UiMessage[], number>();

function valueWeight(value: unknown, depth = 0, seen = new Set<object>()): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (!value || typeof value !== "object" || depth >= 4 || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return 16 + value.slice(0, 256).reduce((total, item) => total + valueWeight(item, depth + 1, seen), 0);
  }
  return 32 + Object.entries(value).slice(0, 128).reduce(
    (total, [key, item]) => total + key.length * 2 + valueWeight(item, depth + 1, seen),
    0,
  );
}

function messageWeight(message: UiMessage): number {
  const cached = messageWeights.get(message);
  if (cached !== undefined) return cached;
  const weight = 128 + valueWeight(message);
  messageWeights.set(message, weight);
  return weight;
}

/**
 * Estimate cache pressure without serializing the transcript. Transcript
 * snapshots reuse unchanged 64-message blocks, so streaming updates only
 * remeasure the block containing the changed row.
 */
export function estimateTranscriptCacheBytes(messages: UiMessage[]): number {
  let total = 0;
  for (const block of getSessionMessageSnapshot(messages).blocks) {
    let weight = blockWeights.get(block);
    if (weight === undefined) {
      weight = block.reduce((sum, message) => sum + messageWeight(message), 0);
      blockWeights.set(block, weight);
    }
    total += weight;
  }
  return total;
}
