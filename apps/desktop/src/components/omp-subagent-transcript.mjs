import { buildOmpSubagentTimeline } from "./omp-subagent-timeline.mjs";
import { ompSubagentImageSource } from "./omp-subagent-image.mjs";

function createdAtOf(timestamp) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) return new Date(timestamp).toISOString();
  return new Date(0).toISOString();
}

function uiMessage(item, role, content, extra = {}) {
  return {
    id: String(item.key),
    role,
    engineOrigin: "omp",
    content: String(content ?? ""),
    createdAt: createdAtOf(item.timestamp),
    status: "complete",
    ...extra,
  };
}

function normalizeDeliveryText(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

/** Use the delivered receipt as the canonical result, then fall back to the latest assistant answer. */
export function getOmpSubagentConclusion(turns, deliveryOutput) {
  const receipt = normalizeDeliveryText(deliveryOutput);
  if (receipt) return { content: receipt, source: "delivery" };
  if (!Array.isArray(turns)) return null;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const rows = Array.isArray(turns[turnIndex]?.rows) ? turns[turnIndex].rows : [];
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const row = rows[rowIndex];
      if (row?.kind !== "answer") continue;
      const content = normalizeDeliveryText(row.message?.content);
      if (content) return { content, source: "transcript" };
    }
  }
  return null;
}

/** Adapt native OMP RPC messages to the common read-only PI subagent transcript view. */
export function buildOmpSubagentTranscriptTurns(messages, agentStatus, labels = {}, assignedTask = "") {
  const timeline = buildOmpSubagentTimeline(messages, agentStatus);
  const turns = [];
  let current = null;
  const ensureTurn = () => {
    if (!current) {
      current = { task: "", rows: [] };
      turns.push(current);
    }
    return current;
  };

  for (const item of timeline) {
    if (item.kind === "message" && item.role === "user") {
      current = { task: item.text, rows: [] };
      turns.push(current);
      continue;
    }
    const turn = ensureTurn();
    if (item.kind === "message") {
      turn.rows.push({ kind: "answer", message: uiMessage(item, "assistant", item.text) });
    } else if (item.kind === "thinking") {
      turn.rows.push({ kind: "thinking", message: uiMessage(item, "assistant", "", { thinking: item.text }) });
    } else if (item.kind === "tool") {
      turn.rows.push({
        kind: "tool",
        message: uiMessage(item, "tool", "", {
          toolName: item.toolName,
          toolCallId: item.callId ?? item.key,
          toolArgs: item.args,
          ...(item.state === "running" ? { toolStatus: "running" } : item.state === "complete" ? { toolStatus: "success" } : item.state === "error" ? { toolStatus: "error", isError: true } : {}),
          ...(item.output ? { toolResult: item.output } : {}),
        }),
      });
    } else if (item.kind === "unlinked-result") {
      const prefix = labels.unlinkedResult ?? "Tool result not linked to a call";
      turn.rows.push({ kind: "answer", message: uiMessage(item, "assistant", `${prefix}${item.toolName ? ` · ${item.toolName}` : ""}\n\n${item.output}`, item.failed ? { error: { message: item.output || prefix } } : {}) });
    } else if (item.kind === "image") {
      const source = ompSubagentImageSource(item.part);
      if (source) turn.rows.push({
        kind: "image",
        message: uiMessage(item, "assistant", ""),
        source,
        alt: labels.image ?? "Image attachment",
      });
    }
  }

  // OMP may expose the assigned prompt only on the roster row rather than in
  // get_subagent_messages. Put that prompt in the same first user turn used by
  // PI's delegation transcript instead of adding a second, visually separate
  // task-details panel. Never duplicate a prompt already present in the log.
  const task = typeof assignedTask === "string" ? assignedTask.trim() : "";
  if (task && !turns.some((turn) => typeof turn.task === "string" && turn.task.trim())) {
    if (turns.length) turns[0] = { ...turns[0], task };
    else turns.push({ task, rows: [] });
  }
  return turns;
}
