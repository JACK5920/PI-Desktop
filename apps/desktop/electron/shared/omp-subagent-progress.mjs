const TERMINAL_STATUSES = new Set([
  "completed", "complete", "success", "succeeded", "failed", "failure", "error",
  "aborted", "cancelled", "canceled", "stopped", "timed_out", "timeout",
]);
const ACTIVE_STATUSES = new Set(["running", "pending", "started", "in_progress"]);

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizedToolName(value) {
  return String(value ?? "").split(".").at(-1).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * OMP Task results include the spawned child roster in details.progress. Turn
 * that explicit result evidence into the same session roster shape used by
 * lifecycle events. Never infer a child from the requested task count alone.
 */
export function ompSubagentsFromTaskFrame(frame) {
  const raw = asRecord(frame);
  if (!raw) return [];
  const toolCall = asRecord(raw.toolCall);
  const toolName = raw.toolName ?? toolCall?.name ?? raw.name;
  if (normalizedToolName(toolName) !== "task") return [];

  const callId = [raw.toolCallId, toolCall?.id, raw.callId].find((value) => typeof value === "string" && value.trim())?.trim();
  if (!callId) return [];

  const result = asRecord(raw.result ?? raw.partialResult ?? raw.content ?? raw.toolResult);
  const details = asRecord(result?.details) ?? asRecord(raw.details) ?? result;
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  const seen = new Set();
  return progress.flatMap((value) => {
    const row = asRecord(value);
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || id.length > 512 || id.includes("\0") || seen.has(id)) return [];
    seen.add(id);

    const status = typeof row.status === "string" && row.status.trim() ? row.status.trim() : "unknown";
    const normalizedStatus = status.toLowerCase().replace(/[\s-]+/g, "_");
    const explicitParent = [row.parentToolCallId, row.parent_tool_call_id, row.parentCallId]
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    return [{
      ...row,
      id,
      // In Task progress, `agent` is the provider kind (for example "task"),
      // while `id` is the human-supplied job name used in the CLI output.
      name: [row.name, row.agentName, row.label].find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() ?? id,
      status,
      lastKnownStatus: status,
      observedActive: ACTIVE_STATUSES.has(normalizedStatus),
      parentToolCallId: explicitParent?.trim() ?? callId,
      evidenceSource: "task_result",
    }];
  });
}
