import { texClipboardPayload } from "./selection-tex";

export const TRANSCRIPT_SELECTION_MAX_LENGTH = 2_000;

/** Format a captured user excerpt for appending to a Composer draft. */
export function formatUserSelectionQuote(
  excerpt: string,
  sourceAttribution: string,
): string {
  const normalized = normalizeTranscriptExcerpt(excerpt);
  if (!normalized) return "";
  const quote = normalized
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const attribution = sourceAttribution.replace(/[\r\n]+/g, " ").trim();
  return attribution ? `${quote}\n\n— ${attribution}` : quote;
}

export type TranscriptSelectionRole = "assistant" | "user";

export type TranscriptSelectionOwner = {
  sessionId: string;
  messageId: string;
  role: TranscriptSelectionRole;
  eligible: boolean;
};

export type TranscriptSelectionRect = Pick<
  DOMRect,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

export type TranscriptSelection = Omit<TranscriptSelectionOwner, "eligible"> & {
  excerpt: string;
  rect: TranscriptSelectionRect;
};

/** Normalize browser text and cap toolbar excerpts without splitting emoji. */
export function normalizeTranscriptExcerpt(
  raw: string,
  maxLength = TRANSCRIPT_SELECTION_MAX_LENGTH,
): string | null {
  const excerpt = raw.replace(/\r\n?/g, "\n").trim();
  if (!excerpt) return null;
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  if (limit === 0) return null;
  const normalized = Array.from(excerpt).slice(0, limit).join("");
  return normalized || null;
}

/** Resolve a range only when both endpoints belong to the same eligible row. */
export function resolveTranscriptSelection({
  anchorOwner,
  focusOwner,
  excerpt,
  rect,
}: {
  anchorOwner: TranscriptSelectionOwner | null;
  focusOwner: TranscriptSelectionOwner | null;
  excerpt: string;
  rect: TranscriptSelectionRect;
}): TranscriptSelection | null {
  if (!anchorOwner || !focusOwner || !anchorOwner.eligible || !focusOwner.eligible) {
    return null;
  }
  if (
    anchorOwner.sessionId !== focusOwner.sessionId ||
    anchorOwner.messageId !== focusOwner.messageId ||
    anchorOwner.role !== focusOwner.role
  ) {
    return null;
  }
  const normalizedExcerpt = normalizeTranscriptExcerpt(excerpt);
  if (!normalizedExcerpt) return null;
  return {
    sessionId: anchorOwner.sessionId,
    messageId: anchorOwner.messageId,
    role: anchorOwner.role,
    excerpt: normalizedExcerpt,
    rect: { ...rect },
  };
}

function selectionOwnerForNode(
  transcriptRoot: HTMLElement,
  node: Node | null,
): TranscriptSelectionOwner | null {
  if (!node || !transcriptRoot.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const ownerElement = element?.closest<HTMLElement>("[data-selection-message-id]");
  if (!ownerElement || !transcriptRoot.contains(ownerElement)) return null;
  const { selectionMessageId, selectionSessionId, selectionRole, selectionEligible } =
    ownerElement.dataset;
  if (
    !selectionMessageId ||
    !selectionSessionId ||
    (selectionRole !== "assistant" && selectionRole !== "user")
  ) {
    return null;
  }
  return {
    sessionId: selectionSessionId,
    messageId: selectionMessageId,
    role: selectionRole,
    eligible: selectionEligible === "true",
  };
}

/** Snapshot source identity, formula-aware text, and geometry before toolbar focus. */
export function captureTranscriptSelection(
  selection: Selection | null,
  transcriptRoot: HTMLElement | null,
  sessionId: string | undefined,
): TranscriptSelection | null {
  if (
    !selection ||
    !transcriptRoot ||
    !sessionId ||
    selection.isCollapsed ||
    selection.rangeCount !== 1
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const captured = resolveTranscriptSelection({
    anchorOwner: selectionOwnerForNode(transcriptRoot, selection.anchorNode),
    focusOwner: selectionOwnerForNode(transcriptRoot, selection.focusNode),
    excerpt: texClipboardPayload(selection) ?? selection.toString(),
    rect: {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  });
  return captured?.sessionId === sessionId ? captured : null;
}
