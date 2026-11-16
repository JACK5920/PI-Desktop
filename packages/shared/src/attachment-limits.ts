/**
 * Maximum raw image size that may be embedded in a provider request.
 *
 * MiniMax's OpenAI-compatible endpoint accepts one image up to 10 MB. Keep
 * the bound decimal and shared by Electron main and the sidecar so a replay
 * cannot take a different transport path from a fresh prompt.
 */
export const MAX_INLINE_IMAGE_BYTES = 10_000_000;

/**
 * Oversized prompt images are adapted to a small, provider-friendly copy for
 * model input. The original attachment remains stored and displayed unchanged.
 */
export const MAX_ADAPTED_IMAGE_EDGE_PX = 2_000;

/**
 * Maximum aggregate raw image bytes inlined into V8 memory during history restoration.
 * Bounds total base64 memory footprint to protect against sidecar heap exhaustion (#1077).
 */
export const MAX_INLINED_IMAGE_HISTORY_BYTES = 30_000_000;
