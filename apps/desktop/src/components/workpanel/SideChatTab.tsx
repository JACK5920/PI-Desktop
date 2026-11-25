import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { AskToolCard } from "../AskToolCard";
import { Button, Textarea, TooltipButton } from "../ui";
import {
  IconArrowUp,
  IconClose,
  IconExternal,
  IconFileText,
  IconImage,
  IconInfo,
  IconNewSession,
  IconPlus,
  IconStop,
  IconTextSelect,
} from "../icons";
import { ChatTranscript } from "../../features/chat/transcript/ChatTranscript";
import { ComposerAnnotationAttachments } from "../../features/chat/composer/ComposerAnnotationAttachments";
import { createFileReference } from "../../features/chat/composer/editor";
import { draftFileReference } from "../../lib/composer-draft-cache";
import { api } from "../../lib/api";
import { headAsk, queuedAskCount } from "../../lib/pending-asks";
import { headPermission, queuedPermissionCount } from "../../lib/pending-permissions";
import { requestTextWithoutAnnotations } from "../../lib/response-annotations";
import type { ResponseAnnotation } from "../../lib/response-annotations";
import {
  appendSideChatDraftText,
  formatSideChatResultQuote,
} from "../../lib/side-chat-lifecycle";
import { sessionAllows } from "../../lib/remote-session-safety";
import { transcriptSelectionSourceAttribution } from "../../lib/transcript-selection";
import type { TranscriptSearchTarget } from "../../lib/transcript-reading";
import {
  navigateToAnnotationSource,
  type AnnotationSourceTarget,
} from "../../lib/annotation-source-navigation";
import { composerDraftBridge } from "../../features/chat/composer/plugins/draft-bridge";
import { useAppStore } from "../../stores/app-store";

const EMPTY_ANNOTATIONS: readonly ResponseAnnotation[] = [];

