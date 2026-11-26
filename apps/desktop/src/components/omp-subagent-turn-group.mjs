import { isOmpTaskBatch } from "./omp-subagent-roster.mjs";
import { ompSubagentIsRetrying, ompSubagentIsWaiting, ompSubagentLifecycleStatus, ompSubagentStatusKey } from "./omp-subagent-timeline.mjs";
import { ompSubagentsFromTaskFrame } from "../../electron/shared/omp-subagent-progress.mjs";

function toolCallIdOf(item) {
  const message = item?.message;
  const id = message?.toolCallId || message?.id;
  return typeof id === "string" && id ? id : null;
}

function requestedCountOf(item) {
  const tasks = item?.message?.toolArgs?.tasks;
  return Array.isArray(tasks) ? tasks.length : 0;
}

export function isOmpSubagentTurnBatchItem(item) {
  const message = item?.message;
  if (!isOmpTaskBatch(message?.engineOrigin, message?.toolName, message?.toolArgs)) return false;
  const toolName = String(message?.toolName ?? "").split(".").at(-1).toLowerCase().replace(/[^a-z0-9]+/g, "");
  return toolName === "task" || Array.isArray(message?.toolArgs?.tasks);
}

function normalizedAgentState(agent) {
  const inactive = agent?.observedActive === false;
  // Delivered receipt > transcript outcome > last lifecycle snapshot.
  const rawStatus = ompSubagentLifecycleStatus(agent);
  const statusKey = ompSubagentStatusKey(rawStatus);
  if (!inactive && ompSubagentIsWaiting(agent)) return { status: "waiting", statusKey: "waiting" };
  if (!inactive && ompSubagentIsRetrying(agent)) return { status: "retrying", statusKey };
  if (!inactive && statusKey === "running") return { status: "running", statusKey };
  if (inactive && ["completed", "timed_out", "aborted", "stopped", "failed", "denied"].includes(statusKey)) {
    return { status: statusKey, statusKey };
  }
  if (!inactive && ["completed", "timed_out", "aborted", "stopped", "failed", "denied"].includes(statusKey)) {
    return { status: statusKey, statusKey };
  }
  return { status: "unknown", statusKey };
}

/**
 * Build a turn-scoped OMP group without correlating agents by timing or name.
 * Only explicit parentToolCallId links from Task calls in this assistant turn
 * are included; unrelated session agents stay out of the card.
 */
export function buildOmpSubagentTurnGroup(items, roster) {
  const batches = (Array.isArray(items) ? items : []).filter(isOmpSubagentTurnBatchItem);
  const orderedCallIds = batches.map(toolCallIdOf).filter(Boolean);
  const callOrder = new Map(orderedCallIds.map((id, index) => [id, index]));
  // `get_subagents` is a running-only snapshot and lifecycle events may arrive
  // late or be missed while the RPC session is attaching. OMP Task results
  // carry an explicit `details.progress[]` roster, so use that as durable
  // per-call evidence and let richer native/archive rows override it.
  const resultAgents = batches.flatMap((item) => {
    const message = item?.message;
    const toolCallId = toolCallIdOf(item);
    return message && toolCallId
      ? ompSubagentsFromTaskFrame({ toolName: message.toolName, toolCallId, toolResult: message.toolResult })
      : [];
  });
  const mergedRoster = new Map();
  for (const agent of resultAgents) {
    const parentToolCallId = agent.parentToolCallId;
    mergedRoster.set(`${parentToolCallId}\0${agent.id}`, agent);
  }
  for (const agent of Array.isArray(roster) ? roster : []) {
    const parentToolCallId = typeof agent?.parentToolCallId === "string" && agent.parentToolCallId
      ? agent.parentToolCallId
      : resultAgents.find((candidate) => candidate.id === agent?.id)?.parentToolCallId;
    const resultAgent = resultAgents.find((candidate) => candidate.id === agent?.id && (!parentToolCallId || candidate.parentToolCallId === parentToolCallId));
    const merged = { ...resultAgent, ...agent, ...(parentToolCallId ? { parentToolCallId } : {}) };
    const key = parentToolCallId ? `${parentToolCallId}\0${agent.id}` : String(agent?.id ?? "");
    if (key) mergedRoster.set(key, merged);
  }
  const sourceRoster = [...mergedRoster.values()];
  const agents = sourceRoster
    .map((agent, rosterIndex) => ({ agent, rosterIndex, parentToolCallId: agent?.parentToolCallId }))
    .filter(({ agent, parentToolCallId }) =>
      typeof agent?.id === "string" && callOrder.has(parentToolCallId),
    )
    .sort((left, right) =>
      callOrder.get(left.parentToolCallId) - callOrder.get(right.parentToolCallId) ||
      left.rosterIndex - right.rosterIndex,
    )
    .map(({ agent, parentToolCallId }) => ({
      agent,
      toolCallId: parentToolCallId,
      ...normalizedAgentState(agent),
    }));
  const uniqueAgents = [...new Map(agents.map((entry) => [entry.agent.id, entry])).values()];

  return {
    batches,
    toolCallIds: orderedCallIds,
    requestedCount: batches.reduce((total, item) => total + requestedCountOf(item), 0),
    agents: uniqueAgents,
    runningCount: uniqueAgents.filter((entry) => entry.status === "running").length,
    waitingCount: uniqueAgents.filter((entry) => entry.status === "waiting").length,
    retryingCount: uniqueAgents.filter((entry) => entry.status === "retrying").length,
    completedCount: uniqueAgents.filter((entry) => entry.status === "completed").length,
    failedCount: uniqueAgents.filter((entry) => ["failed", "timed_out", "denied"].includes(entry.status)).length,
    abortedCount: uniqueAgents.filter((entry) => ["aborted", "stopped"].includes(entry.status)).length,
    unknownCount: uniqueAgents.filter((entry) => entry.status === "unknown").length,
    unconfirmedCount: uniqueAgents.filter((entry) => entry.status === "unknown").length,
  };
}
