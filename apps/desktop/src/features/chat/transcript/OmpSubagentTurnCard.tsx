import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { buildOmpSubagentTurnGroup } from "../../../components/omp-subagent-turn-group.mjs";
import { ompSubagentIdentity, ompSubagentProgressSummary, ompSubagentTaskDetail, ompSubagentTaskSummary } from "../../../components/omp-subagent-timeline.mjs";
import { ompSubagentDeliveryPreview } from "../../../components/omp-subagent-roster.mjs";
import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useAppStore } from "../../../stores/app-store";
import { SubagentNodeCard } from "./SubagentNodeCard";

type OmpSubagentTurnGroup = ReturnType<typeof buildOmpSubagentTurnGroup>;
const INITIAL_VISIBLE_AGENT_COUNT = 5;

/** One compact topology node for all explicitly linked OMP Task calls in a turn. */
export function OmpSubagentTurnCard({
  group,
  parentResponseMessageId,
  onUserInteraction,
}: {
  group: OmpSubagentTurnGroup;
  parentResponseMessageId?: string;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const activeWorkPanelTabId = useAppStore((state) => state.activeWorkPanelTabId);
  const openOmpSubagentBatchTab = useAppStore((state) => state.openOmpSubagentBatchTab);
  const [expanded, setExpanded] = useState(false);

  const visibleAgents = expanded || group.agents.length <= INITIAL_VISIBLE_AGENT_COUNT
    ? group.agents
    : group.agents.slice(0, INITIAL_VISIBLE_AGENT_COUNT);
  const moreCount = group.agents.length - visibleAgents.length;
  const allAgentsSettled = group.agents.length > 0
    && group.agents.length >= group.requestedCount
    && group.runningCount === 0
    && group.unknownCount === 0;
  const outcomeCounts = [
    group.completedCount > 0 ? t("settings.omp.ompBatchCompleted", { n: group.completedCount }) : "",
    group.failedCount > 0 ? t("settings.omp.ompBatchFailed", { n: group.failedCount }) : "",
    group.abortedCount > 0 ? t("settings.omp.ompBatchAborted", { n: group.abortedCount }) : "",
    group.unconfirmedCount > 0 ? t("settings.omp.ompBatchUnconfirmed", { n: group.unconfirmedCount }) : "",
  ].filter(Boolean).join(" · ");

  const jumpToParentReply = () => {
    if (!parentResponseMessageId) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === parentResponseMessageId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("omp-subagent-parent-reply-highlight");
    window.setTimeout(() => target.classList.remove("omp-subagent-parent-reply-highlight"), 1400);
  };

  return <section className="subagent-topology-node omp-subagent-turn-card" role="listitem" data-testid="omp-subagent-turn-card">
    <header className="omp-subagent-turn-card-header">
      <div className="omp-subagent-turn-card-heading">
        <strong>{t("settings.omp.ompBatchTitle")}</strong>
        <span>{t("settings.omp.ompBatchSummary", {
          requested: group.requestedCount,
          observed: group.agents.length,
          running: group.runningCount,
        })}</span>
        {outcomeCounts ? <span className="omp-subagent-turn-card-outcomes">{outcomeCounts}</span> : null}
      </div>
      {parentResponseMessageId
        ? <button type="button" className="omp-subagent-turn-parent-reply" onClick={jumpToParentReply}>{t("settings.omp.subagentMainReplyAvailable")}</button>
        : allAgentsSettled
          ? <span className="omp-subagent-turn-awaiting-reply" role="status">{t("settings.omp.subagentAwaitingMainReply")}</span>
          : null}
      {group.unknownCount > 0
        ? <span className="omp-subagent-turn-card-unknown">{t("settings.omp.subagentStatusUnknown")}: {group.unknownCount}</span>
        : null}
    </header>
    {group.agents.length ? <div className="omp-subagent-turn-agents" id={listId} role="list" aria-label={t("settings.omp.subagentManager")}>
      {visibleAgents.map(({ agent, toolCallId, status, statusKey }, index) => {
        const label = ompSubagentIdentity(agent, index, t("settings.omp.subagentNumber", { number: index + 1 }), group.agents.map((entry) => entry.agent));
        const taskSummary = ompSubagentTaskSummary(agent);
        const taskDetail = ompSubagentTaskDetail(agent);
        const progress = ompSubagentProgressSummary(agent);
        const deliveryPreview = ompSubagentDeliveryPreview(agent.deliveryOutput || agent.deliveryError || agent.deliveryAbortReason);
        const tabId = `omp-subagent-batch:${toolCallId}:${agent.id}`;
        const statusLabel = agent.observedActive === false && (!statusKey || statusKey === "running")
          ? t("settings.omp.subagentNoLongerRunning")
          : statusKey
            ? t(`chat.subagentStatus.${statusKey}`)
            : t("settings.omp.subagentStatusUnknown");

        return <div className="omp-subagent-turn-agent" role="listitem" key={`${toolCallId}:${agent.id}`}>
          <SubagentNodeCard
            title={label}
            summary={taskSummary || undefined}
            summaryDetail={taskDetail || undefined}
            activity={progress || undefined}
            status={status}
            statusLabel={statusLabel}
            expanded={activeWorkPanelTabId === tabId}
            controlsId={`work-panel-surface-${tabId}`}
            disabled={!localToolsAllowed}
            onClick={() => {
              onUserInteraction?.();
              if (localToolsAllowed) openOmpSubagentBatchTab(toolCallId, String(agent.id), label);
            }}
          />
          {deliveryPreview ? <div className="omp-subagent-delivery-preview">
            <span>{t("settings.omp.subagentResultPreview")}</span>
            <p title={String(agent.deliveryOutput || agent.deliveryError || agent.deliveryAbortReason)}>{deliveryPreview}</p>
          </div> : null}
        </div>;
      })}
      {group.agents.length > INITIAL_VISIBLE_AGENT_COUNT ? <button
        type="button"
        className="omp-subagent-turn-more"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >{expanded ? t("common.collapse") : t("common.expandRecent", { count: moreCount })}</button> : null}
    </div> : <p className="omp-subagent-turn-empty" role="status">
      {group.batches.some(({ message }) => message.toolStatus === "running")
        ? t("settings.omp.ompBatchDispatching")
        : t("settings.omp.ompBatchNotStarted")}
    </p>}
  </section>;
}
