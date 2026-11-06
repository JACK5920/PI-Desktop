import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskToolCard } from "../AskToolCard";
import { Button, Textarea, TooltipButton } from "../ui";
import { IconArrowUp, IconClose, IconStop } from "../icons";
import { ChatTranscript } from "../../features/chat/transcript/ChatTranscript";
import { headAsk, queuedAskCount } from "../../lib/pending-asks";
import { headPermission, queuedPermissionCount } from "../../lib/pending-permissions";
import { requestTextWithoutAnnotations } from "../../lib/response-annotations";
import {
  appendSideChatDraftText,
  formatSideChatResultQuote,
} from "../../lib/side-chat-lifecycle";
import { transcriptSelectionSourceAttribution } from "../../lib/transcript-selection";
import { composerDraftBridge } from "../../features/chat/composer/plugins/draft-bridge";
import { ComposerAnnotationAttachments } from "../../features/chat/composer/ComposerAnnotationAttachments";
import { useAppStore } from "../../stores/app-store";

export function SideChatTab({ sideChatId }: { sideChatId: string }) {
  const { t } = useTranslation();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const sideChat = useAppStore((state) => state.sideChats[sideChatId]);
  const setDraft = useAppStore((state) => state.setSideChatDraft);
  const send = useAppStore((state) => state.sendSideChatPrompt);
  const close = useAppStore((state) => state.closeSideChat);
  const promote = useAppStore((state) => state.promoteSideChatToConversation);
  const abortSession = useAppStore((state) => state.abortSession);
  const showToast = useAppStore((state) => state.showToast);
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
        {childSessionId ? <ComposerAnnotationAttachments sessionId={childSessionId} /> : null}
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
