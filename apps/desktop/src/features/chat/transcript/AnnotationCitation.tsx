import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { annotationSourceTarget, navigateToAnnotationSource } from "../../../lib/annotation-source-navigation";
import type { ParsedResponseAnnotation } from "../../../lib/response-annotations";
import { TranscriptSourceNavigationContext } from "../../../lib/transcript-search-context";
import { useAppStore } from "../../../stores/app-store";

export function AnnotationCitation({
  annotation,
  index,
  sessionId,
}: {
  annotation: ParsedResponseAnnotation;
  index: number;
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigateWithinTranscript = useContext(TranscriptSourceNavigationContext);

  useEffect(() => {
    if (!open) return;
    const outsidePress = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) &&
        !buttonRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", outsidePress, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", outsidePress, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [open]);

  const jumpToSource = () => {
    if (!sessionId) return;
    const target = annotationSourceTarget(sessionId, annotation);
    if (navigateWithinTranscript) navigateWithinTranscript(target);
    else void navigateToAnnotationSource(target, () => useAppStore.getState()).catch((error) => {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    });
    setOpen(false);
  };

  return (
    <span
      className="annotation-citation-wrap"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => {
        if (!buttonRef.current?.matches(":focus")) setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="annotation-citation"
        aria-label={t("chat.annotationCitationLabel", { index })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="response-annotation-citation"
        onFocus={() => setOpen(true)}
        onClick={jumpToSource}
      >
        {index}
      </button>
      {open ? (
        <span
          ref={panelRef}
          className="annotation-citation-popover"
          role="dialog"
          aria-label={t("chat.annotationCitationTitle", { index })}
        >
          <span className="annotation-citation-heading">
            {t("chat.annotationCitationTitle", { index })}
          </span>
          <span className="annotation-citation-excerpt" role="note">{annotation.excerpt}</span>
          {annotation.comment ? (
            <span className="annotation-citation-comment">
              <span className="annotation-citation-section-label">{t("chat.annotationCommentLabel")}</span>
              <span className="annotation-citation-comment-text">{annotation.comment}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
