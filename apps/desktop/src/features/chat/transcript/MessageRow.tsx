import {
  memo,
  useMemo,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { splitComposerDirectoryPrompt, splitInlineContent } from "@pi-desktop/shared";
import { DirectoryReferenceCard } from "../DirectoryReferenceCard";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { sessionAllows } from "../../../lib/remote-session-safety";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconTrash,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { userMessageMenuItems } from "./menu-items";
import { ActionSlotSide } from "./ActionBarSlots";
import { slotMessage } from "../../../plugins/renderer-slots/slot-message";
import { SessionMessageOrigin } from "./SessionMessageOrigin";
import {
  CopyButton,
  FileRefChip,
  LinkifiedText,
  MessageAttachmentImage,
  MessageTimestamp,
} from "./shared";
import {
  useChatTextActions,
  useTranscriptMenu,
} from "./TranscriptMenu";
import { getExtraMessageAttachments } from "./extra-attachments";
import {
  annotationsForAssistantMessage,
  annotationsForSourceMessage,
  buildAnnotatedPrompt,
  parseAnnotatedPrompt,
  pendingSourceAnnotationsForMessage,
  prepareAnnotatedPromptEdit,
  requestTextWithoutAnnotations,
  transcriptMessagesForSession,
  type ParsedResponseAnnotation,
  type ResponseAnnotation,
  type IndexedSourceResponseAnnotation,
} from "../../../lib/response-annotations";
import { MessageAnnotationSummary } from "./MessageAnnotationSummary";
import { SourceAnnotationMarkers } from "./SourceAnnotationMarkers";
import { useTranscriptHistoryActionsAllowed } from "./transcript-action-scope";

const EMPTY_RESPONSE_ANNOTATIONS: readonly ParsedResponseAnnotation[] = [];
const EMPTY_SOURCE_RESPONSE_ANNOTATIONS: readonly IndexedSourceResponseAnnotation[] = [];
const EMPTY_PENDING_RESPONSE_ANNOTATIONS: readonly ResponseAnnotation[] = [];

function SkillInvocationText({ message }: { message: UiMessage }) {
  const command = message.command ?? "";
  const mentions = [
    ...(message.skillMentions ?? []).map((mention) => ({ ...mention, label: mention.id, kind: "skill" as const })),
    ...(message.agentMentions ?? []).map((mention) => ({ ...mention, label: mention.name, kind: "agent" as const })),
  ].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      mention.start < cursor ||
      mention.end > command.length ||
      !command.slice(mention.start, mention.end).startsWith(mention.kind === "skill" ? "/" : "@")
    ) {
      return <LinkifiedText text={command} attachments={message.attachments} />;
    }
    if (mention.start > cursor) {
      parts.push(<LinkifiedText key={`text-${cursor}`} text={command.slice(cursor, mention.start)} attachments={message.attachments} />);
    }
    parts.push(
      <code key={`${mention.kind}-${mention.start}`} className="chat-command-chip" title={mention.label}>
        {command.slice(mention.start, mention.end)}
      </code>,
    );
    cursor = mention.end;
  }
  if (cursor < command.length) {
    parts.push(<LinkifiedText key={`text-${cursor}`} text={command.slice(cursor)} attachments={message.attachments} />);
  }
  return <>{parts}</>;
}

