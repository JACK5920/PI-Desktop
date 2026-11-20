import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { installComposerDeletionGuard } from "./native-deletion";
import type {
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction,
} from "react";
import { editorSelectionRange, readEditorValue } from "./editor";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { ComposerImagePreview } from "./ComposerImagePreview";
import { ComposerImageHover } from "./ComposerImageHoverPreview";
import { DirectoryReferenceCard } from "../DirectoryReferenceCard";
import type { ComposerFileReference } from "./model";
import { composerSuggestionKeyAction } from "./plugins/suggestion-keys";
import type { ComposerSuggestionView } from "./hooks/useComposerSuggestion";
import type { CompletionController } from "./hooks/useComposerCompletions";
import type { ComposerImagePreviewController } from "./hooks/useComposerImagePreview";

export type ComposerInputProps = {
  imagePreview?: ComposerImagePreviewController;
  directoryReferences?: ComposerFileReference[];
  onRemoveDirectory?: (id: string) => void;
  inputRef: RefObject<HTMLDivElement | null>;
  value: string;
  placeholderText: string;
  placeholderKey: string;
  inputBlocked: boolean;
  pasting: boolean;
  enterToSend: boolean;
  runActive: boolean;
  ompPredictionSessionId?: string | null;
  composerAc: CompletionController;
  /**
   * The plugin suggestion on screen, if any (ADR 0333). It is drawn in the
   * placeholder layer while the draft is empty, and `Tab` / `Esc` act on it only
   * when nothing else claims those keys.
   */
  suggestion?: ComposerSuggestionView | null;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  /** Right-click on the editable or one of its chips; the caller owns the menu. */
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onAcceptCompletion: (index: number) => void;
  onSubmit: (steering?: boolean) => void;
  onInsertNewline: () => void;
  onInput: (source: string, caret: number, composing: boolean) => void;
  /** Terminal-style recall; returns true when the arrow key was consumed. */
  onHistoryNavigate: (direction: "older" | "newer") => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (event: FormEvent<HTMLDivElement>) => void;
  /**
   * A composition that the browser never reports as ended. A Windows Chinese
   * IME drops `compositionend` when the composing text is deleted, which
   * would otherwise leave the draft composing forever (#929). An input event
   * that is not part of a composition is proof it is over.
   */
  onSettledInput: () => void;
  onFocus: () => void;
  onBlur: () => void;
};

