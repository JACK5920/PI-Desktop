import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { buildOmpSubagentTurnGroup } from "../../../components/omp-subagent-turn-group.mjs";
import { ompSubagentIdentity, ompSubagentProgressSummary, ompSubagentTaskDetail, ompSubagentTaskSummary } from "../../../components/omp-subagent-timeline.mjs";
import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useAppStore } from "../../../stores/app-store";
import { SubagentNodeCard } from "./SubagentNodeCard";

type OmpSubagentTurnGroup = ReturnType<typeof buildOmpSubagentTurnGroup>;
const INITIAL_VISIBLE_AGENT_COUNT = 5;

/** One compact topology node for all explicitly linked OMP Task calls in a turn. */
export function OmpSubagentTurnCard({
  group,
  onUserInteraction,
}: {
  group: OmpSubagentTurnGroup;
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

  return <section className="subagent-topology-node omp-subagent-turn-card" role="listitem" data-testid="omp-subagent-turn-card">
    <header className="omp-subagent-turn-card-header">
      <div className="omp-subagent-turn-card-heading">
        <strong>{t("settings.omp.ompBatchTitle")}</strong>
        <span>{t("settings.omp.ompBatchSummary", {
          requested: group.requestedCount,
          observed: group.agents.length,
          running: group.runningCount,
        })}</span>
      </div>
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
