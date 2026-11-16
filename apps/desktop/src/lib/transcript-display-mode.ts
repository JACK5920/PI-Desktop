import type { AppSettings, TranscriptDisplayMode } from "@pi-desktop/shared";

export type { TranscriptDisplayMode };

const MODES = new Set<TranscriptDisplayMode>([
  "flat",
  "command-first",
  "fully-folded",
]);

export function isTranscriptDisplayMode(
  value: unknown,
): value is TranscriptDisplayMode {
  return typeof value === "string" && MODES.has(value as TranscriptDisplayMode);
}

/**
 * Resolve the transcript process layout.
 *
 * The released layout keeps shell calls inside their surrounding activity
 * group, so an absent or unknown value must fall back to `fully-folded`.
 * `keepCommandsExpanded` is a deprecated compatibility field and is not read.
 */
export function resolveTranscriptDisplayMode(
  settings: Pick<AppSettings, "transcriptDisplayMode"> | null | undefined,
): TranscriptDisplayMode {
  const value = settings?.transcriptDisplayMode;
  return isTranscriptDisplayMode(value) ? value : "fully-folded";
}

/**
 * Whether a thinking disclosure that normally opens by default should do so
 * for the active transcript layout. Fully-folded means the leaf reasoning
 * disclosure starts closed too; readers can still open it explicitly.
 */
export function shouldAutoOpenThinking(
  requested: boolean,
  mode: TranscriptDisplayMode,
): boolean {
  return requested && mode !== "fully-folded";
}