/** Rich contenteditable input; draft state and async operations stay outside. */
export function ComposerInput({
  imagePreview,
  directoryReferences = [],
  onRemoveDirectory,
  inputRef,
  value,
  placeholderText,
  placeholderKey,
  inputBlocked,
  pasting,
  enterToSend,
  runActive,
  ompPredictionSessionId = null,
  composerAc,
  suggestion = null,
  onPaste,
  onContextMenu,
  onAcceptCompletion,
  onSubmit,
  onInsertNewline,
  onInput,
  onHistoryNavigate,
  onCompositionStart,
  onCompositionEnd,
  onSettledInput,
  onFocus,
  onBlur,
}: ComposerInputProps) {
  const [wordSuggestion, setWordSuggestion] = useState<{ text: string; left: number; top: number } | null>(null);
  const [predictionInput, setPredictionInput] = useState<{ text: string; cursor: number; composing: boolean } | null>(null);
  const predictionSequence = useRef(0);
  const shownPrediction = useRef<{ text: string; cursor: number; suggestion: string; sessionId: string } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragSelectionRef = useRef<Range | null>(null);
  const selectionDragPointerIdRef = useRef<number | null>(null);
  const sendPredictionFeedback = (accepted: boolean) => {
    const shown = shownPrediction.current;
    if (!shown) return;
    shownPrediction.current = null;
    void api.ompRpcCommand({ sessionId: shown.sessionId, command: "predict_word_feedback", fields: { text: shown.text, cursor: shown.cursor, suggestion: shown.suggestion, accepted } }).catch(() => undefined);
  };
  useEffect(() => {
    const request = predictionInput;
    const sessionId = ompPredictionSessionId;
    const sequence = ++predictionSequence.current;
    if (!sessionId || !request || request.composing || inputBlocked || !request.text || request.cursor !== request.text.length) {
      setWordSuggestion(null);
      return;
    }
    const lineStart = request.text.lastIndexOf("\n", Math.max(0, request.cursor - 1)) + 1;
    const currentLine = request.text.slice(lineStart, request.cursor);
    if (!/\p{L}[\p{L}\p{N}'’_-]*$/u.test(currentLine) || currentLine.startsWith("/") || /[\\/]/.test(currentLine)) {
      setWordSuggestion(null);
      return;
    }
    const timer = setTimeout(() => {
      void api.ompRpcCommand({ sessionId, command: "predict_word", fields: { text: request.text, cursor: request.cursor } })
        .then((result: any) => {
          if (sequence !== predictionSequence.current || useAppStore.getState().activeSessionId !== sessionId) return;
          const suffix = typeof result?.data?.suffix === "string" ? result.data.suffix : "";
          if (!suffix || /[\r\n]/.test(suffix)) { setWordSuggestion(null); return; }
          const editor = inputRef.current;
          const stage = stageRef.current;
          if (!editor || !stage || document.activeElement !== editor || readEditorValue(editor) !== request.text) return;
          const selection = window.getSelection();
          if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode)) return;
          const selectedRange = editorSelectionRange(editor);
          if (selectedRange.start !== request.cursor || selectedRange.end !== request.cursor) return;
          const caret = selection.getRangeAt(0).cloneRange();
          caret.collapse(true);
          const caretRect = caret.getBoundingClientRect();
          const stageRect = stage.getBoundingClientRect();
          setWordSuggestion({ text: suffix, left: Math.max(0, caretRect.left - stageRect.left), top: Math.max(0, caretRect.top - stageRect.top) });
          shownPrediction.current = { text: request.text, cursor: request.cursor, suggestion: suffix, sessionId };
        })
        .catch(() => { if (sequence === predictionSequence.current) setWordSuggestion(null); });
    }, 550);
    return () => clearTimeout(timer);
  }, [inputRef, inputBlocked, ompPredictionSessionId, predictionInput]);
  useLayoutEffect(() => {
    const editor = inputRef.current;
    return editor ? installComposerDeletionGuard(editor) : undefined;
  }, [inputRef]);
  useEffect(() => {
    const editor = inputRef.current;
    if (!editor) return;

    const selectionRangeInEditor = (): Range | null => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        selection.toString().length === 0
      ) return null;
      const range = selection.getRangeAt(0);
      return editor.contains(range.startContainer) && editor.contains(range.endContainer)
        ? range.cloneRange()
        : null;
    };
    const onPointerDown = (event: PointerEvent) => {
      const startedInEditor = event.button === 0 &&
        event.target instanceof Node && editor.contains(event.target);
      selectionDragPointerIdRef.current = startedInEditor ? event.pointerId : null;
      dragSelectionRef.current = startedInEditor ? selectionRangeInEditor() : null;
    };
    const onSelectionChange = () => {
      if (selectionDragPointerIdRef.current === null) return;
      const range = selectionRangeInEditor();
      if (range) dragSelectionRef.current = range;
    };
    const onDragStart = (event: DragEvent) => {
      const range = selectionRangeInEditor();
      if (range) dragSelectionRef.current = range;
      if (selectionDragPointerIdRef.current !== null && dragSelectionRef.current) event.preventDefault();
    };
    // Chromium may collapse a contenteditable range when its selected text is
    // dragged outside, even after dragstart is cancelled. Restore only if that
    // native gesture actually collapsed the selection, never over a new range.
    const restoreSelectionIfCollapsed = (range: Range | null) => {
      if (!range) return;
      requestAnimationFrame(() => {
        if (
          !editor.isConnected ||
          !range.startContainer.isConnected ||
          !range.endContainer.isConnected ||
          !editor.contains(range.startContainer) ||
          !editor.contains(range.endContainer)
        ) return;
        const selection = window.getSelection();
        if (!selection || !selection.isCollapsed) return;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (selectionDragPointerIdRef.current !== event.pointerId) return;
      selectionDragPointerIdRef.current = null;
      const endedOutsideEditor = !(event.target instanceof Node && editor.contains(event.target));
      const range = dragSelectionRef.current;
      dragSelectionRef.current = null;
      if (endedOutsideEditor) restoreSelectionIfCollapsed(range);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (selectionDragPointerIdRef.current !== event.pointerId) return;
      selectionDragPointerIdRef.current = null;
      const range = dragSelectionRef.current;
      dragSelectionRef.current = null;
      restoreSelectionIfCollapsed(range);
    };

    editor.addEventListener("dragstart", onDragStart);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      editor.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [inputRef]);
  return (
    <div className="composer-input-wrap">
      {imagePreview ? <ComposerImagePreview controller={imagePreview} /> : null}
      {imagePreview ? <ComposerImageHover controller={imagePreview} editorRef={inputRef} /> : null}
      {directoryReferences.length > 0 ? (
        <div className="directory-reference-list">
          {directoryReferences.map((reference) => (
            <DirectoryReferenceCard
              key={reference.id}
              path={reference.path}
              name={reference.name}
              disabled={inputBlocked}
              onRemove={() => onRemoveDirectory?.(reference.id)}
            />
          ))}
        </div>
      ) : null}
      <div className="composer-input-stage" ref={stageRef}>
        {/* React does not render children into this node; the editor module
          paints atomic attachment chips imperatively. */}
        <div
          ref={inputRef}
          className="composer-input"
          role="textbox"
          aria-multiline="true"
          aria-readonly={inputBlocked}
          aria-busy={pasting}
          aria-placeholder={placeholderText}
          contentEditable={!inputBlocked}
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          translate="no"
          onPaste={onPaste}
          onContextMenu={onContextMenu}
          onBeforeInput={(event) => {
            const native = event.nativeEvent as InputEvent;
            if (
              native.inputType === "insertParagraph" ||
              native.inputType === "insertLineBreak"
            ) {
              event.preventDefault();
              onInsertNewline();
            }
          }}
          onInput={(event) => {
            const element = event.currentTarget;
            const source = readEditorValue(element);
            const { start } = editorSelectionRange(element);
            const native = event.nativeEvent as InputEvent;
            // An input outside a composition proves the previous one ended,
            // even when the IME never sent compositionend (#929).
            if (!native.isComposing) onSettledInput();
            sendPredictionFeedback(false);
            setWordSuggestion(null);
            setPredictionInput({ text: source, cursor: start, composing: native.isComposing });
            onInput(source, start, native.isComposing);
          }}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={(event) => {
            const element = event.currentTarget;
            const source = readEditorValue(element);
            const { start } = editorSelectionRange(element);
            sendPredictionFeedback(false);
            setWordSuggestion(null);
            setPredictionInput({ text: source, cursor: start, composing: false });
            onCompositionEnd(event);
            onInput(source, start, false);
          }}
          onFocus={onFocus}
          onBlur={() => { sendPredictionFeedback(false); setWordSuggestion(null); onBlur(); }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
            // An Enter that confirms an IME candidate must commit text, never
            // send it or drive autocomplete (D125).
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (wordSuggestion && event.key === "Tab" && !event.shiftKey && !composerAc.hasItems && !composerAc.open && !suggestion) {
              event.preventDefault();
              const editor = inputRef.current;
              if (!editor) return;
              const currentText = readEditorValue(editor);
              const currentRange = editorSelectionRange(editor);
              if (currentText.length !== currentRange.start || currentRange.start !== currentRange.end) { setWordSuggestion(null); return; }
              setWordSuggestion(null);
              document.execCommand("insertText", false, wordSuggestion.text);
              const nextText = readEditorValue(editor);
              const { start } = editorSelectionRange(editor);
              const accepted = nextText === `${currentText}${wordSuggestion.text}`;
              sendPredictionFeedback(accepted);
              if (!accepted) return;
              setPredictionInput({ text: nextText, cursor: start, composing: false });
              onInput(nextText, start, false);
              return;
            }
            if (event.key === "Enter" && event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              composerAc.close();
              onSubmit(runActive);
              return;
            }
            if (composerAc.open && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              composerAc.close();
              return;
            }
            if (composerAc.hasItems) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const count = composerAc.items.length;
                composerAc.setHighlight(
                  (composerAc.highlight + delta + count) % count,
                );
                return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault();
                onAcceptCompletion(composerAc.highlight);
                return;
              }
            }
            // A completion list owns `Tab` and the first `Escape`; the plugin
            // suggestion only acts once neither claims the key.
            const suggestionAction = composerSuggestionKeyAction(event, {
              suggestion: suggestion !== null,
              completionItems: composerAc.hasItems,
              completionOpen: composerAc.open,
            });
            if (suggestionAction) {
              event.preventDefault();
              if (suggestionAction === "accept") suggestion?.accept();
              else suggestion?.dismiss();
              return;
            }
            if (
              (event.key === "ArrowUp" || event.key === "ArrowDown") &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              onHistoryNavigate(event.key === "ArrowUp" ? "older" : "newer")
            ) {
              event.preventDefault();
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              (enterToSend || event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {wordSuggestion ? <span className="composer-omp-word-suggestion" aria-hidden="true" style={{ left: wordSuggestion.left, top: wordSuggestion.top }}>{wordSuggestion.text}</span> : null}
        {/* The plugin suggestion (`pi.composer.suggest`) rides in the
          placeholder layer — never a bubble — and only while the draft is
          empty, which is what makes Tab a plain "write this for me". */}
        {value.length === 0 ? (
          suggestion ? (
            <span
              key={`suggestion-${suggestion.text}`}
              className="composer-placeholder composer-placeholder-suggestion"
              aria-hidden="true"
            >
              <span className="composer-suggestion-text">{suggestion.text}</span>
              <span className="composer-suggestion-hint">{suggestion.hint}</span>
            </span>
          ) : (
            <span
              key={placeholderKey}
              className="composer-placeholder"
              aria-hidden="true"
            >
              {placeholderText}
            </span>
          )
        ) : null}
        {/* The visible line is decoration; the live region is what a screen
          reader announces, once, without stealing focus. */}
        {suggestion ? (
          <span className="sr-only" role="status" aria-live="polite">
            {suggestion.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export type ComposerInputStateSetters = {
  setComposing: Dispatch<SetStateAction<boolean>>;
  setInputFocused: Dispatch<SetStateAction<boolean>>;
};
