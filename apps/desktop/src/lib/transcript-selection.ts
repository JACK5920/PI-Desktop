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

export type TranscriptTextAnchor = {
  /** Inclusive UTF-16 offset in the source message's eligible text stream. */
  start: number;
  /** Exclusive UTF-16 offset in the source message's eligible text stream. */
  end: number;
};

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
  anchorStart?: number;
  anchorEnd?: number;
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

/** Resolve a persisted half-open UTF-16 range only when it still names its excerpt. */
export function resolveTranscriptTextAnchor(
  sourceText: string,
  anchorStart: number | undefined,
  anchorEnd: number | undefined,
  expectedExcerpt: string,
): TranscriptTextAnchor | null {
  if (
    typeof anchorStart !== "number" ||
    typeof anchorEnd !== "number" ||
    !Number.isSafeInteger(anchorStart) ||
    !Number.isSafeInteger(anchorEnd) ||
    anchorStart < 0 ||
    anchorEnd <= anchorStart ||
    anchorEnd > sourceText.length
  ) {
    return null;
  }
  const excerpt = normalizeTranscriptExcerpt(expectedExcerpt);
  if (!excerpt) return null;
  const actual = normalizeTranscriptExcerpt(sourceText.slice(anchorStart, anchorEnd));
  return actual === excerpt ? { start: anchorStart, end: anchorEnd } : null;
}

/** Resolve a range only when both endpoints belong to the same eligible row. */
export function resolveTranscriptSelection({
  anchorOwner,
  focusOwner,
  excerpt,
  rect,
  anchor,
}: {
  anchorOwner: TranscriptSelectionOwner | null;
  focusOwner: TranscriptSelectionOwner | null;
  excerpt: string;
  rect: TranscriptSelectionRect;
  anchor?: { anchorStart: number; anchorEnd: number };
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
    ...(anchor ? anchor : {}),
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

function ownerElementForNode(
  transcriptRoot: HTMLElement,
  node: Node | null,
): HTMLElement | null {
  if (!node || !transcriptRoot.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const ownerElement = element?.closest<HTMLElement>("[data-selection-message-id]");
  return ownerElement && transcriptRoot.contains(ownerElement) ? ownerElement : null;
}

/** Capture offsets across rendered text nodes without changing their source markup. */
function anchorForRange(
  ownerElement: HTMLElement,
  range: Range,
  excerpt: string,
): { anchorStart: number; anchorEnd: number } | undefined {
  const rangeElement = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const candidateRoot = rangeElement?.closest<HTMLElement>(".prose-chat, .message-user-text");
  const contentRoot = candidateRoot && ownerElement.contains(candidateRoot)
    ? candidateRoot
    : ownerElement;
  const view = contentRoot.ownerDocument.defaultView;
  if (!view) return undefined;
  const walker = contentRoot.ownerDocument.createTreeWalker(contentRoot, view.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.textContent || !parent || parent.closest(
        '[aria-hidden="true"], [data-selection-anchor-ignore="true"], script, style',
      )) {
        return view.NodeFilter.FILTER_REJECT;
      }
      return view.NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === view.Node.TEXT_NODE) textNodes.push(walker.currentNode as Text);
  }
  const startNode = range.startContainer.nodeType === view.Node.TEXT_NODE
    ? range.startContainer as Text
    : null;
  const endNode = range.endContainer.nodeType === view.Node.TEXT_NODE
    ? range.endContainer as Text
    : null;
  if (!startNode || !endNode) return undefined;
  const startIndex = textNodes.indexOf(startNode);
  const endIndex = textNodes.indexOf(endNode);
  if (startIndex < 0 || endIndex < startIndex || range.startOffset > startNode.length || range.endOffset > endNode.length) {
    return undefined;
  }
  let anchorStart = range.startOffset;
  let anchorEnd = range.endOffset;
  let sourceText = "";
  for (const [index, node] of textNodes.entries()) {
    if (index < startIndex) anchorStart += node.length;
    if (index < endIndex) anchorEnd += node.length;
    sourceText += node.data;
  }
  if (!resolveTranscriptTextAnchor(sourceText, anchorStart, anchorEnd, excerpt)) return undefined;
  return { anchorStart, anchorEnd };
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
  const anchorOwner = selectionOwnerForNode(transcriptRoot, selection.anchorNode);
  const focusOwner = selectionOwnerForNode(transcriptRoot, selection.focusNode);
  const anchorElement = ownerElementForNode(transcriptRoot, selection.anchorNode);
  const excerpt = texClipboardPayload(selection) ?? selection.toString();
  const capturedAnchor = anchorElement ? anchorForRange(anchorElement, range, excerpt) : undefined;
  const captured = resolveTranscriptSelection({
    anchorOwner,
    focusOwner,
    excerpt,
    ...(capturedAnchor ? { anchor: capturedAnchor } : {}),
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
