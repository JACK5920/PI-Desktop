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

/** Keep every selected user-message source visible in an appended quote. */
export function transcriptSelectionSourceAttribution(
  messageIds: readonly string[],
  singleMessageLabel: string,
): string {
  const uniqueIds = [...new Set(messageIds)];
  return uniqueIds.length > 1
    ? `${singleMessageLabel} (${uniqueIds.join(", ")})`
    : singleMessageLabel;
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
  streaming?: boolean;
};

export type TranscriptSelectionRect = Pick<
  DOMRect,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

export type TranscriptSelection = Omit<TranscriptSelectionOwner, "eligible"> & {
  /** All eligible source messages intersecting the selected range, in transcript order. */
  messageIds: string[];
  excerpt: string;
  rect: TranscriptSelectionRect;
  anchorStart?: number;
  anchorEnd?: number;
};

/** Visible assistant fragments remain selectable while a later turn fragment is active. */
export function isAssistantFragmentSelectable(
  _isActiveTurn: boolean,
  _messageStatus: string | undefined,
): boolean {
  return true;
}

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
  sourceOwners,
  excerpt,
  rect,
  anchor,
}: {
  anchorOwner: TranscriptSelectionOwner | null;
  focusOwner: TranscriptSelectionOwner | null;
  sourceOwners?: readonly TranscriptSelectionOwner[];
  excerpt: string;
  rect: TranscriptSelectionRect;
  anchor?: { anchorStart: number; anchorEnd: number };
}): TranscriptSelection | null {
  if (!anchorOwner || !focusOwner || !anchorOwner.eligible || !focusOwner.eligible) {
    return null;
  }
  const owners = sourceOwners?.length ? sourceOwners : [anchorOwner, focusOwner];
  if (
    anchorOwner.sessionId !== focusOwner.sessionId ||
    anchorOwner.role !== focusOwner.role ||
    (!sourceOwners && anchorOwner.messageId !== focusOwner.messageId)
  ) return null;
  const uniqueOwners = owners.filter((owner, index) =>
    owners.findIndex((candidate) => candidate.messageId === owner.messageId) === index,
  );
  if (
    uniqueOwners.length === 0 ||
    !uniqueOwners.some((owner) => owner.messageId === anchorOwner.messageId) ||
    !uniqueOwners.some((owner) => owner.messageId === focusOwner.messageId) ||
    uniqueOwners.some((owner) =>
      !owner.eligible ||
      owner.sessionId !== anchorOwner.sessionId ||
      owner.role !== anchorOwner.role,
    )
  ) return null;
  const normalizedExcerpt = normalizeTranscriptExcerpt(excerpt);
  if (!normalizedExcerpt) return null;
  const primary = uniqueOwners[0];
  return {
    sessionId: primary.sessionId,
    messageId: primary.messageId,
    messageIds: uniqueOwners.map((owner) => owner.messageId),
    role: primary.role,
    ...(uniqueOwners.some((owner) => owner.streaming) ? { streaming: true } : {}),
    excerpt: normalizedExcerpt,
    rect: { ...rect },
    ...(anchor ? anchor : {}),
  };
}

function selectionOwnerForElement(
  ownerElement: HTMLElement | null,
  transcriptRoot: HTMLElement,
): TranscriptSelectionOwner | null {
  if (!ownerElement || !transcriptRoot.contains(ownerElement)) return null;
  const { selectionMessageId, selectionSessionId, selectionRole, selectionEligible, selectionStreaming } =
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
    streaming: selectionStreaming === "true",
  };
}

function selectionOwnerForNode(
  transcriptRoot: HTMLElement,
  node: Node | null,
): TranscriptSelectionOwner | null {
  if (!node || !transcriptRoot.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  return selectionOwnerForElement(
    element?.closest<HTMLElement>("[data-selection-message-id]") ?? null,
    transcriptRoot,
  );
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
  const sourceOwners = Array.from(
    transcriptRoot.querySelectorAll<HTMLElement>("[data-selection-message-id]"),
  ).flatMap((element) => {
    try {
      return range.intersectsNode(element) ? [selectionOwnerForElement(element, transcriptRoot)] : [];
    } catch {
      return [];
    }
  }).filter((owner): owner is TranscriptSelectionOwner => owner !== null);
  const anchorOwner = selectionOwnerForNode(transcriptRoot, selection.anchorNode);
  const focusOwner = selectionOwnerForNode(transcriptRoot, selection.focusNode);
  for (const endpointOwner of [anchorOwner, focusOwner]) {
    if (endpointOwner && !sourceOwners.some((owner) => owner.messageId === endpointOwner.messageId)) {
      sourceOwners.push(endpointOwner);
    }
  }
  const anchorElement = ownerElementForNode(transcriptRoot, selection.anchorNode);
  const excerpt = texClipboardPayload(selection) ?? selection.toString();
  const capturedAnchor = sourceOwners.length === 1 && anchorElement
    ? anchorForRange(anchorElement, range, excerpt)
    : undefined;
  const captured = resolveTranscriptSelection({
    anchorOwner,
    focusOwner,
    sourceOwners,
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