export function SideChatTab({ sideChatId }: { sideChatId: string }) {
  const { t } = useTranslation();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const sourceContextRef = useRef<HTMLDivElement>(null);
  const pickerInFlight = useRef(false);
  const nextSourceRequestId = useRef(0);
  const [sourceSearchTarget, setSourceSearchTarget] = useState<TranscriptSearchTarget | null>(null);
  const [sourcePreviewOpen, setSourcePreviewOpen] = useState(false);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sideChat = useAppStore((state) => state.sideChats[sideChatId]);
  const setDraft = useAppStore((state) => state.setSideChatDraft);
  const setFileReferences = useAppStore((state) => state.setSideChatFileReferences);
  const ensureChild = useAppStore((state) => state.ensureSideChatChild);
  const send = useAppStore((state) => state.sendSideChatPrompt);
  const close = useAppStore((state) => state.closeSideChat);
  const promote = useAppStore((state) => state.promoteSideChatToConversation);
  const abortSession = useAppStore((state) => state.abortSession);
  const showToast = useAppStore((state) => state.showToast);
  const parentSession = useAppStore((state) =>
    sideChat ? state.sessions.find((session) => session.id === sideChat.parentSessionId) : undefined,
  );
  const attachmentsAllowed = sessionAllows(parentSession, "canAttach");
  const sideChatReferences = useAppStore((state) =>
    state.sideChats[sideChatId]?.references ?? EMPTY_ANNOTATIONS,
  );
  const childReferences = useAppStore((state) => {
    const childSessionId = state.sideChats[sideChatId]?.childSessionId;
    return childSessionId ? state.responseAnnotations[childSessionId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS;
  });
  const editResponseAnnotation = useAppStore((state) => state.editResponseAnnotation);
  const removeResponseAnnotation = useAppStore((state) => state.removeResponseAnnotation);
  const clearResponseAnnotations = useAppStore((state) => state.clearResponseAnnotations);
  const editSideChatReference = useAppStore((state) => state.editSideChatReference);
  const removeSideChatReference = useAppStore((state) => state.removeSideChatReference);
  const clearSideChatReferences = useAppStore((state) => state.clearSideChatReferences);
  const running = useAppStore((state) =>
    sideChat?.childSessionId ? state.runningSessions[sideChat.childSessionId] === true : false,
  );
  const pendingPermission = useAppStore((state) =>
    sideChat?.childSessionId ? headPermission(state.pendingPermissions, sideChat.childSessionId) : undefined,
  );
  const queuedPermissions = useAppStore((state) =>
    sideChat?.childSessionId ? queuedPermissionCount(state.pendingPermissions, sideChat.childSessionId) : 0,
  );
  const pendingAsk = useAppStore((state) =>
    sideChat?.childSessionId ? headAsk(state.pendingAsks, sideChat.childSessionId) : undefined,
  );
  const queuedAsks = useAppStore((state) =>
    sideChat?.childSessionId ? queuedAskCount(state.pendingAsks, sideChat.childSessionId) : 0,
  );
  const fileReferences = sideChat?.fileReferences ?? [];
  const latestAnswer = useMemo(
    () => [...(sideChat?.messages ?? [])].reverse().find((message) =>
      message.role === "assistant" && message.content?.trim() && message.status !== "streaming",
    ),
    [sideChat?.messages],
  );
  const referenceAttachments = useMemo(
    () => [...childReferences, ...sideChatReferences],
    [childReferences, sideChatReferences],
  );

  useEffect(() => {
    if (!sourcePreviewOpen) return;
    const outside = (event: PointerEvent) => {
      if (!sourceContextRef.current?.contains(event.target as Node)) setSourcePreviewOpen(false);
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSourcePreviewOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [sourcePreviewOpen]);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [sideChat?.draftText]);

  const navigateWithinSideChat = (target: AnnotationSourceTarget) => {
    const current = useAppStore.getState().sideChats[sideChatId];
    if (current?.childSessionId && target.sessionId === current.childSessionId) {
      setSourceSearchTarget({ ...target, requestId: ++nextSourceRequestId.current });
      return;
    }
    void navigateToAnnotationSource(target, () => useAppStore.getState()).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    });
  };

  const editReference = (referenceId: string, comment?: string) => {
    const childSessionId = useAppStore.getState().sideChats[sideChatId]?.childSessionId;
    if (childSessionId && childReferences.some((reference) => reference.id === referenceId)) {
      editResponseAnnotation(childSessionId, referenceId, comment);
    } else {
      editSideChatReference(sideChatId, referenceId, comment);
    }
  };
  const removeReference = (referenceId: string) => {
    const childSessionId = useAppStore.getState().sideChats[sideChatId]?.childSessionId;
    if (childSessionId && childReferences.some((reference) => reference.id === referenceId)) {
      removeResponseAnnotation(childSessionId, referenceId);
    } else {
      removeSideChatReference(sideChatId, referenceId);
    }
  };
  const clearReferences = () => {
    clearSideChatReferences(sideChatId);
    const childSessionId = useAppStore.getState().sideChats[sideChatId]?.childSessionId;
    if (childSessionId) clearResponseAnnotations(childSessionId);
  };

  if (!sideChat) return null;
  const childSessionId = sideChat.childSessionId;
  const isCreatingChild = sideChat.status === "forking";
  const isSubmitting = submitting || sideChat.status === "sending";
  const canSubmit = Boolean(sideChat.draftText.trim() || fileReferences.length);
  const hasChildTranscript = Boolean(childSessionId && sideChat.messages.length > 0);

  const appendAnswerToParent = () => {
    if (!latestAnswer?.content) return;
    const result = requestTextWithoutAnnotations(latestAnswer.content);
    const quotedResult = formatSideChatResultQuote(
      result,
      t("chat.sideChatSource", { messageId: latestAnswer.id }),
    );
    if (!quotedResult) return;
    try {
      composerDraftBridge.appendTextForSession(
        sideChat.parentSessionId,
        `${t("chat.sideChatResultTitle")}\n\n${quotedResult}`,
      );
      showToast(t("chat.sideChatAddedToMain"), { variant: "success" });
    } catch {
      showToast(t("chat.sideChatAddToMainFailed"), { variant: "error" });
    }
  };

  const attachFiles = async () => {
    if (pickerInFlight.current || preparingAttachments || !attachmentsAllowed) return;
    pickerInFlight.current = true;
    setPreparingAttachments(true);
    setAttachmentError(null);
    try {
      const result = await api.pickFiles();
      if (result.canceled || !result.token) return;
      if (!useAppStore.getState().sideChats[sideChatId]) return;
      const targetSessionId = await ensureChild(sideChatId);
      if (!useAppStore.getState().sideChats[sideChatId]) return;
      if (!targetSessionId) {
        throw new Error(t("chat.sideChatForkFailed"));
      }
      const target = useAppStore.getState().sessions.find((session) => session.id === targetSessionId);
      if (!sessionAllows(target, "canAttach")) throw new Error(t("chat.sideChatAttachmentUnavailable"));
      const imported = await api.importFiles(targetSessionId, result.token);
      if (!useAppStore.getState().sideChats[sideChatId]) return;
      const importedReferences = imported.files.map((file) => {
        const reference = createFileReference(file.path, file.name, targetSessionId, {
          kind: file.kind,
          mimeType: file.mimeType,
        });
        return draftFileReference(reference);
      });
      if (importedReferences.length) {
        const latest = useAppStore.getState().sideChats[sideChatId];
        if (!latest) return;
        setFileReferences(sideChatId, [...(latest.fileReferences ?? []), ...importedReferences]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAttachmentError(message);
      showToast(message, { variant: "error" });
    } finally {
      pickerInFlight.current = false;
      setPreparingAttachments(false);
    }
  };

  const submitPrompt = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const current = useAppStore.getState().sideChats[sideChatId];
    if (!current || preparingAttachments || submitting || current.status === "sending" || current.status === "forking") return;
    const submittedReferences = current.fileReferences ?? [];
    if (!current.draftText.trim() && submittedReferences.length === 0) return;
    setSubmitting(true);
    void send(sideChatId, current.draftText, submittedReferences)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setAttachmentError(message);
        showToast(message, { variant: "error" });
      })
      .finally(() => setSubmitting(false));
  };

  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
    const enterToSend = useAppStore.getState().settings?.enterToSend ?? true;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (enterToSend || event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const navigateToOriginalSelection = () => {
    setSourcePreviewOpen(false);
    navigateWithinSideChat({
      sessionId: sideChat.parentSessionId,
      messageId: sideChat.sourceMessageId,
      query: sideChat.excerpt,
    });
  };

  return (
    <div className="side-chat-tab" data-testid="side-chat-tab" data-side-chat-id={sideChatId}>
      {childSessionId ? (
        <div className="side-chat-header" aria-label={t("chat.sideChatActions")}>
          <div className="side-chat-header-actions">
            {latestAnswer ? (
              <TooltipButton
                type="button"
                className="side-chat-icon-action"
                tooltip={t("chat.sideChatAddToMain")}
                ariaLabel={t("chat.sideChatAddToMain")}
                onClick={appendAnswerToParent}
              >
                <IconArrowUp size={14} aria-hidden />
              </TooltipButton>
            ) : null}
            <TooltipButton
              type="button"
              className="side-chat-icon-action"
              tooltip={t("chat.sideChatOpenConversation")}
              ariaLabel={t("chat.sideChatOpenConversation")}
              onClick={() => void promote(sideChatId)}
            >
              <IconExternal size={14} aria-hidden />
            </TooltipButton>
            <TooltipButton
              type="button"
              className="work-panel-tab-close"
              tooltip={t("panel.closeTab", { name: t("panel.tabs.sideChat") })}
              ariaLabel={t("panel.closeTab", { name: t("panel.tabs.sideChat") })}
              onClick={() => close(sideChatId)}
            >
              <IconClose size={14} aria-hidden />
            </TooltipButton>
          </div>
        </div>
      ) : null}

      {hasChildTranscript && childSessionId ? (
        <div className="side-chat-transcript">
          <ChatTranscript
            sessionId={childSessionId}
            messages={sideChat.messages}
            searchTarget={sourceSearchTarget}
            onNavigateToSource={navigateWithinSideChat}
            isRunning={running}
            pendingPermission={pendingPermission}
            queuedPermissions={queuedPermissions}
            askPending={Boolean(pendingAsk)}
            paneVisible
            liveTail
            allowHistoryMutations={false}
            permissionFocusTarget={() => promptRef.current}
            allowSideChatSelection={false}
            onAppendUserSelection={(selection) => {
              const current = useAppStore.getState().sideChats[sideChatId];
              if (!current || current.childSessionId !== selection.sessionId) return;
              setDraft(
                sideChatId,
                appendSideChatDraftText(
                  current.draftText,
                  selection.excerpt,
                  transcriptSelectionSourceAttribution(
                    selection.messageIds,
                    t("chat.selectionSourceUser"),
                  ),
                ),
              );
            }}
          />
          {pendingAsk ? <AskToolCard request={pendingAsk} queued={queuedAsks} /> : null}
        </div>
      ) : (
        <div className="side-chat-empty" data-testid="side-chat-empty">
          <span className="side-chat-empty-icon" aria-hidden="true"><IconNewSession size={21} /></span>
          <strong>{t("chat.sideChatTitle")}</strong>
          <p>{t("chat.sideChatEmptyDescription")}</p>
        </div>
      )}

      {sideChat.error ? <div className="side-chat-error" role="alert">{sideChat.error}</div> : null}

      <form
        ref={formRef}
        className="side-chat-composer"
        onSubmit={submitPrompt}
      >
        <div className="side-chat-composer-shell">
          <div className="side-chat-composer-contexts">
            <div
              className="side-chat-source-context"
              ref={sourceContextRef}
              onPointerEnter={() => setSourcePreviewOpen(true)}
              onPointerLeave={(event) => {
                if (
                  !sourceContextRef.current?.contains(event.relatedTarget as Node | null) &&
                  !sourceContextRef.current?.matches(":focus-within")
                ) setSourcePreviewOpen(false);
              }}
              onFocusCapture={() => setSourcePreviewOpen(true)}
              onBlur={(event) => {
                if (
                  !sourceContextRef.current?.matches(":hover") &&
                  !sourceContextRef.current?.contains(event.relatedTarget as Node | null)
                ) setSourcePreviewOpen(false);
              }}
            >
              <button
                type="button"
                className="side-chat-source-context-chip"
                aria-expanded={sourcePreviewOpen}
                aria-haspopup="dialog"
                aria-label={t("chat.sideChatContextLabel")}
                data-testid="side-chat-context-chip"
                onClick={() => setSourcePreviewOpen(true)}
              >
                <IconTextSelect size={13} aria-hidden />
                <span>{t("chat.sideChatContextLabel")}</span>
              </button>
              {sourcePreviewOpen ? (
                <div
                  className="side-chat-source-preview"
                  role="dialog"
                  aria-label={t("chat.sideChatContextPreview")}
                  data-testid="side-chat-source-preview"
                >
                  <div className="side-chat-source-preview-label">{t("chat.sideChatContextPreview")}</div>
                  <p>{sideChat.excerpt}</p>
                  <Button type="button" size="sm" onClick={navigateToOriginalSelection}>
                    {t("chat.sideChatOpenSource")}
                  </Button>
                </div>
              ) : null}
            </div>
            <ComposerAnnotationAttachments
              sessionId={childSessionId ?? sideChat.parentSessionId}
              annotations={referenceAttachments}
              attachmentLabel={t("chat.sideChatSelectedTextReferences", { count: referenceAttachments.length })}
              onEditAnnotation={editReference}
              onRemoveAnnotation={removeReference}
              onClearAnnotations={clearReferences}
              onNavigateToSource={navigateWithinSideChat}
            />
          </div>

          {fileReferences.length ? (
            <div className="side-chat-file-attachments" aria-label={t("chat.sideChatAttachments")}>
              {fileReferences.map((reference, index) => (
                <span className="side-chat-file-chip" key={`${reference.path}:${index}`}>
                  {reference.kind === "image" ? <IconImage size={14} aria-hidden /> : <IconFileText size={14} aria-hidden />}
                  <span className="side-chat-file-name">{reference.name}</span>
                  <TooltipButton
                    type="button"
                    className="side-chat-file-remove"
                    tooltip={t("chat.removeFileReference", { name: reference.name })}
                    ariaLabel={t("chat.removeFileReference", { name: reference.name })}
                    onClick={() => {
                      const latest = useAppStore.getState().sideChats[sideChatId];
                      if (!latest) return;
                      setFileReferences(sideChatId, (latest.fileReferences ?? []).filter((_, itemIndex) => itemIndex !== index));
                    }}
                  >
                    <IconClose size={12} aria-hidden />
                  </TooltipButton>
                </span>
              ))}
            </div>
          ) : null}

          <Textarea
            ref={promptRef}
            value={sideChat.draftText}
            className="side-chat-prompt-input"
            onChange={(event) => setDraft(sideChatId, event.currentTarget.value)}
            onKeyDown={onPromptKeyDown}
            onInput={(event) => {
              const textarea = event.currentTarget;
              textarea.style.height = "auto";
              textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
            }}
            placeholder={t("chat.sideChatPlaceholder")}
            aria-label={t("chat.sideChatPrompt")}
            aria-describedby="side-chat-composer-hint"
            rows={2}
            data-testid="side-chat-prompt"
          />
          <div className="side-chat-composer-toolbar">
            <div className="side-chat-composer-tools">
              <TooltipButton
                type="button"
                className="side-chat-add-files"
                tooltip={t("chat.addFiles")}
                ariaLabel={t("chat.addFiles")}
                disabled={!attachmentsAllowed || preparingAttachments || isSubmitting}
                onClick={() => void attachFiles()}
                data-testid="side-chat-add-files"
              >
                <IconPlus size={16} aria-hidden />
              </TooltipButton>
              <TooltipButton
                type="button"
                className="side-chat-inherited-settings"
                tooltip={t("chat.sideChatInheritsParentSettings")}
                ariaLabel={t("chat.sideChatInheritsParentSettings")}
              >
                <IconInfo size={14} aria-hidden />
                <span>{t("chat.sideChatInheritedSettingsLabel")}</span>
              </TooltipButton>
            </div>
            <div className="side-chat-composer-actions">
              {attachmentError ? <span className="side-chat-attachment-error" role="alert">{attachmentError}</span> : null}
              {preparingAttachments ? <span className="side-chat-preparing" role="status">{t("chat.sideChatPreparingAttachments")}</span> : null}
              {running && childSessionId ? (
                <TooltipButton
                  type="button"
                  className="side-chat-stop-button"
                  tooltip={t("chat.stop")}
                  ariaLabel={t("chat.stop")}
                  onClick={() => void abortSession(childSessionId)}
                  data-testid="side-chat-stop"
                >
                  <IconStop size={14} aria-hidden />
                </TooltipButton>
              ) : null}
              <TooltipButton
                type="submit"
                className="side-chat-send-button"
                tooltip={isCreatingChild || preparingAttachments ? t("chat.sideChatStarting") : t("chat.send")}
                ariaLabel={isCreatingChild ? t("chat.sideChatStarting") : t("chat.send")}
                disabled={!canSubmit || isSubmitting || isCreatingChild || preparingAttachments}
                data-testid="side-chat-send"
              >
                <IconArrowUp size={16} aria-hidden />
              </TooltipButton>
            </div>
          </div>
          <span id="side-chat-composer-hint" className="side-chat-composer-hint">
            {t("chat.sideChatInheritsParentSettings")}
          </span>
        </div>
      </form>
    </div>
  );
}
