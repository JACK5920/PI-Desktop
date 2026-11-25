import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskToolCard } from "../AskToolCard";
import { Button, Textarea, TooltipButton } from "../ui";
import { IconArrowUp, IconClose, IconStop } from "../icons";
import { ChatTranscript } from "../../features/chat/transcript/ChatTranscript";
import { headAsk, queuedAskCount } from "../../lib/pending-asks";
import { headPermission, queuedPermissionCount } from "../../lib/pending-permissions";
import { requestTextWithoutAnnotations } from "../../lib/response-annotations";
import type { ResponseAnnotation } from "../../lib/response-annotations";
import {
  appendSideChatDraftText,
  formatSideChatResultQuote,
} from "../../lib/side-chat-lifecycle";
import { transcriptSelectionSourceAttribution } from "../../lib/transcript-selection";
import type { TranscriptSearchTarget } from "../../lib/transcript-reading";
import {
  navigateToAnnotationSource,
  type AnnotationSourceTarget,
} from "../../lib/annotation-source-navigation";
import { composerDraftBridge } from "../../features/chat/composer/plugins/draft-bridge";
import { ComposerAnnotationAttachments } from "../../features/chat/composer/ComposerAnnotationAttachments";
import { useAppStore } from "../../stores/app-store";

const EMPTY_ANNOTATIONS: readonly ResponseAnnotation[] = [];

export function SideChatTab({ sideChatId }: { sideChatId: string }) {
  const { t } = useTranslation();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const nextSourceRequestId = useRef(0);
  const [sourceSearchTarget, setSourceSearchTarget] = useState<TranscriptSearchTarget | null>(null);
  const sideChat = useAppStore((state) => state.sideChats[sideChatId]);
  const setDraft = useAppStore((state) => state.setSideChatDraft);
  const send = useAppStore((state) => state.sendSideChatPrompt);
  const close = useAppStore((state) => state.closeSideChat);
  const promote = useAppStore((state) => state.promoteSideChatToConversation);
  const abortSession = useAppStore((state) => state.abortSession);
  const showToast = useAppStore((state) => state.showToast);
  const sideChatReferences = useAppStore((state) => state.sideChats[sideChatId]?.references ?? EMPTY_ANNOTATIONS);
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
  const [submitting, setSubmitting] = useState(false);
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
  const navigateReference = navigateWithinSideChat;

  if (!sideChat) return null;
  const childSessionId = sideChat.childSessionId;
  const isCreatingChild = sideChat.status === "forking";
  const isSubmitting = submitting || sideChat.status === "sending";
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

  return (
    <div className="side-chat-tab" data-testid="side-chat-tab" data-side-chat-id={sideChatId}>
      <header className="side-chat-header">
        <div className="side-chat-heading">
          <strong>{t("chat.sideChatTitle")}</strong>
          <span>{t("chat.sideChatSource", {
            messageId: (sideChat.sourceMessageIds ?? [sideChat.sourceMessageId]).join(", "),
          })}</span>
        </div>
        <div className="side-chat-header-actions">
          {sideChat.childSessionId ? (
            <Button type="button" size="sm" onClick={() => void promote(sideChatId)}>
              {t("chat.sideChatOpenConversation")}
            </Button>
          ) : null}
          <TooltipButton
            type="button"
            className="work-panel-tab-close"
            tooltip={t("panel.closeTab", { name: t("panel.tabs.sideChat") })}
            ariaLabel={t("panel.closeTab", { name: t("panel.tabs.sideChat") })}
            onClick={() => close(sideChatId)}
          >
            <IconClose size={14} />
          </TooltipButton>
        </div>
      </header>

      <div className="side-chat-excerpt" aria-label={t("chat.sideChatExcerpt")}>
        <blockquote>{sideChat.excerpt}</blockquote>
      </div>

      {sideChat.childSessionId ? (
        <div className="side-chat-transcript">
          <ChatTranscript
            sessionId={sideChat.childSessionId}
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
      ) : null}

      {sideChat.error ? <div className="side-chat-error" role="alert">{sideChat.error}</div> : null}

      <form
        className="side-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!sideChat.draftText.trim() || isSubmitting) return;
          setSubmitting(true);
          void send(sideChatId, sideChat.draftText).finally(() => setSubmitting(false));
        }}
      >
        <ComposerAnnotationAttachments
          sessionId={childSessionId ?? sideChat.parentSessionId}
          annotations={referenceAttachments}
          attachmentLabel={t("chat.sideChatSelectedTextReferences", { count: referenceAttachments.length })}
          onEditAnnotation={editReference}
          onRemoveAnnotation={removeReference}
          onClearAnnotations={clearReferences}
          onNavigateToSource={navigateReference}
        />
        <Textarea
          ref={promptRef}
          value={sideChat.draftText}
          onChange={(event) => setDraft(sideChatId, event.currentTarget.value)}
          placeholder={t("chat.sideChatPlaceholder")}
          aria-label={t("chat.sideChatPrompt")}
          rows={4}
          data-testid="side-chat-prompt"
        />
        <div className="side-chat-composer-actions">
          {latestAnswer ? (
            <Button type="button" size="sm" onClick={appendAnswerToParent}>
              {t("chat.sideChatAddToMain")}
            </Button>
          ) : null}
          {running && childSessionId ? (
            <Button
              type="button"
              size="sm"
              onClick={() => void abortSession(childSessionId)}
            >
              <IconStop size={14} />
              {t("chat.stop")}
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!sideChat.draftText.trim() || isSubmitting || isCreatingChild}
            data-testid="side-chat-send"
          >
            <IconArrowUp size={14} />
            {isCreatingChild ? t("chat.sideChatStarting") : t("chat.send")}
          </Button>
        </div>
      </form>
    </div>
  );
}
