const rosters = new Map();
const rosterListeners = new Map();
const EMPTY_ROSTER = Object.freeze([]);
const TERMINAL_STATUS_KEYS = new Set([
  "completed", "complete", "success", "succeeded", "failed", "failure", "error",
  "aborted", "cancelled", "canceled", "stopped", "timed_out", "timeout", "denied",
]);

function terminalStatus(value) {
  const key = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return TERMINAL_STATUS_KEYS.has(key) ? key : "";
}

const MAX_DELIVERY_BLOCKS = 32;
const MAX_DELIVERY_OUTPUT_CHARS = 12000;

/** Collapse a `<task-result status>` into the roster's small outcome vocabulary. */
function deliveryOutcome(value) {
  const key = String(value ?? "").toLowerCase();
  if (!key) return "";
  if (key.includes("cancel") || key.includes("abort") || key.includes("stop") || key.includes("interrupt")) return "aborted";
  if (key.includes("fail") || key.includes("error") || key.includes("denied")) return "failed";
  if (key.includes("complete") || key.includes("success")) return "completed";
  return "";
}

/** Collapse the stored evidence about one agent into a bucketable outcome. */
function agentOutcome(agent) {
  const key = terminalStatus(agent?.deliveryOutcome) || terminalStatus(agent?.transcriptOutcome)
    || terminalStatus(agent?.lastKnownStatus) || terminalStatus(agent?.status);
  if (!key) return "";
  if (["completed", "complete", "success", "succeeded"].includes(key)) return "completed";
  if (["aborted", "cancelled", "canceled", "stopped", "timed_out", "timeout"].includes(key)) return "aborted";
  return "failed";
}

/**
 * Extract the settled-agent envelopes OMP wraps around every child reply.
 * The `id` attribute is the same registry id the roster stores, so it is the
 * only key allowed to attribute a conclusion. A block is parsed only once its
 * closing tag arrived: a streaming half envelope must never confirm anything.
 */
export function parseOmpTaskResultDeliveries(text) {
  if (typeof text !== "string" || !text.includes("<task-result")) return [];
  const deliveries = [];
  const seen = new Set();
  for (const match of text.matchAll(/<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g)) {
    if (deliveries.length >= MAX_DELIVERY_BLOCKS) break;
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]]),
    );
    const id = String(attributes.id ?? "").trim();
    if (!id || id.length > 512 || id.includes("\0") || seen.has(id)) continue;
    seen.add(id);
    const body = match[2];
    const section = (name) => {
      const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(body);
      return found ? found[1].replace(/\r\n/g, "\n").trim() : "";
    };
    const output = section("output") || section("preview");
    const truncated = output.length > MAX_DELIVERY_OUTPUT_CHARS;
    deliveries.push({
      id,
      agent: String(attributes.agent ?? "").trim(),
      status: String(attributes.status ?? "").trim(),
      duration: String(attributes.duration ?? "").trim(),
      outcome: deliveryOutcome(attributes.status),
      output: truncated ? `${output.slice(0, MAX_DELIVERY_OUTPUT_CHARS)}…` : output,
      outputTruncated: truncated,
      error: section("error"),
      abortReason: section("abort-reason"),
    });
  }
  return deliveries;
}

/** Read a tool row's result as text, whichever shape the runtime stored it in. */
export function ompToolResultText(message) {
  // A structured result survives persistence as JSON, which escapes the
  // attribute quotes; unescape before matching the markup.
  const unescape = (text) => text.includes('\\"')
    ? text.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t")
    : text;
  const asText = (value) => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.flatMap((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  };
  for (const value of [message?.toolResult, message?.content]) {
    const text = asText(value);
    if (text.includes("<task-result")) return unescape(text);
  }
  const raw = message?.toolResult;
  if (raw && typeof raw === "object") {
    try {
      const serialized = JSON.stringify(raw);
      if (serialized.includes("<task-result")) return unescape(serialized);
    } catch {
      return "";
    }
  }
  return "";
}

function publishRoster(sessionId, roster) {
  rosters.delete(sessionId);
  rosters.set(sessionId, roster.slice(-256));
  while (rosters.size > 64) rosters.delete(rosters.keys().next().value);
  const bounded = rosters.get(sessionId);
  for (const listener of rosterListeners.get(sessionId) ?? []) listener(bounded);
  return bounded;
}

export function getOmpSubagentRoster(sessionId) {
  const roster = rosters.get(sessionId);
  if (!roster) return EMPTY_ROSTER;
  rosters.delete(sessionId);
  rosters.set(sessionId, roster);
  return roster;
}

export function subscribeOmpSubagentRoster(sessionId, listener) {
  const listeners = rosterListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  rosterListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) rosterListeners.delete(sessionId);
  };
}

