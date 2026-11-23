import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { AgentActivity, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import type { SubagentOutcome, SubagentTiming } from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { useSmoothText } from "../../../hooks/useSmoothText";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { GenUiCards } from "../gen-ui/GenUiCard";
import { useGenUiSplit } from "../gen-ui/gen-ui-split";
import { isGenUiRemoteOwner } from "../gen-ui/gen-ui-source";
import { sessionAllows } from "../../../lib/remote-session-safety";
import {
  annotationsForAssistantMessage,
  transcriptMessagesForSession,
} from "../../../lib/response-annotations";
import { isAssistantFragmentSelectable } from "../../../lib/transcript-selection";
import { ActivityGroup } from "./ActivityGroup";
import { AssistantErrorMessage } from "./shared";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

/** Message bubble that optionally applies smooth text release. */
const SmoothMessageBubble = memo(function SmoothMessageBubble({ message, streaming, selectable }: {
  message: UiMessage;
  streaming: boolean;
  selectable: boolean;
}) {
  const { t } = useTranslation();
  const smoothStreaming = useAppStore((s) => s.settings?.smoothStreaming !== false);
  // Opt-in feature: an absent setting keeps cards out of the transcript.
  const inlineVisualizations = useAppStore((s) => s.settings?.inlineVisualizations === true);
  const prefersReducedMotion = typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enabled = smoothStreaming && !prefersReducedMotion;
  const displayContent = useSmoothText(message.content || "", streaming, enabled);
  const showCursor = streaming && enabled && Boolean(displayContent);
  const genUi = useGenUiSplit(displayContent, streaming, inlineVisualizations);
  // Cards load the pane session's own copy, never the session a path names.
  const sessionId = useSlotSessionId();
  const session = useAppStore((s) => s.sessions.find((item) => item.id === sessionId));
  const responseAnnotations = useAppStore((s) =>
    annotationsForAssistantMessage(
      transcriptMessagesForSession(s, sessionId),
      message.id,
    ),
  );
  const remote = isGenUiRemoteOwner(sessionId, session);
  const selectionEligible = selectable && sessionAllows(session, "canEditMessages");
  const hasOrderedImages = message.inlineContent?.some((block) => block.type === "image") === true;
  let visibleTextOffset = 0;
  const orderedContent = hasOrderedImages ? message.inlineContent?.map((block, index) => {
    if (block.type === "text") {
      const visibleText = displayContent.slice(visibleTextOffset, visibleTextOffset + block.text.length);
      visibleTextOffset += block.text.length;
      return visibleText ? <div className="prose-chat" key={`text:${index}`}><Markdown
        source={visibleText}
        streaming={streaming}
        // Annotation offsets refer to the complete message, not each native
        // block. Keep them only when a single text block owns the whole reply.
        responseAnnotations={message.inlineContent?.length === 1 ? responseAnnotations : undefined}
        annotationSessionId={sessionId}
      /></div> : null;
    }
    // Do not reveal an image until all preceding text has streamed in.
    if (displayContent.length < visibleTextOffset) return null;
    return <div className="omp-inline-image-block" key={`image:${index}`}>
      <img src={block.dataUrl} alt={t("chat.ompInlineImageAlt", { index: index + 1 })} loading="lazy" />
    </div>;
  }) : null;
  return (
    <div
      className={`message-bubble assistant-turn-fragment${streaming ? " streaming" : ""}${showCursor ? " smooth-cursor" : ""}`}
      data-message-id={message.id}
      data-selection-message-id={message.id}
      data-selection-session-id={sessionId || undefined}
      data-selection-role="assistant"
      data-selection-eligible={selectionEligible ? "true" : "false"}
      data-selection-streaming={streaming ? "true" : "false"}
    >
      {hasOrderedImages ? orderedContent : genUi.content ? <div className="prose-chat"><Markdown
        source={genUi.content}
        streaming={streaming}
        responseAnnotations={responseAnnotations}
        annotationSessionId={sessionId}
      /></div> : null}
      {!hasOrderedImages && message.inlineImages?.length ? <div className="omp-inline-images" aria-label="OMP response images">
        {message.inlineImages.map((image, index) => <img key={`${image.mimeType}:${index}`} src={image.dataUrl} alt={t("chat.ompInlineImageAlt", { index: index + 1 })} loading="lazy" />)}
      </div> : null}
      <GenUiCards references={genUi.references} sessionId={sessionId} remote={remote} />
      {message.error ? <AssistantErrorMessage message={message} /> : null}
    </div>
  );
});

function partKey(part: AssistantTurnPart) {
  if (part.kind === "message") return part.message.id;
  const first = part.items[0];
  return `activity-${first.message.id}-${first.kind}${first.kind === "hostedSearch" ? `-${first.round.id}` : ""}`;
}

/**
 * Whether a rendered part owns the active tail.
 *
 * A command-folding segment may coalesce contiguous activity parts into a new
 * part object while keeping the source rows. The active tail is the last entry
 * part, so the coalesced part's last row is the same row object; no id fallback
 * or nested scan is needed.
 */
function partOwnsActivePart(
  part: AssistantTurnPart,
  activePart: AssistantTurnPart,
): boolean {
  if (part === activePart) return true;
  if (part.kind !== "activity" || activePart.kind !== "activity") {
    return false;
  }
  const activeRow = activePart.items.at(-1);
  return activeRow !== undefined && part.items.at(-1) === activeRow;
}

type PartContext = {
  isActive: boolean;
  activePart?: AssistantTurnPart;
  runtimeActivity?: AgentActivity;
  parentResponseMessageId?: string;
  turnDelegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  turnDelegationTimings: ReadonlyMap<string, SubagentTiming>;
};

const TurnPartBlock = memo(function TurnPartBlock({
  block, isActive, activePart, runtimeActivity,
  parentResponseMessageId, turnDelegationStatuses, turnDelegationTimings,
}: PartContext & { block: RenderBlock<AssistantTurnPart> }) {
  return <>{block.items.map((part) => part.kind === "activity" ? (
    <ActivityGroup
      embedded
      key={partKey(part)}
      items={part.items}
      endedAt={part.endedAt}
      isActive={part === activePart}
      turnActive={isActive}
      runtimeActivity={part === activePart ? runtimeActivity : undefined}
      parentResponseMessageId={parentResponseMessageId}
      turnDelegationStatuses={turnDelegationStatuses}
      turnDelegationTimings={turnDelegationTimings}
    />
  ) : (
    <SmoothMessageBubble
      key={part.message.id}
      message={part.message}
      streaming={isActive && part.message.status === "streaming"}
      selectable={isAssistantFragmentSelectable(isActive, part.message.status)}
    />
  ))}</>;
});

export const AssistantTurnParts = memo(function AssistantTurnParts({ parts, ...context }: PartContext & {
  parts: readonly AssistantTurnPart[];
}) {
  const blocks = useRenderBlocks(parts, partKey);
  const activeSourcePart = context.activePart;
  return <>{blocks.map((block) => {
    // The active tail is an entry part, but an off-mode segment may wrap its
    // rows in a new merged part. Match by source row so the group that owns the
    // live step still gets its active defaults.
    const activePart = activeSourcePart
      ? block.items.find((part) => partOwnsActivePart(part, activeSourcePart))
      : undefined;
    return <TurnPartBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      activePart={activePart}
      runtimeActivity={activePart ? context.runtimeActivity : undefined}
      turnDelegationStatuses={context.turnDelegationStatuses}
      turnDelegationTimings={context.turnDelegationTimings}
    />;
  })}</>;
});
