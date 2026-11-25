import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPencil, IconTrash } from "../../../components/icons";
import { Button, Textarea, TooltipButton } from "../../../components/ui";
import { annotationSourceTarget, type AnnotationSourceTarget } from "../../../lib/annotation-source-navigation";
import { useAppStore } from "../../../stores/app-store";

const EMPTY_ANNOTATIONS: never[] = [];

export function ComposerAnnotationAttachments({
  sessionId: requestedSessionId,
  onNavigateToSource,
}: {
  sessionId?: string;
  onNavigateToSource?: (target: AnnotationSourceTarget) => void;
} = {}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionId = requestedSessionId ?? activeSessionId;
  const annotations = useAppStore((state) =>
    sessionId ? state.responseAnnotations[sessionId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS,
  );
  const navigateTranscript = useAppStore((state) => state.navigateTranscript);
  const editAnnotation = useAppStore((state) => state.editResponseAnnotation);
  const removeAnnotation = useAppStore((state) => state.removeResponseAnnotation);
  const clearAnnotations = useAppStore((state) => state.clearResponseAnnotations);
  const [open, setOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const cardId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!cardRef.current?.contains(event.target as Node)) {
        setPinnedOpen(false);
        setOpen(false);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPinnedOpen(false);
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [open]);

  if (!sessionId || annotations.length === 0) return null;

  const closeCard = () => {
    setPinnedOpen(false);
    setOpen(false);
  };
  const jumpToSource = (annotation: (typeof annotations)[number]) => {
    const target = annotationSourceTarget(sessionId, annotation);
    if (onNavigateToSource) onNavigateToSource(target);
    else void navigateTranscript(target);
    closeCard();
  };

  return (
    <div
      className="composer-annotation-attachments"
      data-testid="composer-annotation-attachments"
      ref={cardRef}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={(event) => {
        if (
          !pinnedOpen &&
          !event.currentTarget.contains(event.relatedTarget as Node) &&
          !event.currentTarget.matches(":focus-within")
        ) setOpen(false);
      }}
      onFocusCapture={() => setOpen(true)}
      onBlur={(event) => {
        if (
          !pinnedOpen &&
          !event.currentTarget.matches(":hover") &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        ) setOpen(false);
      }}
    >
      <button
        type="button"
        className="composer-annotation-chip"
        aria-expanded={open}
        aria-controls={cardId}
        aria-label={t("chat.annotationAttachments", { count: annotations.length })}
        onClick={() => {
          setOpen(true);
          setPinnedOpen((value) => !value);
        }}
      >
        {t("chat.annotationAttachments", { count: annotations.length })}
      </button>
      {open ? (
        <div
          id={cardId}
          className="composer-annotation-card"
          role="region"
          aria-label={t("chat.annotationAttachments", { count: annotations.length })}
          data-testid="composer-annotation-card"
        >
          <ol className="composer-annotation-list">
            {annotations.map((annotation, index) => (
              <li key={annotation.id} className="composer-annotation-item" data-annotation-index={index + 1}>
                <div className="composer-annotation-content">
                  <span className="composer-annotation-number">{index + 1}</span>
                  <button
                    type="button"
                    className="composer-annotation-source-button"
                    aria-label={`${t("chat.annotationCitationLabel", { index: index + 1 })}: ${annotation.excerpt}`}
                    onClick={() => jumpToSource(annotation)}
                  >
                    {annotation.excerpt}
                  </button>
                  {annotation.comment ? <p className="composer-annotation-comment">{annotation.comment}</p> : null}
                </div>
                {editingId === annotation.id ? (
                  <div className="composer-annotation-edit">
                    <label htmlFor={`composer-annotation-comment-${annotation.id}`}>
                      {t("chat.annotationCommentLabel")}
                    </label>
                    <Textarea
                      id={`composer-annotation-comment-${annotation.id}`}
                      value={comment}
                      rows={3}
                      placeholder={t("chat.annotationCommentPlaceholder")}
                      onChange={(event) => setComment(event.currentTarget.value)}
                    />
                    <div className="composer-annotation-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingId(null)}
                      >
                        {t("chat.cancelEdit")}
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          editAnnotation(sessionId, annotation.id, comment);
                          setEditingId(null);
                        }}
                      >
                        {t("chat.saveAnnotation")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="composer-annotation-actions">
                    <TooltipButton
                      type="button"
                      className="icon-btn icon-btn-square"
                      tooltip={t("chat.editAnnotation")}
                      ariaLabel={t("chat.editAnnotation")}
                      onClick={() => {
                        setComment(annotation.comment ?? "");
                        setEditingId(annotation.id);
                      }}
                    >
                      <IconPencil size={14} aria-hidden />
                    </TooltipButton>
                    <TooltipButton
                      type="button"
                      className="icon-btn icon-btn-square"
                      tooltip={t("chat.removeAnnotation")}
                      ariaLabel={t("chat.removeAnnotation")}
                      onClick={() => removeAnnotation(sessionId, annotation.id)}
                    >
                      <IconTrash size={14} aria-hidden />
                    </TooltipButton>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="composer-annotation-clear"
            onClick={() => {
              clearAnnotations(sessionId);
              closeCard();
            }}
          >
            {t("chat.clearAnnotations")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
