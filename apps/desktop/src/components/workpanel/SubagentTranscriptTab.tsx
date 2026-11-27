import { Fragment, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowDown, IconBot, IconChevronDown } from "../icons";
import { Textarea, TooltipButton } from "../ui";
import { AssistantTurnBody } from "../../features/chat/transcript/AssistantTurnBody";
import { CollapsibleUserText } from "../../features/chat/transcript/CollapsibleUserText";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { TranscriptDisclosureProvider } from "../../features/chat/transcript/disclosure";
import { delegateModelId, delegateThinkingLevel } from "../../features/chat/transcript/model";
import { useFollowScroll } from "../../hooks/use-follow-scroll";
import { useTranscriptSearchFocus } from "../../hooks/use-transcript-search-focus";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { DisclosureAnchorContext } from "../../lib/disclosure-anchor-context";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import { collectDelegationStatuses, delegationIsCreating, subagentOutcome } from "../../lib/subagent-topology";
import { buildSubagentTranscript } from "../../lib/subagent-transcript";
import { TranscriptSearchContext } from "../../lib/transcript-search-context";
import { SlotSessionProvider } from "../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../stores/app-store";

/** The selected delegate uses the same process and answer renderer as the main transcript. */
export function SubagentTranscriptTab({ delegationId }: { delegationId: string }) {
  const sessionId = useAppStore((state) => state.activeSessionId);
  if (!sessionId) return null;
  return (
    <SlotSessionProvider sessionId={sessionId}>
      <TranscriptDisclosureProvider
        key={JSON.stringify([sessionId, delegationId])}
        sessionId={sessionId}
      >
        <SubagentTranscriptSurface sessionId={sessionId} delegationId={delegationId} />
      </TranscriptDisclosureProvider>
    </SlotSessionProvider>
  );
}

function SubagentTranscriptSurface({ sessionId, delegationId }: { sessionId: string; delegationId: string }) {
  const { t } = useTranslation();
  const { messages, focus } = useTranscriptView(sessionId);
  const parentRunning = useAppStore((state) => state.runningSessions[sessionId] ?? false);
  const transcript = useMemo(() => buildSubagentTranscript(messages, delegationId), [messages, delegationId]);
  const statuses = useMemo(() => collectDelegationStatuses(
    messages.filter((message) => message.role === "tool").map((message) => ({ kind: "tool" as const, message })),
    { turnLive: parentRunning },
  ), [messages, parentRunning]);
  const latest = transcript?.turns.at(-1)?.call;
  const outcome = latest ? subagentOutcome(latest, statuses) : undefined;
  const running = Boolean(latest && parentRunning && outcome === "running");
  const stopId = latest && running && !delegationIsCreating(latest)
    ? delegationIdForMessage(latest)
    : undefined;
  const modelId = latest ? delegateModelId(latest) : "";
  const thinkingLevel = latest ? delegateThinkingLevel(latest) : undefined;
  const modelDetails = [
    modelId && `${t("chat.model")}: ${modelId}`,
    thinkingLevel && `${t("chat.reasoningLevel")}: ${thinkingLevel}`,
  ].filter(Boolean).join(" · ");
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    releaseFollow,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  const searchMessage = useMemo(() => focus && transcript?.turns
    .flatMap((turn) => turn.messages)
    .find((message) => message.id === focus.messageId), [focus, transcript]);
  const searchTarget = searchMessage ? focus : null;
  useTranscriptSearchFocus({
    target: searchTarget,
    source: searchMessage?.content ?? "",
    scrollRef,
    contentRef,
    contentVersion: transcript,
    onNavigate: releaseFollow,
  });

  useLayoutEffect(() => {
    if (!searchTarget) jumpToLatest();
  }, [jumpToLatest, searchTarget]);

  useLayoutEffect(() => {
    scheduleFollowScroll();
  }, [transcript, scheduleFollowScroll]);

  return (
    <TranscriptSearchContext.Provider value={searchTarget}>
      <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
        <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
          <div
            ref={scrollRef}
            data-scroll-owner="follow"
            className="subagent-transcript-scroll"
            onScroll={handleScroll}
            role="log"
            aria-live="polite"
            aria-label={t("panel.subagent")}
            tabIndex={0}
          >
            <div ref={contentRef} className="subagent-transcript-list">
              {transcript ? transcript.turns.map(({ call, task, reply }) => (
                <Fragment key={reply.id}>
                  <div className="message-row user">
                    <div className="message-col">
                      <div className="message-bubble">
                        <CollapsibleUserText messageId={call.id} dir="auto">
                          {task || t("panel.subagentTaskEmpty")}
                        </CollapsibleUserText>
                      </div>
                    </div>
                  </div>
                  {reply.parts.length > 0 ? (
                    <div className="message-row assistant assistant-turn" role="article" aria-label={t("chat.assistantMessage")}>
                      <div className="message-col">
                        <AssistantTurnBody
                          entry={reply}
                          isActive={call === latest && running}
                          outcome={subagentOutcome(call, statuses)}
                        />
                      </div>
                    </div>
                  ) : null}
                </Fragment>
              )) : (
                <div className="subagent-transcript-empty" role="status">{t("panel.subagentEmpty")}</div>
              )}
            </div>
          </div>
          {showJump ? (
            <TooltipButton
              type="button"
              className="jump-latest-btn subagent-transcript-jump"
              tooltip={t("chat.scrollToBottom")}
              ariaLabel={t("chat.scrollToBottom")}
              onClick={jumpToLatest}
            >
              <IconArrowDown size={14} />
            </TooltipButton>
          ) : null}
          <footer className="subagent-transcript-composer">
            <Textarea disabled rows={2} aria-label={t("panel.subagentReadOnly")} placeholder={t("panel.subagentReadOnly")} />
            {modelDetails || stopId ? (
              <div className="subagent-transcript-composer-controls">
                {modelDetails ? (
                  <button
                    type="button"
                    className="icon-btn composer-model-thinking-chip subagent-transcript-model-picker"
                    disabled
                    aria-haspopup="listbox"
                    aria-label={`${t("chat.model")}: ${modelId || "—"}. ${t("chat.reasoningLevel")}: ${thinkingLevel || "—"}`}
                  >
                    <span className="composer-model-thinking-icon" aria-hidden="true"><IconBot size={14} /></span>
                    <span className="composer-model-thinking-model">{modelId || "—"}</span>
                    <span className="composer-model-thinking-level">{thinkingLevel || "—"}</span>
                    <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
                  </button>
                ) : null}
                {stopId ? <SubagentStopButton delegationId={stopId} name={transcript?.agentName} running compact /> : null}
              </div>
            ) : null}
          </footer>
        </div>
      </DisclosureAnchorContext.Provider>
    </TranscriptSearchContext.Provider>
  );
}
