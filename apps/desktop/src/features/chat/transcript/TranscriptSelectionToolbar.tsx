import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton, Textarea } from "../../../components/ui";
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
    left.excerpt === right.excerpt &&
    left.anchorStart === right.anchorStart &&
    left.anchorEnd === right.anchorEnd;
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
  const pointerGestureRef = useRef(false);
  const keyboardSelectionTimerRef = useRef<number | null>(null);
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
      item.sourceMessageId === selection.messageId &&
      item.excerpt === selection.excerpt &&
      item.anchorStart === selection.anchorStart &&
      item.anchorEnd === selection.anchorEnd,
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
    if (pointerGestureRef.current) return;
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
    if (previous && !sameSelection(previous, next) && editingComment) return;
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
    const selectionChange = () => {
      if (pointerGestureRef.current || editingComment) return;
      if (window.getSelection()?.isCollapsed !== false) {
        dismissedSelectionRef.current = null;
      }
      if (!toolbarRef.current?.contains(document.activeElement)) {
        selectionRef.current = null;
        setSelection(null);
      }
      if (keyboardSelectionTimerRef.current !== null) {
        window.clearTimeout(keyboardSelectionTimerRef.current);
      }
      keyboardSelectionTimerRef.current = window.setTimeout(() => {
        keyboardSelectionTimerRef.current = null;
        refreshSelection();
      }, 180);
    };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && transcriptRoot.contains(target)) {
        if (editingComment) return;
        const owner = target.closest<HTMLElement>("[data-selection-message-id]");
        const interactive = target.closest("button, a, input, textarea, [role='button'], [contenteditable='true']");
        if (owner && !interactive) {
          pointerGestureRef.current = true;
          if (keyboardSelectionTimerRef.current !== null) {
            window.clearTimeout(keyboardSelectionTimerRef.current);
            keyboardSelectionTimerRef.current = null;
          }
          selectionRef.current = null;
          dismissedSelectionRef.current = null;
          setSelection(null);
          setEditingComment(false);
          setComment("");
          return;
        }
      }
      if (!toolbarRef.current?.contains(target as Node)) dismiss();
    };
    const pointerUp = () => {
      if (!pointerGestureRef.current) return;
      pointerGestureRef.current = false;
      requestAnimationFrame(() => requestAnimationFrame(refreshSelection));
    };
    const pointerCancel = () => {
      pointerGestureRef.current = false;
      selectionRef.current = null;
      setSelection(null);
    };
    const reposition = () => {
      const current = selectionRef.current;
      if (!current || pointerGestureRef.current || editingComment) return;
      const next = captureTranscriptSelection(window.getSelection(), transcriptRoot, sessionId);
      if (next && sameSelection(current, next)) {
        selectionRef.current = next;
        setSelection(next);
      } else if (!toolbarRef.current?.contains(document.activeElement)) {
        dismiss();
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectionRef.current) {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
      }
    };
    document.addEventListener("selectionchange", selectionChange);
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("pointerup", pointerUp, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    document.addEventListener("keydown", keyDown, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      if (keyboardSelectionTimerRef.current !== null) {
        window.clearTimeout(keyboardSelectionTimerRef.current);
        keyboardSelectionTimerRef.current = null;
      }
      document.removeEventListener("selectionchange", selectionChange);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointerup", pointerUp, true);
      document.removeEventListener("pointercancel", pointerCancel, true);
      document.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [dismiss, editingComment, refreshSelection, sessionId, transcriptRoot]);

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
      selection.anchorStart === undefined || selection.anchorEnd === undefined
        ? undefined
        : { anchorStart: selection.anchorStart, anchorEnd: selection.anchorEnd },
    );
    if (!annotationId) {
      showToast(t("chat.selectionAddFailed"), { variant: "error" });
      return;
    }
    editResponseAnnotation(selection.sessionId, annotationId, comment);
    dismiss(true);
  };

  if (!selection) return null;
  const estimatedWidth = editingComment ? 380 : selection.role === "assistant" ? 430 : 250;
  const left = Math.max(8, Math.min(selection.rect.left, window.innerWidth - estimatedWidth - 8));
  const estimatedHeight = editingComment ? 230 : 48;
  const maxTop = Math.max(8, window.innerHeight - estimatedHeight - 8);
  const preferredTop = selection.rect.top >= estimatedHeight + 16
    ? selection.rect.top - estimatedHeight - 8
    : selection.rect.bottom + 8;
  const top = Math.max(8, Math.min(preferredTop, maxTop));

  return (
    <div
      ref={toolbarRef}
      className={`transcript-selection-toolbar${editingComment ? " is-editing-comment" : ""}`}
      data-testid="selection-reference-toolbar"
      data-selection-excerpt={selection.excerpt}
      role="toolbar"
      aria-label={t("chat.selectionToolbar")}
      style={{ left, top }}
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => dismiss(true)}
            >
              {t("chat.cancelEdit")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={saveAnnotation}
            >
              {t("chat.saveAnnotation")}
            </Button>
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
