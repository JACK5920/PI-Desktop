import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPencil, IconTrash } from "../../../components/icons";
import { Button, Textarea, TooltipButton } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";

const EMPTY_ANNOTATIONS: never[] = [];

export function ComposerAnnotationAttachments({ sessionId: requestedSessionId }: { sessionId?: string } = {}) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionId = requestedSessionId ?? activeSessionId;
  const annotations = useAppStore((state) =>
    sessionId ? state.responseAnnotations[sessionId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS,
  );
  const editAnnotation = useAppStore((state) => state.editResponseAnnotation);
  const removeAnnotation = useAppStore((state) => state.removeResponseAnnotation);
  const clearAnnotations = useAppStore((state) => state.clearResponseAnnotations);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  if (!sessionId || annotations.length === 0) return null;

  return (
    <div className="composer-annotation-attachments" data-testid="composer-annotation-attachments">
      <TooltipButton
        type="button"
        className="composer-annotation-chip"
        aria-expanded={open}
        aria-controls="composer-annotation-review"
        tooltip={t("chat.reviewAnnotations")}
        ariaLabel={t("chat.annotationAttachments", { count: annotations.length })}
        onClick={() => setOpen((value) => !value)}
      >
        {t("chat.annotationAttachments", { count: annotations.length })}
      </TooltipButton>
      {open ? (
        <div id="composer-annotation-review" className="composer-annotation-review" role="region" aria-label={t("chat.reviewAnnotations")}>
          <ol className="composer-annotation-list">
            {annotations.map((annotation, index) => (
              <li key={annotation.id} className="composer-annotation-item" data-annotation-index={index + 1}>
                <div className="composer-annotation-content">
                  <span className="composer-annotation-number">{index + 1}</span>
                  <blockquote className="composer-annotation-excerpt">{annotation.excerpt}</blockquote>
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
          <TooltipButton
            type="button"
            className="composer-annotation-clear"
            tooltip={t("chat.clearAnnotations")}
            ariaLabel={t("chat.clearAnnotations")}
            onClick={() => clearAnnotations(sessionId)}
          >
            {t("chat.clearAnnotations")}
          </TooltipButton>
        </div>
      ) : null}
    </div>
  );
}
