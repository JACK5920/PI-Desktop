import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { SubagentStopButton } from "./SubagentStopButton";
import { PlanHistoryCard } from "./PlanHistoryCard";
import { planSubmission } from "../../../lib/plan-history";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { GeneratedImages } from "./GeneratedImages";
import "../../../styles/generated-images.css";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { agentsForOmpToolCall, getOmpSubagentRoster, isOmpTaskBatch, subscribeOmpSubagentRoster } from "../../../components/omp-subagent-roster.mjs";
import { useOmpSubagentRosterPolling } from "../../../components/omp-subagent-roster-polling";
import { ompSubagentIdentity, ompSubagentIsFallbackModel, ompSubagentIsRetrying, ompSubagentIsWaiting, ompSubagentLifecycleStatus, ompSubagentProgressSummary, ompSubagentResolvedModel, ompSubagentRetryFailure, ompSubagentRetryState, ompSubagentStatusKey, ompSubagentTaskDetail, ompSubagentTaskSummary } from "../../../components/omp-subagent-timeline.mjs";
import { useOpenPreviewTarget } from "../../../hooks/use-preview-target";

const EMPTY_OMP_ROSTER: readonly Record<string, unknown>[] = [];
import { useChatFileMenu } from "../../../hooks/use-chat-file-menu";
import { ContextMenu } from "../../../components/ContextMenu";
import { useFollowScroll } from "../../../hooks/use-follow-scroll";
import { SubagentNodeCard } from "./SubagentNodeCard";
import { getToolPreviewTarget } from "../../../lib/chat-links";
import { disclosureKey } from "./disclosure";
import {
  formatToolDuration,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  getToolSummaryValue,
} from "../../../lib/tool-display";
import {
  buildToolPresentation,
  hasToolDetails,
  runOutcome,
  toolResultChips,
  toolResultPayload,
} from "../../../lib/tool-presentation";
import {
  subagentRunsEqual,
  type SubagentRun,
  type SubagentRunItem,
} from "../../../lib/assistant-turns";
import {
  delegationIsCreating,
  delegationRoster,
  delegationRosterOutcome,
  delegationRosterSummary,
  lifecycleKindOf, backgroundJobRowOf,
  subagentOutcome,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { ToolChips, ToolDetailBlocks } from "../../../components/ToolDetails";
import {
  IconArrowDown,
  IconBot,
  IconChevronRight,
  IconCircleAlert,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { DisclosureAnchorContext } from "../../../lib/disclosure-anchor-context";
import {
  AssistantErrorMessage,
  DisclosureCollapseRail,
  LIFECYCLE_LABEL_KEYS,
  LIFECYCLE_RUNNING_KEYS,
  PREVIEWABLE_ACTIONS,
  ThinkingRow,
  ToolActionIcon,
  ToolCommandCopy,
  TOOL_ACTION_KEYS,
  TOOL_RUNNING_KEYS,
  useAutomaticDisclosure,
  useMessageRevealRequest,
} from "./shared";
import {
  delegateAgentName,
  delegateModelId,
  delegateThinkingLevel,
} from "./model";
import { PluginToolCard } from "./PluginToolCard";
import { useSlotEntryForKey } from "../../../plugins/renderer-slots/use-slots";

type ToolRowProps = {
  message: UiMessage;
  /** Rows the delegate produced, when this row is a `Task` call (ADR 0062). */
  delegate?: SubagentRun;
  /** Card treatment used when several Task calls form a delegation topology. */
  variant?: "default" | "topology";
  /** The containing turn renders image results outside its process disclosure. */
  imagesInTurn?: boolean;
  /** Claims the containing activity group when this row is manually used. */
  onUserInteraction?: () => void;
  /** Live delegation statuses read from the turn's lifecycle-tool rows. */
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  /** Runtime timings read from the turn's delegation lifecycle rows. */
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

function toolRowDelegationId(message: UiMessage): string | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const delegationId = (payload as { delegationId?: unknown }).delegationId;
  return typeof delegationId === "string" ? delegationId : undefined;
}

/**
 * Streaming updates replace one message object at a time. Regular rows only
 * depend on that message and their nested run; topology rows additionally
 * depend on the status/timing for their own delegation, not on Map identity.
 */
function toolRowPropsEqual(
  previous: ToolRowProps,
  next: ToolRowProps,
): boolean {
  if (
    previous.message !== next.message ||
    previous.variant !== next.variant ||
    previous.imagesInTurn !== next.imagesInTurn ||
    previous.onUserInteraction !== next.onUserInteraction ||
    !subagentRunsEqual(previous.delegate, next.delegate)
  ) {
    return false;
  }
  if (previous.variant !== "topology") return true;
  const previousId = toolRowDelegationId(previous.message);
  const nextId = toolRowDelegationId(next.message);
  if (previousId !== nextId) return false;
  if (!previousId || !nextId) return true;
  const previousTiming = previous.delegationTimings?.get(previousId);
  const nextTiming = next.delegationTimings?.get(nextId);
  return (
    previous.delegationStatuses?.get(previousId) ===
      next.delegationStatuses?.get(nextId) &&
    previousTiming?.startedAt === nextTiming?.startedAt &&
    previousTiming?.completedAt === nextTiming?.completedAt
  );
}

/**
 * One tool call. A call of a plugin's own tool renders the card that plugin
 * registered for it (the `toolCard` slot); the host card below is its
 * fallback, and the only card for every other call. Topology nodes and
 * denied rows always keep the host card.
 */
export const ToolRow = memo(function ToolRow(props: ToolRowProps) {
  const { message, variant = "default" } = props;
  const cardEntry = useSlotEntryForKey(
    "toolCard",
    variant === "default" && message.toolStatus !== "denied" ? message.toolName : undefined,
  );
  const proposal = planSubmission(message);
  if (proposal && variant === "default" && message.toolStatus !== "denied") {
    return <PlanHistoryCard message={message} proposal={proposal} onUserInteraction={props.onUserInteraction} />;
  }
  const hostRow = <HostToolRow {...props} />;
  return cardEntry ? (
    <PluginToolCard key={cardEntry.id} entry={cardEntry} message={message} fallback={hostRow} />
  ) : (
    hostRow
  );
}, toolRowPropsEqual);

function HostToolRow({
  message,
  delegate,
  variant = "default",
  imagesInTurn = false,
  onUserInteraction,
  delegationStatuses,
  delegationTimings,
}: ToolRowProps) {
  const { t } = useTranslation();
  const detailsId = useId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const root = useAppStore((s) => localToolsAllowed ? s.workspace?.path : undefined);
  const openTarget = useOpenPreviewTarget();
  const { fileMenu, openFileMenu, closeFileMenu } = useChatFileMenu();
  const openSubagentTab = useAppStore((s) => s.openSubagentTab);
  const openOmpSubagentBatchTab = useAppStore((s) => s.openOmpSubagentBatchTab);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const ompBatchCandidate = isOmpTaskBatch(message.engineOrigin, message.toolName, message.toolArgs);
  const subscribeOmpRoster = useCallback((listener: () => void) => activeSessionId
    ? ompBatchCandidate ? subscribeOmpSubagentRoster(activeSessionId, listener) : () => undefined
    : () => undefined, [activeSessionId, ompBatchCandidate]);
  const getOmpRosterSnapshot = useCallback(() => activeSessionId
    ? ompBatchCandidate ? getOmpSubagentRoster(activeSessionId) : EMPTY_OMP_ROSTER
    : EMPTY_OMP_ROSTER, [activeSessionId, ompBatchCandidate]);
  const ompRoster = useSyncExternalStore(subscribeOmpRoster, getOmpRosterSnapshot, getOmpRosterSnapshot);
  // The batch card is rendered by this row, not only by the work-panel tab, so
  // the shared roster poller must stay alive from here too — otherwise a closed
  // subagent pane freezes every agent's status until one is opened.
  useOmpSubagentRosterPolling(ompBatchCandidate ? activeSessionId : null);
  const activeWorkPanelTabId = useAppStore((s) => s.activeWorkPanelTabId);
  const status = message.toolStatus;
  const action = getToolAction(message.toolName);
  // A run row states what the command did, not what the call around it did: an
  // exit code the shell reported outranks a tool call that came back fine
  // (D227). Property reads only, so a streaming row can afford it every tick.
  const run = action === "run" ? runOutcome(message) : null;
  const failed = status === "error" || run === "failed";
  // A tool call never opens itself: the payload waits for the user, and a
  // failure or denial stays in the row head either way.
  const revealRequest = useMessageRevealRequest(message.id);
  const disclosure = useAutomaticDisclosure(
    false,
    revealRequest,
    disclosureKey("tool", message.id),
  );
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } = disclosure;
  const titleRef = disclosure.titleRef;
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);
  const actionLabel = t(
    status === "running" ? TOOL_RUNNING_KEYS[action] : TOOL_ACTION_KEYS[action],
  );
  const rawName = getToolDisplayName(message.toolName) || t("chat.tool");
  const argSummary = getToolSummary(message.toolName, message.toolArgs);
  const previewTarget = PREVIEWABLE_ACTIONS.has(action)
    ? getToolPreviewTarget(message.toolArgs, root)
    : null;
  // A run row keeps its command in the head and only its output in the body, so
  // the head carries the two things the body no longer offers: a copy of the
  // command, and the outcome (D226).
  const runHead = action === "run" && variant !== "topology";
  const command = runHead
    ? getToolSummaryValue(message.toolName, message.toolArgs)
    : "";
  // A delegation is always expandable: its brief, report and the delegate's
  // own rows all live in the body.
  const hasDetails = hasToolDetails(message) || Boolean(delegate);
  const chips = toolResultChips(message);
  // A lifecycle row (ADR 0089) is about subagents, so it is presented as one:
  // the agent names it reports on replace the bare delegation ids it was
  // called with, and its badge rolls up their statuses (D268).
  const lifecycle = action === "delegate" ? lifecycleKindOf(message) : null;
  const ompBatch = action === "delegate" && !lifecycle &&
    isOmpTaskBatch(message.engineOrigin, message.toolName, message.toolArgs);
  const ompBatchToolCallId = message.toolCallId || message.id;
  const ompBatchRoster = useMemo(() => ompBatch
    ? agentsForOmpToolCall([...ompRoster], ompBatchToolCallId)
    : { agents: [], correlated: true }, [ompBatch, ompRoster, ompBatchToolCallId]);
  const ompBatchAgents = ompBatchRoster.agents;
  // Bucket by the strongest evidence per agent: a delivered `<task-result>`
  // outranks the transcript, which outranks the last lifecycle snapshot.
  const ompBatchOutcomes = ompBatchAgents.map((agent: any) => ompSubagentStatusKey(ompSubagentLifecycleStatus(agent)));
  const ompBatchRunningCount = ompBatchAgents.filter((agent: any, index: number) =>
    !ompBatchOutcomes[index] && agent.observedActive !== false && ["running", "pending", "started"].includes(String(agent.status ?? "").toLowerCase()),
  ).length;
  const ompBatchCompletedCount = ompBatchOutcomes.filter((key: string) => key === "completed").length;
  const ompBatchAbortedCount = ompBatchOutcomes.filter((key: string) => ["aborted", "stopped", "timed_out"].includes(key)).length;
  const ompBatchFailedCount = ompBatchOutcomes.filter((key: string) => ["failed", "denied"].includes(key)).length;
  // An agent OMP dropped from its running-only roster without any terminal
  // evidence is unconfirmed, not finished.
  const ompBatchUnconfirmedCount = ompBatchAgents.length - ompBatchCompletedCount - ompBatchAbortedCount - ompBatchFailedCount - ompBatchRunningCount;
  const ompBatchSettledCount = ompBatchCompletedCount + ompBatchAbortedCount + ompBatchFailedCount;
  const ompBatchOutcomeSummary = [
    ompBatchCompletedCount ? t("settings.omp.ompBatchCompleted", { n: ompBatchCompletedCount }) : "",
    ompBatchAbortedCount ? t("settings.omp.ompBatchAborted", { n: ompBatchAbortedCount }) : "",
    ompBatchFailedCount ? t("settings.omp.ompBatchFailed", { n: ompBatchFailedCount }) : "",
    ompBatchUnconfirmedCount ? t("settings.omp.ompBatchUnconfirmed", { n: ompBatchUnconfirmedCount }) : "",
  ].filter(Boolean).join(" · ");
  const ompRequestedTaskCount = Array.isArray((message.toolArgs as Record<string, unknown> | null)?.tasks)
    ? ((message.toolArgs as { tasks: unknown[] }).tasks.length)
    : 0;
  const jobRow = lifecycle ? backgroundJobRowOf(message) : null;
  const roster = lifecycle ? delegationRoster(message) : [];
  const rosterSummary = lifecycle ? delegationRosterSummary(roster) : "";
  const rosterOutcome = lifecycle ? delegationRosterOutcome(roster) : null;
  const agentName =
    action === "delegate" && !lifecycle
      ? message.engineOrigin === "omp"
        ? t("settings.omp.ompBatchTitle")
        : delegateAgentName(message, delegate)
      : "";
  const modelId = variant === "topology" ? delegateModelId(message) : "";
  const thinkingLevel =
    variant === "topology" ? delegateThinkingLevel(message) : undefined;
  const thinkingLabel = thinkingLevel ?? "";
  const modelLabel = [modelId, thinkingLabel].filter(Boolean).join(" ");
  // The delegate's last answer row is its report, so the body must not print
  // the same text a second time.
  const nestedReport = delegate?.items.some((item) => item.kind === "answer");
  // Keep mounted output and its reading position while an ancestor is folded,
  // but defer formatting hidden streaming updates until it becomes visible.
  const presentation = useRef<{
    message: UiMessage;
    nestedReport: boolean | undefined;
    blocks: ReturnType<typeof buildToolPresentation>;
  } | null>(null);
  if (variant !== "topology" && open && hasDetails && disclosure.parentVisible &&
    (presentation.current?.message !== message || presentation.current?.nestedReport !== nestedReport)) {
    presentation.current = {
      message,
      nestedReport,
      blocks: buildToolPresentation(message, {
        hideSummaryArg: true,
        ...(nestedReport ? { hideDelegateReport: true } : {}),
      }),
    };
  }
  const blocks = variant !== "topology" && open && hasDetails ? presentation.current?.blocks : null;
  const outcome =
    variant === "topology" ? subagentOutcome(message, delegationStatuses) : null;
  const displayOutcome = ompBatch
    ? status === "error"
      ? "failed"
      : status === "denied"
        ? "denied"
        : ompBatchRunningCount > 0 || status === "running"
      ? "running"
      : ompBatchRoster.correlated && ompBatchAgents.length > 0 && ompBatchSettledCount + ompBatchRunningCount === ompBatchAgents.length
        ? ompBatchCompletedCount === ompBatchAgents.length
          ? "completed"
          : ompBatchFailedCount > 0
            ? "failed"
            : ompBatchAbortedCount > 0
              ? "aborted"
              : undefined
        : undefined
    : outcome;
  // A bare `running` Task row (no delegation result yet) is still being
  // created: the delegate runtime is spawning and no structured snapshot
  // exists. Show it as starting rather than a generic running state.
  const creating =
    variant === "topology" &&
    outcome === "running" &&
    delegationIsCreating(message);
  const runLabel =
    run === "running"
      ? t("chat.running")
      : run === "failed"
        ? t("chat.toolFailed")
        : run === "denied"
          ? t("chat.toolDenied")
          : run === "ok"
            ? t("chat.toolCompleted")
            : "";
  // A lifecycle row never falls back to its arguments: while it is still
  // running it has no roster yet, and `delegationIds` would otherwise reach the
  // head as a JSON blob of UUIDs (D268).
  const summary = ompBatch
    ? t("settings.omp.ompBatchSummary", {
        requested: ompRequestedTaskCount,
        observed: ompBatchAgents.length,
        running: ompBatchRunningCount,
      })
    : jobRow
    ? [
        rosterSummary, jobRow.command,
        jobRow.count !== undefined && t("backgroundTasks.headerCount", { count: jobRow.count }),
        jobRow.state && t(`backgroundTasks.${jobRow.state}`),
      ].filter(Boolean).join(" · ")
    : lifecycle ? rosterSummary : argSummary;
  const statusLabel = ompBatch
    ? status === "error"
      ? t("chat.toolFailed")
      : status === "denied"
        ? t("chat.toolDenied")
        : ompBatchRunningCount > 0
      ? ompBatchRoster.correlated
        ? t("settings.omp.ompBatchRunning", { running: ompBatchRunningCount, total: ompBatchAgents.length })
        : t("settings.omp.ompBatchUnlinkedRunning", { running: ompBatchRunningCount })
      : status === "running"
        ? t("settings.omp.ompBatchDispatching")
        : ompBatchRoster.correlated && ompBatchAgents.length > 0
          ? ompBatchOutcomeSummary || t("settings.omp.ompBatchDispatched")
          : ompRequestedTaskCount > 0 && ompBatchAgents.length === 0
            // The call finished without a single observed agent: the batch
            // never started, which reads as success unless we say otherwise.
            ? t("settings.omp.ompBatchNotStarted")
            : t("settings.omp.ompBatchDispatched")
    : creating
    ? t("chat.subagentCreating")
    : outcome
      ? t(`chat.subagentStatus.${outcome}`)
      : rosterOutcome
        ? t(`chat.subagentStatus.${rosterOutcome}`)
        : run
          ? runLabel
          : status === "running"
            ? t("chat.running")
            : status === "error"
              ? t("chat.toolFailed")
              : status === "denied"
                ? t("chat.toolDenied")
                : t("chat.toolCompleted");
  const delegationPayload =
    variant === "topology" ? toolResultPayload(message) : undefined;
  const delegationId =
    delegationPayload && typeof delegationPayload === "object"
      ? (delegationPayload as { delegationId?: unknown }).delegationId
      : undefined;
  const panelSelectionId =
    ompBatch
      ? message.toolCallId || message.id
      : typeof delegationId === "string" && delegationId
      ? delegationId
      : message.toolCallId || message.id;
  const panelOpen =
    variant === "topology" &&
    activeWorkPanelTabId === (ompBatch ? `omp-subagent-batch:${panelSelectionId}` : `subagent:${panelSelectionId}`);
  const renderedOpen = variant === "topology" ? panelOpen : open;
  const inlineOpen = variant !== "topology" && open;
  const delegationTiming =
    typeof delegationId === "string"
      ? delegationTimings?.get(delegationId)
      : undefined;
  const [now, setNow] = useState(Date.now);
  // While a delegation is still being created it has no `startedAt` in the
  // result, so the elapsed clock ticks from the call's own timestamp instead
  // of waiting for the Task handle — the node never reads as stalled.
  const nodeStartedAt =
    delegationTiming?.startedAt !== undefined
      ? delegationTiming.startedAt
      : creating && message.createdAt
        ? Date.parse(message.createdAt) || undefined
        : undefined;
  const durationMs =
    nodeStartedAt !== undefined
      ? Math.max(
          0,
          (delegationTiming?.completedAt ??
            (outcome === "running" ? now : nodeStartedAt)) -
            nodeStartedAt,
        )
      : message.toolDurationMs;
  const duration = !ompBatch &&
    typeof durationMs === "number" && durationMs > 0
      ? formatToolDuration(durationMs / 1000)
      : "";

  useEffect(() => {
    if (outcome !== "running") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [outcome]);

  // Auto-scroll the nested `.tool-row-content` containers to their bottom
  // while the tool is still running. These elements have `max-height: 260px`
  // and `overflow: auto`, creating a nested scroll area that the transcript-
  // level follow scroll cannot reach once the height cap is hit. Only scroll
  // when the container is already near the bottom so a manual scroll-up by
  // the user is not overridden.
  useLayoutEffect(() => {
    if (status !== "running" || !open) return;
    const body = disclosure.bodyRef.current;
    if (!body) return;
    const containers = body.querySelectorAll<HTMLElement>(".tool-row-content");
    for (const el of containers) {
      const nearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (nearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [status, open, message, disclosure.bodyRef]);


  const statusTone =
    run === "running" || (!run && status === "running")
      ? "is-running"
      : failed
        ? "is-error"
        : run === "denied" || (!run && status === "denied")
          ? "is-denied"
          : "is-done";
  const caret = hasDetails ? <IconChevronRight size={12} /> : null;

  return (
    <div
      className={`tool-row ${variant === "topology" ? "subagent-topology-node" : ""} ${
        renderedOpen ? "open" : ""
      } status-${run === "failed" ? "error" : status || "success"}${displayOutcome ? ` outcome-${displayOutcome.replaceAll("_", "-")}` : ""}${creating ? " outcome-creating" : ""}`}
      role={variant === "topology" ? "listitem" : "region"}
      data-message-id={message.id}
      aria-label={`${t("chat.toolCall")}: ${rawName}${agentName ? `, ${agentName}` : ""}${modelLabel ? `, ${modelLabel}` : ""}${statusLabel ? `, ${statusLabel}` : ""}`}
    >
      {variant === "topology" ? (
        <div className="subagent-topology-node-actions">
        <SubagentNodeCard
          title={agentName || t("chat.subagentUnnamed")}
          model={modelId || undefined}
          thinking={thinkingLabel || undefined}
          summary={summary}
          steps={delegate?.items.length ? t("chat.processingSteps", { count: delegate.items.length }) : undefined}
          status={displayOutcome ?? undefined}
          statusLabel={statusLabel}
          duration={duration}
          expanded={panelOpen}
          controlsId={`work-panel-surface-${ompBatch ? `omp-subagent-batch:${panelSelectionId}` : `subagent:${panelSelectionId}`}`}
          disabled={!hasDetails}
          onClick={() => {
            if (!hasDetails) return;
            onUserInteraction?.();
            if (!localToolsAllowed) return;
            if (ompBatch) openOmpSubagentBatchTab(message.toolCallId || message.id);
            else openSubagentTab(panelSelectionId, agentName || undefined);
          }}
        />
        {typeof delegationId === "string" && <SubagentStopButton delegationId={delegationId} running={outcome === "running" && !creating} name={agentName} />}
        {ompBatch && ompBatchAgents.length ? <>
          {!ompBatchRoster.correlated ? <small className="omp-native-agent-unlinked-note">{t("settings.omp.noCorrelatedSubagents")}</small> : null}
          <div className="omp-batch-child-agents" role="list" aria-label={t("settings.omp.subagentManager")}>
          {ompBatchAgents.map((agent: any, index: number) => {
            const taskSummary = ompSubagentTaskSummary(agent);
            const label = ompSubagentIdentity(agent, index, t("settings.omp.subagentNumber", { number: index + 1 }), ompBatchAgents);
            const taskDetail = ompSubagentTaskDetail(agent);
            const progress = ompSubagentProgressSummary(agent);
            const rawStatus = ompSubagentLifecycleStatus(agent).toLowerCase();
            const waiting = ompSubagentIsWaiting(agent);
            const retrying = ompSubagentIsRetrying(agent);
            const retry = ompSubagentRetryState(agent);
            const retryFailure = ompSubagentRetryFailure(agent);
            const resolvedModel = ompSubagentResolvedModel(agent);
            const fallbackModel = ompSubagentIsFallbackModel(agent);
            const nodeStatus = agent.observedActive === false
              ? ["completed", "complete", "failed", "error", "cancelled", "canceled", "stopped", "aborted", "timed_out"].includes(rawStatus)
                ? rawStatus === "completed" || rawStatus === "complete" ? "completed" : rawStatus === "stopped" ? "stopped" : rawStatus === "aborted" || rawStatus === "cancelled" || rawStatus === "canceled" ? "aborted" : "failed"
                : "unknown"
              : waiting ? "waiting" : retrying ? "retrying" : ["running", "pending", "started"].includes(rawStatus) ? "running" : "unknown";
            const statusKey = waiting ? "waiting" : ompSubagentStatusKey(rawStatus);
            const readableStatus = statusKey ? t(`chat.subagentStatus.${statusKey}`) : t("settings.omp.subagentStatusUnknown");
            const nodeStatusLabel = retrying && retry
              ? t("settings.omp.subagentRetrying", {
                attempt: retry.attempt,
                max: retry.maxAttempts,
                seconds: Math.ceil(retry.remainingMs / 1000),
                reason: retry.errorMessage || t("settings.omp.subagentRetryReasonUnavailable"),
              })
              : waiting ? t("settings.omp.subagentWaitingOnOwnWork")
              : agent.observedActive === false && retryFailure && ["failed", "aborted"].includes(statusKey)
                ? t("settings.omp.subagentRetryFailed", { attempt: retryFailure.attempt, reason: retryFailure.errorMessage || t("settings.omp.subagentRetryReasonUnavailable") })
                : agent.observedActive === false && (!statusKey || statusKey === "running")
              ? t("settings.omp.subagentNoLongerRunning")
              : readableStatus;
            const readableStatusLabel = fallbackModel
              ? `${nodeStatusLabel} · ${t("settings.omp.subagentFallbackModel")}`
              : nodeStatusLabel;
            return <div role="listitem" key={agent.id} className="subagent-topology-node omp-batch-child-agent">
              <SubagentNodeCard
                title={label}
                summary={taskSummary || undefined}
                summaryDetail={taskDetail || undefined}
                model={resolvedModel || undefined}
                activity={progress || undefined}
                status={nodeStatus as "running" | "waiting" | "retrying" | "completed" | "aborted" | "stopped" | "failed" | "unknown"}
                statusLabel={readableStatusLabel}
                onClick={() => {
                  onUserInteraction?.();
                  if (localToolsAllowed) openOmpSubagentBatchTab(ompBatchToolCallId, String(agent.id), label);
                }}
              />
            </div>;
          })}
          </div>
        </> : null}
        </div>
      ) : (
        <div className={`tool-row-head${runHead ? " is-run" : ""}`}>
          <button
            ref={titleRef}
            className="tool-row-header"
            aria-expanded={open}
            aria-controls={hasDetails ? detailsId : undefined}
            disabled={!hasDetails}
            title={summary || rawName}
            onClick={() => hasDetails && toggleRow()}
          >
            <span
              className={`tool-row-icon${lifecycle && !jobRow ? " is-subagent" : ""}`}
            >
              <ToolActionIcon action={jobRow ? (jobRow.kind === "list" ? "list" : "run") : action} />
            </span>
            <span
              className={`tool-row-name ${status === "running" ? "running" : ""}`}
            >
              {jobRow ? rawName : lifecycle
                ? t(
                    (status === "running"
                      ? LIFECYCLE_RUNNING_KEYS
                      : LIFECYCLE_LABEL_KEYS)[lifecycle],
                  )
                : actionLabel}
            </span>
            {status === "running" ? <span className="activity-marker" aria-hidden /> : null}
            {lifecycle && roster.length > 0 ? (
              <span className="tool-row-agent is-count">
                {t("chat.subagentCount", { count: roster.length })}
              </span>
            ) : null}
            {agentName ? (
              <span className="tool-row-agent" title={t("chat.subagentAgent")}>
                {agentName}
              </span>
            ) : null}
            {summary ? (
              <span
                className={`tool-row-summary${previewTarget && localToolsAllowed ? " linked" : ""}`}
                title={
                  previewTarget && localToolsAllowed
                    ? previewTarget.kind === "file"
                      ? t("chat.previewFile")
                      : t("chat.previewUrl")
                    : undefined
                }
                onClick={
                  previewTarget && localToolsAllowed
                    ? (e) => {
                        // Open the preview target instead of toggling details.
                        e.stopPropagation();
                        openTarget(previewTarget);
                      }
                    : undefined
                }
                onContextMenu={
                  localToolsAllowed && previewTarget?.kind === "file"
                    ? (event) =>
                        openFileMenu(event, { path: previewTarget.path })
                    : undefined
                }
              >
                {summary}
              </span>
            ) : null}
            <ToolChips chips={chips} />
            {runHead && statusLabel ? (
              <span
                className={`tool-row-state ${statusTone}`}
                role="status"
                aria-live="polite"
              >
                <span className="tool-row-state-dot" aria-hidden />
                {statusLabel}
              </span>
            ) : status === "running" ? (
              <span className="tool-spinner" aria-label={t("chat.running")} />
            ) : status === "error" ? (
              <span
                className="tool-row-status error"
                aria-label={t("chat.toolFailed")}
              >
                <IconCircleAlert size={13} />
                {t("chat.toolFailed")}
              </span>
            ) : status === "denied" ? (
              <span className="tool-row-status">{t("chat.toolDenied")}</span>
            ) : null}
            {runHead && statusLabel ? null : (
              <span className="sr-only" role="status" aria-live="polite">
                {statusLabel}
              </span>
            )}
            {runHead || !caret ? null : (
              <span className="tool-row-caret" aria-hidden>
                {caret}
              </span>
            )}
          </button>
          {runHead && command ? <ToolCommandCopy command={command} /> : null}
          {runHead && caret ? (
            // Redundant for the keyboard — the header itself is the disclosure —
            // so it is a pointer target only and stays out of the reading order.
            <button
              className="tool-row-caret is-toggle"
              aria-hidden="true"
              tabIndex={-1}
              onClick={toggleRow}
            >
              {caret}
            </button>
          ) : null}
        </div>
      )}
      {variant === "topology" ? (
        <span className="sr-only" role="status" aria-live="polite">
          {statusLabel}
        </span>
      ) : null}
      {blocks && blocks.length > 0 ? (
        <div className="tool-row-body" id={detailsId} ref={disclosure.bodyRef} {...disclosure.bodyEvents}>
          <DisclosureCollapseRail
            label={t("chat.collapseToolOutput")}
            onCollapse={collapseRow}
          />
          <ToolDetailBlocks blocks={blocks} plain={runHead} streaming={status === "running"} />
        </div>
      ) : null}
      {!imagesInTurn && <GeneratedImages message={message} />}
      {inlineOpen && delegate ? (
        <SubagentRunRows
          run={delegate}
          agentName={agentName}
          onCollapse={collapseRow}
        />
      ) : null}
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </div>
  );
}

/**
 * What a delegate did, nested under the `Task` call that spawned it.
 *
 * The rows are the delegate's context, not the parent's, so they are visibly
 * one level in and stay collapsed with the call. Only one level is possible: a
 * delegate has no `Task` tool of its own (ADR 0062).
 */
export const SubagentRunRows = memo(function SubagentRunRows({
  run,
  agentName,
  onCollapse,
  scrollable = true,
  variant = "inline",
}: {
  run: SubagentRun;
  agentName: string;
  onCollapse?: () => void;
  /** Side-panel mode lets the parent panel own the only scrollbar. */
  scrollable?: boolean;
  /** Dock headings are section labels; inline headings name the delegate. */
  variant?: "inline" | "dock";
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (run.items.length === 0) return null;
  const dock = variant === "dock";
  return (
    <div className={dock ? "subagent-run is-dock" : "subagent-run"}>
      {onCollapse ? (
        <DisclosureCollapseRail
          label={t("chat.collapseDetails")}
          onCollapse={onCollapse}
        />
      ) : null}
      <div
        className={dock ? "subagent-run-heading is-dock" : "subagent-run-heading"}
        id={headingId}
      >
        {dock ? null : <IconBot size={13} aria-hidden />}
        <span>
          {dock
            ? t("chat.subagentProcess")
            : agentName
              ? t("chat.subagentWork", { agent: agentName })
              : t("chat.subagentWorkUnnamed")}
        </span>
        <span className="subagent-run-count">
          {t("chat.processingSteps", { count: run.items.length })}
        </span>
      </div>
      <SubagentRunFollow
        headingId={headingId}
        items={run.items}
        scrollable={scrollable}
      />
    </div>
  );
});

/**
 * Nested follow-scroll for one expanded delegate (D302). Mounted only once
 * the run has rows, so the first layout pins to the latest output instead of
 * to an empty scroller.
 */
function SubagentRunFollow({
  headingId,
  items,
  scrollable = true,
}: {
  headingId: string;
  items: SubagentRunItem[];
  scrollable?: boolean;
}) {
  const { t } = useTranslation();
  const {
    scrollRef,
    contentRef,
    showJump,
    handleScroll,
    jumpToLatest,
    scheduleFollowScroll,
    disclosureAnchorNotifier,
  } = useFollowScroll();

  useLayoutEffect(() => {
    if (!scrollable) return;
    scheduleFollowScroll();
  }, [items, scheduleFollowScroll, scrollable]);

  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div className="subagent-run-follow">
        {/* The rows scroll inside the run rather than growing the transcript
          * (D271). Follow sticks to the latest output while pinned (D302).
          * Labelled and focusable so a keyboard reader can reach the scroll
          * area the pointer can already use. */}
        <div
          ref={scrollRef}
          data-scroll-owner="follow"
          className={`subagent-run-rows${scrollable ? "" : " is-panel-flow"}`}
          role="group"
          tabIndex={scrollable ? 0 : undefined}
          aria-labelledby={headingId}
          onScroll={scrollable ? handleScroll : undefined}
        >
          <div ref={contentRef}>
            {items.map((item) =>
              item.kind === "tool" ? (
                reviewChangeFromMessage(item.message) ? (
                  <ReviewChangeCard
                    key={item.message.id}
                    message={item.message}
                    asToolRow
                  />
                ) : (
                  <ToolRow key={item.message.id} message={item.message} />
                )
              ) : item.kind === "thinking" ? (
                <ThinkingRow
                  key={`thinking-${item.message.id}`}
                  message={item.message}
                  streaming={item.message.status === "streaming"}
                  autoOpen
                />
              ) : (
                <div
                  className="subagent-answer"
                  data-message-id={item.message.id}
                  key={`answer-${item.message.id}`}
                >
                  {item.message.content ? (
                    <div className="prose-chat">
                      <Markdown source={item.message.content} />
                    </div>
                  ) : null}
                  {item.message.error ? (
                    <AssistantErrorMessage message={item.message} />
                  ) : null}
                </div>
              ),
            )}
          </div>
        </div>
        {scrollable && showJump ? (
          <TooltipButton
            type="button"
            className="jump-latest-btn"
            ariaLabel={t("chat.scrollToBottom")}
            tooltip={t("chat.scrollToBottom")}
            onClick={jumpToLatest}
          >
            <IconArrowDown size={14} />
          </TooltipButton>
        ) : null}
      </div>
    </DisclosureAnchorContext.Provider>
  );
}

/** The task text sent to the delegate, shown as the conversation-like body. */