/** Keep subagents observed during this tab's lifetime after they leave OMP's running-only RPC roster. */
export function mergeOmpSubagentRoster(previous, incoming) {
  const next = new Map(previous.map((agent) => [agent.id, { ...agent, observedActive: false }]));
  for (const agent of incoming) {
    const old = next.get(agent.id);
    const archivedInactive = agent.observedActive === false;
    const sameTask = !old?.parentToolCallId || !agent.parentToolCallId || old.parentToolCallId === agent.parentToolCallId;
    const priorTerminal = terminalStatus(old?.transcriptOutcome) || (
      old?.observedActive === false
        ? terminalStatus(old?.lastKnownStatus) || terminalStatus(old?.status)
        : ""
    );
    const incomingTerminal = terminalStatus(agent.transcriptOutcome) || terminalStatus(agent.lastKnownStatus) || terminalStatus(agent.status);
    // A delivered conclusion is the strongest evidence a roster row can hold,
    // so neither a late running snapshot nor transcript inference may undo it.
    const priorDelivery = sameTask ? terminalStatus(old?.deliveryOutcome) : "";
    // A delayed running-only roster response must not undo a terminal outcome
    // already confirmed from the child's transcript. A different parent Task
    // is a new generation and is allowed to start with a fresh state.
    const preserveTerminal = sameTask && Boolean(priorTerminal) && !incomingTerminal;
    const terminal = priorDelivery || incomingTerminal || (preserveTerminal ? priorTerminal : "");
    next.set(agent.id, {
      ...old,
      ...agent,
      id: agent.id,
      observedActive: terminal ? false : archivedInactive ? false : true,
      transcriptOutcome: preserveTerminal ? (old?.transcriptOutcome || priorTerminal) : agent.transcriptOutcome,
      status: priorDelivery || (preserveTerminal ? (old?.transcriptOutcome || priorTerminal) : agent.status),
      lastKnownStatus: priorDelivery || (preserveTerminal ? (old?.transcriptOutcome || priorTerminal) : agent.lastKnownStatus ?? agent.status ?? old?.lastKnownStatus),
    });
  }
  for (const [id, agent] of next) {
    if (!incoming.some((current) => current.id === id)) next.set(id, { ...agent, observedActive: false });
  }
  return [...next.values()];
}

/** Keep transcript-derived terminal evidence separate from OMP's native lifecycle status. */
export function recordOmpSubagentTranscriptOutcome(sessionId, agentId, outcome, options = {}) {
  if (!sessionId || !agentId || !["completed", "failed", "aborted"].includes(outcome)) return getOmpSubagentRoster(sessionId);
  const current = getOmpSubagentRoster(sessionId);
  const agent = current.find((item) => item.id === agentId);
  // Every finished assistant round ends with a terminal stop reason, so a live
  // agent's transcript proves nothing about the task. The poller may override
  // that only after its two-sample confirmation (settled parent plus an
  // unchanged transcript), which it signals with `confirmed`.
  if (!agent || (agent.observedActive !== false && !options.confirmed)) return current;
  return publishRoster(sessionId, current.map((item) => item.id === agentId
    ? { ...item, observedActive: false, transcriptOutcome: outcome }
    : item));
}

export function recordOmpSubagentRoster(sessionId, incoming) {
  return publishRoster(sessionId, mergeOmpSubagentRoster(getOmpSubagentRoster(sessionId), incoming));
}

/**
 * Attach the settled `<task-result>` envelopes found in one tool row to the
 * agents they name. Matching is id-only: the block's id is OMP's registry id,
 * so a same-named task from another batch can never absorb the conclusion.
 * Re-reading the same receipt is a no-op, and a receipt for an agent this tab
 * never observed leaves the roster untouched instead of inventing a parent.
 */
export function recordOmpSubagentDeliveries(sessionId, toolCallId, toolResultText) {
  const current = getOmpSubagentRoster(sessionId);
  if (!sessionId) return current;
  const deliveries = parseOmpTaskResultDeliveries(toolResultText);
  if (!deliveries.length || !current.length) return current;
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  let changed = false;
  const next = current.map((agent) => {
    const delivery = byId.get(agent.id);
    if (!delivery) return agent;
    if (agent.deliveryStatus === delivery.status
      && agent.deliveryOutcome === delivery.outcome
      && agent.deliveryOutput === delivery.output
      && agent.deliveryError === delivery.error) return agent;
    changed = true;
    const outcome = terminalStatus(delivery.outcome);
    return {
      ...agent,
      deliveryStatus: delivery.status,
      deliveryOutcome: outcome || agent.deliveryOutcome || "",
      deliveryOutput: delivery.output,
      deliveryOutputTruncated: delivery.outputTruncated,
      deliveryError: delivery.error,
      deliveryAbortReason: delivery.abortReason,
      deliveryDuration: delivery.duration,
      deliveryToolCallId: typeof toolCallId === "string" && toolCallId ? toolCallId : agent.deliveryToolCallId,
      ...(outcome ? { observedActive: false, status: outcome, lastKnownStatus: outcome } : {}),
    };
  });
  return changed ? publishRoster(sessionId, next) : current;
}

