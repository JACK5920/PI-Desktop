import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveTranscriptTextAnchor } from "../../../lib/transcript-selection";
import type { IndexedSourceResponseAnnotation } from "../../../lib/response-annotations";

type Marker = {
  annotation: IndexedSourceResponseAnnotation;
  index: number;
  top: number;
  left: number;
  anchored: boolean;
  rightAligned: boolean;
};

function eligibleText(root: HTMLElement): { text: string; nodes: Text[] } {
  const view = root.ownerDocument.defaultView;
  if (!view) return { text: "", nodes: [] };
  const walker = root.ownerDocument.createTreeWalker(root, view.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return node.textContent && parent && !parent.closest(
        '[aria-hidden="true"], [data-selection-anchor-ignore="true"], script, style',
      )
        ? view.NodeFilter.FILTER_ACCEPT
        : view.NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return { text: nodes.map((node) => node.data).join(""), nodes };
}

function rangeForOffsets(root: HTMLElement, nodes: Text[], start: number, end: number): Range | null {
  let cursor = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const next = cursor + node.length;
    if (!startNode && start >= cursor && start <= next) {
      startNode = node;
      startOffset = start - cursor;
    }
    if (!endNode && end >= cursor && end <= next) {
      endNode = node;
      endOffset = end - cursor;
    }
    cursor = next;
  }
  if (!startNode || !endNode) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

export function SourceAnnotationMarkers({
  annotations,
  contentHost,
}: {
  annotations: readonly IndexedSourceResponseAnnotation[];
  contentHost: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const suppressFocusOpenRef = useRef(false);

  useEffect(() => {
    if (!contentHost || annotations.length === 0) {
      setMarkers([]);
      return;
    }
    let frame = 0;
    const update = () => {
      const row = contentHost.closest<HTMLElement>(".message-row");
      const prose = contentHost.querySelector<HTMLElement>(".prose-chat");
      if (!row || !prose) {
        setMarkers([]);
        return;
      }
      const rowRect = row.getBoundingClientRect();
      const { text, nodes } = eligibleText(prose);
      setMarkers(annotations.map((annotation, index) => {
        const resolved = resolveTranscriptTextAnchor(
          text,
          annotation.anchorStart,
          annotation.anchorEnd,
          annotation.excerpt,
        );
        const range = resolved
          ? rangeForOffsets(prose, nodes, resolved.start, resolved.end)
          : null;
        const rangeRect = range?.getBoundingClientRect();
        if (rangeRect && rangeRect.width + rangeRect.height > 0) {
          return {
            annotation,
            index,
            top: rangeRect.bottom - rowRect.top,
            left: Math.min(rowRect.width - 28, Math.max(0, rangeRect.right - rowRect.left + index * 22)),
            anchored: true,
            rightAligned: rangeRect.right + 350 > window.innerWidth,
          };
        }
        return {
          annotation,
          index,
          top: Math.max(0, rowRect.height - 22),
          left: index * 30,
          anchored: false,
          rightAligned: false,
        };
      }));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [annotations, contentHost]);

  useEffect(() => {
    if (openIndex === null) return;
    const outside = (event: PointerEvent) => {
      if (!layerRef.current?.contains(event.target as Node)) setOpenIndex(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenIndex(null);
      if (openIndex !== null) {
        const button = layerRef.current?.querySelector<HTMLButtonElement>(
          `[data-source-marker-index="${openIndex}"] .source-annotation-marker`,
        );
        if (button && document.activeElement !== button) {
          suppressFocusOpenRef.current = true;
          button.focus();
        }
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [openIndex]);

  if (!markers.length) return null;
  return (
    <div ref={layerRef} className="source-annotation-layer" data-testid="source-annotation-markers">
      {markers.map(({ annotation, index, top, left, anchored, rightAligned }) => (
        <span
          key={`${annotation.promptMessageId}-${annotation.sourceMessageId}-${index}-${annotation.anchorStart ?? "legacy"}`}
          className={`source-annotation-marker-wrap${anchored ? " is-anchored" : " is-message-level"}${rightAligned ? " is-right-aligned" : ""}`}
          data-source-marker-index={index}
          style={{ top, left }}
        >
          <button
            type="button"
            className="source-annotation-marker"
            aria-label={t("chat.annotationCitationLabel", { index: annotation.referenceIndex })}
            aria-haspopup="dialog"
            aria-expanded={openIndex === index}
            data-testid="source-annotation-marker"
            onPointerEnter={() => setOpenIndex(index)}
            onPointerLeave={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setOpenIndex(null);
            }}
            onFocus={() => {
              if (suppressFocusOpenRef.current) {
                suppressFocusOpenRef.current = false;
                return;
              }
              setOpenIndex(index);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) setOpenIndex(null);
            }}
            onClick={() => setOpenIndex((current) => current === index ? null : index)}
          >
            {annotation.referenceIndex}
          </button>
          {openIndex === index ? (
            <span className="source-annotation-popover" role="dialog" aria-label={t("chat.annotationCitationTitle", { index: annotation.referenceIndex })}>
              <span className="source-annotation-heading">{t("chat.annotationCitationTitle", { index: annotation.referenceIndex })}</span>
              <span className="source-annotation-excerpt">{annotation.excerpt}</span>
              {annotation.comment ? <span className="source-annotation-comment">{annotation.comment}</span> : null}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