export const MessageRow = memo(function MessageRow({
  message,
  isRunning,
}: {
  message: UiMessage;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const openTranscriptMenu = useTranscriptMenu();
  const { copyText, selectText } = useChatTextActions();
  const prepareUserMessageEdit = useAppStore((s) => s.prepareUserMessageEdit);
  const editUserMessage = useAppStore((s) => s.editUserMessage);
  const activateMessageRevision = useAppStore((s) => s.activateMessageRevision);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const paneSessionId = useSlotSessionId();
  const historyActionsAllowed = useTranscriptHistoryActionsAllowed();
  const isUser = message.role === "user";
  const responseAnnotations = useAppStore((s) =>
    isUser
      ? EMPTY_RESPONSE_ANNOTATIONS
      : annotationsForAssistantMessage(
        transcriptMessagesForSession(s, paneSessionId),
        message.id,
      ),
  );
  const savedSourceAnnotations = useAppStore((s) =>
    isUser
      ? EMPTY_SOURCE_RESPONSE_ANNOTATIONS
      : annotationsForSourceMessage(transcriptMessagesForSession(s, paneSessionId), message.id),
  );
  const pendingAnnotations = useAppStore((s) =>
    isUser || !paneSessionId
      ? EMPTY_PENDING_RESPONSE_ANNOTATIONS
      : s.responseAnnotations[paneSessionId] ?? EMPTY_PENDING_RESPONSE_ANNOTATIONS,
  );
  const sourceAnnotations = useMemo(
    () => [
      ...savedSourceAnnotations,
      ...pendingSourceAnnotationsForMessage(pendingAnnotations, message.id),
    ],
    [message.id, pendingAnnotations, savedSourceAnnotations],
  );
  const session = useAppStore((s) => s.sessions.find((item) => item.id === paneSessionId));
  const canEditMessages = sessionAllows(session ?? (paneSessionId.startsWith("remote:") ? { id: paneSessionId } : undefined), "canEditMessages");
  const canMutateHistory = canEditMessages && historyActionsAllowed;
  const isSessionMessage = Boolean(message.sessionMessage);
  const editableUserMessage = isUser && !isSessionMessage && !message.id.startsWith("plugin:") && canMutateHistory;
  const selectionRole = !isSessionMessage &&
    !message.id.startsWith("plugin:") &&
    (message.role === "user" || message.role === "assistant")
    ? message.role
    : undefined;
  const localWorkspaceRoot = useAppStore((s) => s.workspace?.path);
  const workspaceRoot = sessionAllows(session, "canUseLocalTools") ? localWorkspaceRoot : undefined;
  const openFileRef = useOpenChatFileRef();
  // userAction belongs to user cards; other rows keep a plugin-free bar.
  const slotUser = isUser ? slotMessage("user", message) : undefined;
  // Slash prompts are stored expanded; editing works on the typed form so the
  // resent turn re-expands the template (D123).
  const displayContent = requestTextWithoutAnnotations(message.content || "");
  const sentAnnotations = useMemo(
    () => isUser ? parseAnnotatedPrompt(message.content ?? "")?.annotations ?? [] : [],
    [isUser, message.content],
  );
  const editSeed =
    (editableUserMessage && message.command) || displayContent;
  const [editing, setEditing] = useState(false);
  const [annotationHost, setAnnotationHost] = useState<HTMLElement | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const editRequest = useRef<AbortController | null>(null);
  const editAnnotations = useRef<ParsedResponseAnnotation[]>([]);
  useEffect(() => () => editRequest.current?.abort(), []);
  const [editValue, setEditValue] = useState(editSeed);
  const [retryingEdit, setRetryingEdit] = useState(false);
  const copyLabel = t("chat.copy");
  const editLabel = t("chat.editMessage");
  const deleteLabel = t("chat.deleteMessage");
  // Runtime chunks are already progressive. Rendering that source directly
  // avoids a second per-frame state loop while Markdown memoizes stable blocks.
  const displayed = displayContent;
  const directoryPrompt = useMemo(
    () => isUser ? splitComposerDirectoryPrompt(displayed) : { text: displayed, paths: [] },
    [displayed, isUser],
  );
  const hasAnswer = Boolean(directoryPrompt.text.trim());
  const revisionCount = message.revisionCount ?? 0;
  const activeRevision = message.activeRevision ?? revisionCount;
  const showRevisionPager = editableUserMessage && revisionCount > 1;
  const extraAttachments = useMemo(() => {
    return getExtraMessageAttachments(
      displayed,
      message.attachments,
      workspaceRoot,
    );
  }, [displayed, message.attachments, workspaceRoot]);
  // The user's own order: an image chip the draft named inline renders between
  // the text runs it sat between, exactly where the Composer showed it.
  const userContentParts = useMemo(
    () => splitInlineContent(directoryPrompt.text, message.attachments ?? []).parts,
    [directoryPrompt.text, message.attachments],
  );
  const renderContentPart = (
    part: (typeof userContentParts)[number],
    index: number,
    keyPrefix: string,
  ) =>
    part.kind === "text" ? (
      <LinkifiedText
        key={`${keyPrefix}-${index}`}
        text={part.text}
        attachments={message.attachments}
        sourceOffset={part.start}
      />
    ) : (
      <MessageAttachmentImage
        key={`${keyPrefix}-${index}`}
        attachment={part.attachment}
        onOpenFile={openFileRef}
        inline
      />
    );
  // An attachment the body does not already name inline continues the body
  // text instead of taking a line of its own above it.
  const attachmentChips = extraAttachments.length ? (
    <span
      className="message-attachments"
      role="list"
      aria-label={t("chat.messageAttachments")}
    >
      {extraAttachments.map((attachment) =>
        attachment.kind === "image" ? (
          <MessageAttachmentImage
            key={`${attachment.ref}:${attachment.name}`}
            attachment={attachment}
            onOpenFile={openFileRef}
          />
        ) : (
          <span key={`${attachment.ref}:${attachment.name}`} role="listitem">
            <FileRefChip
              name={attachment.name}
              path={attachment.ref}
              kind={attachment.kind}
              mimeType={attachment.mimeType}
              onOpen={openFileRef}
            />
          </span>
        ),
      )}
    </span>
  ) : null;
  const beginEdit = async () => {
    if (!editableUserMessage || isRunning || loadingEdit) return;
    const request = new AbortController();
    editRequest.current?.abort();
    editRequest.current = request;
    setLoadingEdit(true);
    // Subscribe synchronously: React can batch A→B→A into a single render.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId ||
        state.selectingSessionId !== previous.selectingSessionId) request.abort();
    });
    request.signal.addEventListener("abort", () => {
      unsubscribe();
      if (editRequest.current === request) setLoadingEdit(false);
    }, { once: true });
    try {
      const full = await prepareUserMessageEdit(message.id, request.signal);
      if (!full || request.signal.aborted || editRequest.current !== request) return;
      const preparedEdit = prepareAnnotatedPromptEdit(full.command || full.content || "");
      editAnnotations.current = preparedEdit.annotations;
      setEditValue(preparedEdit.requestText);
      setEditing(true);
    } finally {
      unsubscribe();
      if (editRequest.current === request) {
        editRequest.current = null;
        setLoadingEdit(false);
      }
    }
  };
  const cancelEdit = () => {
    editAnnotations.current = [];
    setEditValue(editSeed);
    setEditing(false);
  };
  const retryEdit = async () => {
    const requestText = editValue.trim();
    if (!editableUserMessage || retryingEdit || (!requestText && !message.attachments?.length)) return;
    setRetryingEdit(true);
    const saved = await editUserMessage(
      message.id,
      buildAnnotatedPrompt(requestText, editAnnotations.current),
      message.attachments,
    );
    setRetryingEdit(false);
    if (saved) {
      editAnnotations.current = [];
      setEditing(false);
    }
  };
  /*
    The pointer path to the actions the hover row already offers. Only a human
    turn is owned here: an assistant answer belongs to its turn, so this row
    must not answer for one — it would offer Copy without the Regenerate and
    Branch items that live on the turn.
  */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isUser) return;
    openTranscriptMenu(event, {
      label: t("chat.messageMenu"),
      items: userMessageMenuItems({
        t,
        text: editing ? editValue : displayed,
        selectTarget: event.currentTarget.querySelector<HTMLElement>(
          editing ? ".message-edit-input" : ".message-bubble",
        ),
        editable: editableUserMessage && !editing && !loadingEdit,
        running: isRunning,
        revision: !editing && showRevisionPager
          ? { count: revisionCount, active: activeRevision }
          : null,
        actions: { copyText, selectText },
        onEdit: () => void beginEdit(),
        onDelete: () => void deleteMessage(message.id),
        onActivateRevision: (index) =>
          void activateMessageRevision(message.id, index),
      }),
    });
  };
  return (
    <div
      className={`message-row ${isSessionMessage ? "session-message" : isUser ? "user" : message.role}`}
      data-minimap-id={message.id}
      data-message-id={message.id}
      data-row-role={isSessionMessage ? undefined : message.role}
      data-selection-message-id={selectionRole ? message.id : undefined}
      data-selection-session-id={selectionRole ? paneSessionId : undefined}
      data-selection-role={selectionRole}
      data-selection-eligible={selectionRole && canEditMessages ? "true" : "false"}
      onContextMenu={onContextMenu}
      role="article"
      aria-label={isSessionMessage ? t("sessionCollaboration.agentMessage") : isUser ? t("chat.userMessage") : t("chat.assistantMessage")}
    >
      <div className="message-col">
        {message.id.startsWith("plugin:") && message.agentName ? <span className="muted">{message.agentName}</span> : null}
        {message.sessionMessage ? <SessionMessageOrigin origin={message.sessionMessage} /> : null}
        {isUser || displayed ? (
          <div className="message-bubble" ref={isUser ? undefined : setAnnotationHost}>
            {editing && editableUserMessage ? (
              <form
                className="message-edit"
                aria-busy={retryingEdit || undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  void retryEdit();
                }}
              >
                <textarea
                  className="message-edit-input selectable"
                  value={editValue}
                  rows={Math.min(12, Math.max(3, editValue.split("\n").length))}
                  aria-label={editLabel}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  disabled={retryingEdit}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Escape") {
                      cancelEdit();
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void retryEdit();
                    }
                  }}
                />
                <div className="message-edit-actions">
                  <button
                    type="button"
                    className="icon-btn message-edit-cancel"
                    disabled={retryingEdit}
                    onClick={cancelEdit}
                  >
                    {t("chat.cancelEdit")}
                  </button>
                  <button
                    type="submit"
                    className="send-btn message-edit-submit"
                    disabled={retryingEdit || (!editValue.trim() && !message.attachments?.length)}
                  >
                    {retryingEdit ? t("chat.retryingEdit") : t("chat.retryEdit")}
                  </button>
                </div>
              </form>
            ) : isUser ? (
              <>
                {directoryPrompt.paths.length ? (
                  <div className="directory-reference-list">
                    {directoryPrompt.paths.map((path, index) => (
                      <DirectoryReferenceCard
                        key={`${index}:${path}`}
                        path={path}
                        sessionId={sessionAllows(session ?? { id: paneSessionId }, "canUseLocalTools") ? paneSessionId : undefined}
                      />
                    ))}
                  </div>
                ) : null}
                {displayed ? (
                  <div className="message-user-text selectable">
                    {editableUserMessage && message.command ? (
                      <>
                        {message.skillMentions?.length || message.agentMentions?.length ? (
                          <SkillInvocationText message={message} />
                        ) : (
                          // Templates retain the existing whole-invocation chip.
                          <code
                            className="chat-command-chip"
                            data-source-start={0}
                            data-source-end={displayed.length}
                            title={displayed}
                          >
                            {message.command}
                          </code>
                        )}
                        {userContentParts
                          .filter((part) => part.kind === "attachment")
                          .map((part, index) => renderContentPart(part, index, "inline"))}
                      </>
                    ) : (
                      userContentParts.map((part, index) =>
                        renderContentPart(part, index, "content"),
                      )
                    )}
                    {attachmentChips}
                  </div>
                ) : attachmentChips}
              </>
            ) : (
              <div className="prose-chat">
                <Markdown
                  source={displayed}
                  responseAnnotations={responseAnnotations}
                  annotationSessionId={paneSessionId}
                />
              </div>
            )}
          </div>
        ) : null}
        {!isUser && sourceAnnotations.length > 0 ? (
          <SourceAnnotationMarkers annotations={sourceAnnotations} contentHost={annotationHost} />
        ) : null}
        {!editing && isUser && sentAnnotations.length > 0 ? (
          <MessageAnnotationSummary annotations={sentAnnotations} />
        ) : null}
        {!editing && (hasAnswer || showRevisionPager) ? (
          <div className="message-actions">
            <MessageTimestamp createdAt={message.createdAt} />
            <ActionSlotSide slot="userAction" side="left" message={slotUser} />
            {showRevisionPager ? (
              <div className="message-revision-pager" role="group" aria-label={t("chat.revisions")}>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionPrev")}
                  ariaLabel={t("chat.revisionPrev")}
                  disabled={isRunning || activeRevision <= 1}
                  onClick={() =>
                    void activateMessageRevision(message.id, Math.max(1, activeRevision - 1))
                  }
                >
                  <IconChevronLeft size={13} />
                </TooltipButton>
                <span className="message-revision-label">
                  {t("chat.revisionPager", {
                    current: activeRevision,
                    total: revisionCount,
                  })}
                </span>
                <TooltipButton
                  className="copy-btn icon revision-nav"
                  tooltip={t("chat.revisionNext")}
                  ariaLabel={t("chat.revisionNext")}
                  disabled={isRunning || activeRevision >= revisionCount}
                  onClick={() =>
                    void activateMessageRevision(
                      message.id,
                      Math.min(revisionCount, activeRevision + 1),
                    )
                  }
                >
                  <IconChevronRight size={13} />
                </TooltipButton>
              </div>
            ) : null}
            {hasAnswer ? <CopyButton text={displayed} label={copyLabel} /> : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon"
                tooltip={editLabel}
                ariaLabel={editLabel}
                disabled={isRunning || loadingEdit}
                onClick={() => void beginEdit()}
              >
                <IconPencil size={13} />
              </TooltipButton>
            ) : null}
            {editableUserMessage ? (
              <TooltipButton
                className="copy-btn icon danger"
                tooltip={deleteLabel}
                ariaLabel={deleteLabel}
                disabled={isRunning}
                onClick={() => void deleteMessage(message.id)}
              >
                <IconTrash size={13} />
              </TooltipButton>
            ) : null}
            <ActionSlotSide slot="userAction" side="right" message={slotUser} />
          </div>
        ) : null}
      </div>
    </div>
  );
});