/** Retain lifecycle snapshots from the native OMP event stream, including completed agents. */
export function applyOmpSubagentFrame(sessionId, frame) {
  if (!frame || typeof frame.type !== "string" || !frame.type.startsWith("subagent_")) return getOmpSubagentRoster(sessionId);
  const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : frame;
  const id = typeof payload.id === "string" ? payload.id : typeof payload.progress?.id === "string" ? payload.progress.id : null;
  if (!id) return getOmpSubagentRoster(sessionId);
  const current = getOmpSubagentRoster(sessionId);
  const previous = current.find((agent) => agent.id === id);
  const progress = payload.progress && typeof payload.progress === "object" ? payload.progress : previous?.progress;
  const rawStatus = String(payload.status ?? progress?.status ?? previous?.status ?? (String(frame.type).includes("progress") ? "running" : "unknown"));
  const parentToolCallId = payload.parentToolCallId ?? payload.parent_tool_call_id ?? payload.parentCallId
    ?? progress?.parentToolCallId ?? progress?.parent_tool_call_id ?? progress?.parentCallId;
  const incoming = {
    ...previous,
    ...payload,
    ...(progress ? { progress } : {}),
    ...(typeof parentToolCallId === "string" && parentToolCallId ? { parentToolCallId } : {}),
    id,
    status: rawStatus === "started" ? "running" : rawStatus,
  };
  const active = incoming.status === "running" || incoming.status === "pending";
  // A late "running" frame from OMP's event stream must not undo an outcome
  // already confirmed by a delivered receipt or the child's own transcript.
  const delivered = terminalStatus(previous?.deliveryOutcome);
  const confirmed = delivered
    || (terminalStatus(incoming.status) ? "" : terminalStatus(previous?.transcriptOutcome));
  const keepTerminal = Boolean(confirmed);
  const next = current.filter((agent) => agent.id !== id);
  next.push({
    ...incoming,
    status: keepTerminal ? confirmed : incoming.status,
    observedActive: keepTerminal ? false : active,
    lastKnownStatus: keepTerminal ? confirmed : incoming.status,
  });
  return publishRoster(sessionId, next);
}

export function agentsForOmpToolCall(roster, toolCallId) {
  const linked = roster.filter((agent) => agent.parentToolCallId === toolCallId);
  return { agents: linked.length ? linked : roster, correlated: linked.length > 0 };
}

export function summarizeOmpBatchRoster(roster, toolCallIds) {
  const ids = new Set(toolCallIds);
  const agents = roster.filter((agent) => ids.has(agent.parentToolCallId));
  const outcomes = new Map(agents.map((agent) => [agent, agentOutcome(agent)]));
  const running = agents.filter((agent) => !outcomes.get(agent)
    && agent.observedActive !== false
    && ["running", "pending", "started"].includes(String(agent.status ?? "").toLowerCase())).length;
  const completed = agents.filter((agent) => outcomes.get(agent) === "completed").length;
  const aborted = agents.filter((agent) => outcomes.get(agent) === "aborted").length;
  const failed = agents.filter((agent) => outcomes.get(agent) === "failed").length;
  // Anything that is neither running nor proven terminal stays unconfirmed:
  // OMP dropping an agent from its running-only roster is not an outcome.
  const unconfirmed = agents.length - completed - aborted - failed - running;
  return { agents, total: agents.length, running, finished: completed + aborted + failed, completed, aborted, failed, unconfirmed };
}

/** Backfill provenance for legacy OMP Task batches whose persisted row predates engineOrigin. */
export function isOmpTaskBatch(engineOrigin, toolName, toolArgs) {
  const bareName = String(toolName ?? "").split(".").at(-1).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const tasks = toolArgs && typeof toolArgs === "object" ? toolArgs.tasks : undefined;
  if (engineOrigin === "omp") {
    // An OMP Task row can stream in before its args settle, so the tool name
    // alone identifies the batch. Other OMP tools only count when they carry a
    // `tasks` array — a list/todo call must not pull the roster UI along.
    if (bareName === "task") return true;
    return Array.isArray(tasks);
  }
  return bareName === "task" && Array.isArray(tasks);
}
