import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TooltipButton, Textarea } from "../../../components/ui";
import { IconCopy } from "../../../components/icons";
import type { ResponseAnnotation } from "../../../lib/response-annotations";
import {
  captureTranscriptSelection,
  formatUserSelectionQuote,
  type TranscriptSelection,
} from "../../../lib/transcript-selection";
import { composerDraftBridge } from "../composer/plugins/draft-bridge";
import { useAppStore } from "../../../stores/app-store";

type TranscriptSelectionToolbarProps = {
  transcriptRoot: HTMLElement | null;
  sessionId?: string;
  onAskInSideChat?: (selection: TranscriptSelection) => void;
  onAppendUserSelection?: (selection: TranscriptSelection) => void;
};

const EMPTY_RESPONSE_ANNOTATIONS: ResponseAnnotation[] = [];

function sameSelection(left: TranscriptSelection, right: TranscriptSelection): boolean {
  return left.sessionId === right.sessionId &&
    left.messageId === right.messageId &&
    left.role === right.role &&
    left.excerpt === right.excerpt;
}

export function TranscriptSelectionToolbar({
  transcriptRoot,
  sessionId,
  onAskInSideChat,
  onAppendUserSelection,
}: TranscriptSelectionToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<TranscriptSelection | null>(null);
  const dismissedSelectionRef = useRef<TranscriptSelection | null>(null);
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const [editingComment, setEditingComment] = useState(false);
  const [comment, setComment] = useState("");
  const responseAnnotations = useAppStore((state) =>
    selection
      ? state.responseAnnotations[selection.sessionId] ?? EMPTY_RESPONSE_ANNOTATIONS
      : EMPTY_RESPONSE_ANNOTATIONS,
  );
  const addResponseAnnotation = useAppStore((state) => state.addResponseAnnotation);
  const editResponseAnnotation = useAppStore((state) => state.editResponseAnnotation);
  const showToast = useAppStore((state) => state.showToast);
  const duplicate = useMemo(() => selection?.role === "assistant"
    ? responseAnnotations.find((item) =>
      item.sourceMessageId === selection.messageId && item.excerpt === selection.excerpt,
    )
    : undefined, [responseAnnotations, selection]);

  const dismiss = useCallback((
    restoreFocus = false,
    suppressedSelection: TranscriptSelection | null = selectionRef.current,
  ) => {
    const captured = selectionRef.current;
    selectionRef.current = null;
    dismissedSelectionRef.current = suppressedSelection;
    setSelection(null);
    setEditingComment(false);
    setComment("");
    if (restoreFocus && captured && transcriptRoot) {
      const owner = Array.from(
        transcriptRoot.querySelectorAll<HTMLElement>("[data-selection-message-id]"),
      ).find((item) =>
        item.dataset.selectionMessageId === captured.messageId &&
        item.dataset.selectionSessionId === captured.sessionId,
      );
      if (owner) {
        owner.tabIndex = -1;
        owner.focus({ preventScroll: true });
      }
    }
  }, [transcriptRoot]);

  const refreshSelection = useCallback(() => {
    const next = captureTranscriptSelection(
      window.getSelection(),
      transcriptRoot,
      sessionId,
    );
    if (!next) {
      dismissedSelectionRef.current = null;
      if (toolbarRef.current?.contains(document.activeElement)) return;
      if (!editingComment) dismiss();
      return;
    }
    const previous = selectionRef.current;
    if (previous && !sameSelection(previous, next)) {
      if (editingComment) return;
      dismiss(false, next);
      return;
    }
    const dismissedSelection = dismissedSelectionRef.current;
    if (!previous && dismissedSelection && sameSelection(dismissedSelection, next)) return;
    dismissedSelectionRef.current = null;
    selectionRef.current = next;
    setSelection(next);
  }, [dismiss, editingComment, sessionId, transcriptRoot]);

  useEffect(() => {
    if (!transcriptRoot || !sessionId) {
      dismiss();
      return;
    }
    const selectionChange = () => refreshSelection();
    const reposition = () => {
      if (selectionRef.current) refreshSelection();
    };
    const outsidePress = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) dismiss();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectionRef.current) {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
      }
    };
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("pointerdown", outsidePress, true);
    document.addEventListener("keydown", keyDown, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("selectionchange", selectionChange);
      document.removeEventListener("pointerdown", outsidePress, true);
      document.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [dismiss, refreshSelection, sessionId, transcriptRoot]);

  useEffect(() => {
    if (selectionRef.current?.sessionId !== sessionId) dismiss();
  }, [dismiss, sessionId]);

  const copySelection = async () => {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.excerpt);
      showToast(t("chat.copied"), { variant: "success" });
      dismiss(true);
    } catch {
      showToast(t("chat.copyFailed"), { variant: "error" });
    }
  };

  const addToChat = () => {
    if (!selection) return;
    if (selection.role === "user") {
      try {
        if (onAppendUserSelection) {
          onAppendUserSelection(selection);
          dismiss(true);
          return;
        }
        composerDraftBridge.appendTextForSession(
          selection.sessionId,
          formatUserSelectionQuote(selection.excerpt, t("chat.selectionSourceUser")),
        );
        dismiss(true);
      } catch {
        showToast(t("chat.selectionAddFailed"), { variant: "error" });
      }
      return;
    }
    setComment(duplicate?.comment ?? "");
    setEditingComment(true);
  };

  const saveAnnotation = () => {
    if (!selection || selection.role !== "assistant") return;
    const annotationId = addResponseAnnotation(
      selection.sessionId,
      selection.messageId,
      selection.excerpt,
    );
    if (!annotationId) {
      showToast(t("chat.selectionAddFailed"), { variant: "error" });
      return;
    }
    editResponseAnnotation(selection.sessionId, annotationId, comment);
    dismiss(true);
  };

  if (!selection) return null;
  const estimatedWidth = editingComment ? 360 : selection.role === "assistant" ? 430 : 250;
  const left = Math.max(8, Math.min(selection.rect.left, window.innerWidth - estimatedWidth - 8));
  const top = selection.rect.top >= 56
    ? selection.rect.top - (editingComment ? 210 : 48)
    : selection.rect.bottom + 8;

  return (
    <div
      ref={toolbarRef}
      className={`transcript-selection-toolbar${editingComment ? " is-editing-comment" : ""}`}
      data-testid="selection-reference-toolbar"
      role="toolbar"
      aria-label={t("chat.selectionToolbar")}
      style={{ left, top: Math.max(8, top) }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) event.preventDefault();
      }}
    >
      {editingComment ? (
        <div className="transcript-selection-annotation-editor" data-testid="selection-annotation-editor">
          <label className="transcript-selection-annotation-label" htmlFor="selection-annotation-comment">
            {t("chat.annotationCommentLabel")}
          </label>
          <Textarea
            id="selection-annotation-comment"
            value={comment}
            placeholder={t("chat.annotationCommentPlaceholder")}
            rows={3}
            onChange={(event) => setComment(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                dismiss(true);
              }
            }}
          />
          <div className="transcript-selection-annotation-actions">
            <TooltipButton
              type="button"
              className="composer-queued-prompt-action"
              tooltip={t("chat.cancelEdit")}
              ariaLabel={t("chat.cancelEdit")}
              onClick={() => dismiss(true)}
            >
              {t("chat.cancelEdit")}
            </TooltipButton>
            <TooltipButton
              type="button"
              className="send-btn"
              tooltip={t("chat.saveAnnotation")}
              ariaLabel={t("chat.saveAnnotation")}
              onClick={saveAnnotation}
            >
              {t("chat.saveAnnotation")}
            </TooltipButton>
          </div>
        </div>
      ) : (
        <>
          <TooltipButton
            type="button"
            className="transcript-selection-action"
            tooltip={t("chat.copySelection")}
            ariaLabel={t("chat.copySelection")}
            onClick={() => void copySelection()}
          >
            <IconCopy size={14} aria-hidden />
            <span>{t("chat.copySelection")}</span>
          </TooltipButton>
          <TooltipButton
            type="button"
            className="transcript-selection-action"
            tooltip={t("chat.addSelectionToChat")}
            ariaLabel={t("chat.addSelectionToChat")}
            onClick={addToChat}
          >
            <span>{t("chat.addSelectionToChat")}</span>
          </TooltipButton>
          {selection.role === "assistant" && onAskInSideChat ? (
            <TooltipButton
              type="button"
              className="transcript-selection-action"
              tooltip={t("chat.askInSideChat")}
              ariaLabel={t("chat.askInSideChat")}
              onClick={() => {
                onAskInSideChat(selection);
                dismiss(true);
              }}
            >
              <span>{t("chat.askInSideChat")}</span>
            </TooltipButton>
          ) : null}
        </>
      )}
    </div>
  );
}
