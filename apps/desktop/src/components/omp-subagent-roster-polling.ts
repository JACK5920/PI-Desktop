import { useEffect } from "react";
import { api } from "../lib/api";
import {
  getOmpSubagentRoster,
  isOmpTaskBatch,
  ompToolResultText,
  recordOmpSubagentDeliveries,
  recordOmpSubagentRoster,
  recordOmpSubagentTranscriptOutcome,
} from "./omp-subagent-roster.mjs";
import { ompSubagentTranscriptOutcome } from "./omp-subagent-timeline.mjs";
import { useAppStore } from "../stores/app-store";

/**
 * OMP's roster RPC is the only source that knows a subagent stopped running,
 * and its "running" status can go stale once the batch is over. Polling used to
 * live inside the work-panel tab, so a closed panel left every transcript card
 * on its last event frame — finished agents kept reading "running" until the
 * reader opened one. This poller is shared per session and ref-counted, so
 * whichever surface holds the Task rows keeps the roster honest.
 */
const POLL_MS = 2000;
const RETRY_MS = 30_000;

type Poller = {
  refs: number;
  timer: number;
  busy: boolean;
  probed: Set<string>;
  retryAt: Map<string, number>;
  /** Last transcript length per agent, for the two-sample confirmation. */
  seen: Map<string, number>;
  /** Fingerprint of each harvested tool result, so re-polling stays cheap. */
  harvested: Map<string, string>;
};

const pollers = new Map<string, Poller>();

/**
 * OMP delivers each settled child inside a `<task-result>` envelope on the tool
 * result that carried it (`wait`, or the Task call itself). Those rows persist
 * with the conversation, so harvesting them is also how a reopened session
 * recovers conclusions: OMP's roster only lists agents that are still running.
 */
function harvestOmpTaskDeliveries(sessionId: string, poller: Poller): void {
  for (const message of useAppStore.getState().messages ?? []) {
    if (message.role !== "tool" || message.engineOrigin !== "omp") continue;
    const text = ompToolResultText(message);
    if (!text.includes("<task-result")) continue;
    // A result only ever grows, so length plus the tail identifies the revision
    // without retaining every receipt the session produced.
    const fingerprint = `${text.length}\0${text.slice(-64)}`;
    const key = message.id || message.toolCallId || "";
    if (!key || poller.harvested.get(key) === fingerprint) continue;
    poller.harvested.set(key, fingerprint);
    recordOmpSubagentDeliveries(sessionId, message.toolCallId || message.id, text);
  }
}

async function pollRoster(sessionId: string, poller: Poller): Promise<void> {
  if (poller.busy) return;
  poller.busy = true;
  try {
    const result: any = await api.ompRpcCommand({ sessionId, command: "get_subagents" });
    const list = Array.isArray(result?.data?.subagents) ? result.data.subagents : [];
    recordOmpSubagentRoster(
      sessionId,
      list.filter((agent: any) => typeof agent?.id === "string"),
    );
  } catch {
    // OMP can be restarting mid-session; the next tick retries.
  } finally {
    poller.busy = false;
  }
  harvestOmpTaskDeliveries(sessionId, poller);
  await probeSettledTranscripts(sessionId, poller);
}

/**
 * Confirms an agent's terminal state from its transcript.
 *
 * An agent OMP already dropped from its running roster can be confirmed at
 * once. A batch whose parent Task row has settled is also fair game, because
 * OMP's roster can keep reporting those agents as "running" after the fact —
 * but there the transcript must agree twice: a live agent keeps producing rows,
 * so an unchanged length across two polls plus a terminal stop reason is the
 * evidence that it really stopped.
 */
async function probeSettledTranscripts(sessionId: string, poller: Poller): Promise<void> {
  const now = Date.now();
  const settledParents = settledParentToolCallIds();
  const unresolved = getOmpSubagentRoster(sessionId).filter(
    (agent) =>
      !agent.transcriptOutcome &&
      !poller.probed.has(agent.id) &&
      (poller.retryAt.get(agent.id) ?? 0) <= now &&
      (agent.observedActive === false || settledParents.has(agent.parentToolCallId)),
  );
  for (const agent of unresolved) {
    const departed = agent.observedActive === false;
    try {
      const result: any = await api.ompRpcCommand({
        sessionId,
        command: "get_subagent_messages",
        fields: { subagentId: agent.id, fromByte: 0 },
      });
      const rows = Array.isArray(result?.data?.messages) ? result.data.messages : [];
      const outcome = ompSubagentTranscriptOutcome(rows);
      if (!outcome) {
        poller.seen.delete(agent.id);
        // A departed agent that never states a reason will not start doing so.
        if (departed) poller.retryAt.set(agent.id, now + RETRY_MS);
        continue;
      }
      if (!departed) {
        const previousLength = poller.seen.get(agent.id);
        poller.seen.set(agent.id, rows.length);
        if (previousLength !== rows.length) continue;
      }
      poller.probed.add(agent.id);
      poller.seen.delete(agent.id);
      recordOmpSubagentTranscriptOutcome(sessionId, agent.id, outcome, departed ? undefined : { confirmed: true });
    } catch {
      poller.retryAt.set(agent.id, now + RETRY_MS);
    }
  }
}

/** OMP Task rows whose own call has finished, i.e. their batch can no longer be live. */
function settledParentToolCallIds(): Set<string> {
  const ids = new Set<string>();
  for (const message of useAppStore.getState().messages ?? []) {
    if (message.role !== "tool" || message.engineOrigin !== "omp") continue;
    if (!isOmpTaskBatch(message.engineOrigin, message.toolName, message.toolArgs)) continue;
    if (message.toolStatus === "running") continue;
    ids.add(message.toolCallId || message.id);
  }
  return ids;
}

export function useOmpSubagentRosterPolling(sessionId: string | null | undefined): void {
  useEffect(() => {
    if (!sessionId) return;
    let poller = pollers.get(sessionId);
    if (!poller) {
      poller = { refs: 0, timer: 0, busy: false, probed: new Set(), retryAt: new Map(), seen: new Map(), harvested: new Map() };
      pollers.set(sessionId, poller);
    }
    poller.refs += 1;
    if (!poller.timer) {
      void pollRoster(sessionId, poller);
      poller.timer = window.setInterval(() => {
        void pollRoster(sessionId, poller);
      }, POLL_MS);
    }
    return () => {
      const current = pollers.get(sessionId);
      if (!current) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      window.clearInterval(current.timer);
      pollers.delete(sessionId);
    };
  }, [sessionId]);
}
