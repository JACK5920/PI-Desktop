import { useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/app-store";
import { buildOmpSubagentTurnGroup, isOmpSubagentTurnBatchItem } from "../../../components/omp-subagent-turn-group.mjs";
import { IconTarget } from "../../../components/icons";
import {
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { getOmpSubagentRoster, isOmpTaskBatch, subscribeOmpSubagentRoster } from "../../../components/omp-subagent-roster.mjs";
import { OmpSubagentTurnCard } from "./OmpSubagentTurnCard";
import { ToolRow } from "./ToolRow";

const EMPTY_OMP_ROSTER: readonly Record<string, unknown>[] = [];

/**
 * A truthful one-level graph of one parent fan-out (ADR 0062).
 *
 * The runtime has no delegate-to-delegate edges, so this deliberately stops at
 * main agent -> Task nodes instead of implying dependencies that do not exist.
 */
export function SubagentTopology({
  items,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
}: {
  items: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
}) {
  const hasOmpBatch = items.some(({ message }) => isOmpTaskBatch(message.engineOrigin, message.toolName, message.toolArgs));
  const { t } = useTranslation();
  const labelId = useId();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const subscribeOmpRoster = useCallback((listener: () => void) => activeSessionId
    ? hasOmpBatch ? subscribeOmpSubagentRoster(activeSessionId, listener) : () => undefined
    : () => undefined, [activeSessionId, hasOmpBatch]);
  const getOmpRosterSnapshot = useCallback(() => activeSessionId
    ? hasOmpBatch ? getOmpSubagentRoster(activeSessionId) : EMPTY_OMP_ROSTER
    : EMPTY_OMP_ROSTER, [activeSessionId, hasOmpBatch]);
  const ompRoster = useSyncExternalStore(subscribeOmpRoster, getOmpRosterSnapshot, getOmpRosterSnapshot);
  const ompBatchItems = useMemo(() => items.filter(isOmpSubagentTurnBatchItem), [items]);
  const ompTurnGroup = useMemo(() => buildOmpSubagentTurnGroup(items, [...ompRoster]), [items, ompRoster]);
  const topologyEntries = useMemo(() => {
    let groupInserted = false;
    const entries: Array<{ kind: "omp-group" } | { kind: "tool"; item: DelegationActivityItem }> = [];
    for (const item of items) {
      if (isOmpSubagentTurnBatchItem(item)) {
        if (!groupInserted) {
          entries.push({ kind: "omp-group" });
          groupInserted = true;
        }
      } else {
        entries.push({ kind: "tool", item });
      }
    }
    return entries;
  }, [items]);
  const summary = useMemo(() => {
    const base = summarizeSubagentActivity(items, delegationStatuses);
    const ompBatchToolCallIds = ompBatchItems
      .map(({ message }) => message.toolCallId || message.id);
    const observedOrRequested = ompTurnGroup.agents.length || ompTurnGroup.requestedCount || ompBatchToolCallIds.length;
    return { ...base, total: base.total - ompBatchToolCallIds.length + observedOrRequested };
  }, [items, delegationStatuses, ompBatchItems, ompTurnGroup]);

  return (
    <section className="subagent-topology" aria-labelledby={labelId}>
      <div className="subagent-topology-root">
        <span className="subagent-topology-root-icon" aria-hidden>
          <IconTarget size={16} />
        </span>
        <span className="subagent-topology-root-copy">
          <strong id={labelId}>{t("chat.subagentCoordinator")}</strong>
          <span>
            {t("chat.subagentCoordinating", { count: summary.total })}
          </span>
        </span>
      </div>
      <span className="subagent-topology-connector" aria-hidden />
      <div
        className="subagent-topology-agents"
        role="list"
        aria-label={t("chat.subagentTopology")}
      >
        {topologyEntries.map((entry, index) => {
          if (entry.kind === "omp-group") return <OmpSubagentTurnCard key="omp-subagent-turn-group" group={ompTurnGroup} onUserInteraction={onUserInteraction} />;
          const { item } = entry;
          return <ToolRow
            key={`${item.message.id}:${index}`}
            message={item.message}
            {...(item.delegate ? { delegate: item.delegate } : {})}
            variant="topology"
            onUserInteraction={onUserInteraction}
            {...(delegationStatuses ? { delegationStatuses } : {})}
            {...(delegationTimings ? { delegationTimings } : {})}
          />;
        })}
      </div>
    </section>
  );
}
