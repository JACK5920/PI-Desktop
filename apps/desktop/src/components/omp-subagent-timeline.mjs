function callIdOf(part) {
  const id = part?.toolCallId ?? part?.callId ?? part?.id;
  return typeof id === "string" && id ? id : null;
}

function contentParts(message) {
  return Array.isArray(message?.content)
    ? message.content
    : typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  if (value == null) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function isErrorResult(message) {
  return message?.isError === true || message?.status === "error" || Boolean(message?.error);
}

function isToolResultRole(role) {
  const normalized = String(role ?? "").toLowerCase().replace(/[_-]/g, "");
  return normalized === "tool" || normalized === "toolresult";
}

/**
 * Convert OMP's append-only transcript into an ordered, truthful execution
 * timeline. Tool results are paired only by an explicit call id; unmatched
 * records stay visible and are never presented as a successful action.
 */
export function buildOmpSubagentTimeline(messages, agentStatus) {
  const rows = Array.isArray(messages) ? messages : [];
  const resultsByCallId = new Map();
  const callIds = new Set();
  for (const message of rows) {
    if (isToolResultRole(message?.role)) {
      const id = message.toolCallId ?? message.callId;
      if (typeof id === "string" && id) resultsByCallId.set(id, message);
    }
    for (const part of contentParts(message)) {
      if (part?.type !== "toolCall" && part?.type !== "tool_call") continue;
      const id = callIdOf(part);
      if (id) callIds.add(id);
    }
  }

  const timeline = [];
  const unresolvedCalls = [];
  for (let messageIndex = 0; messageIndex < rows.length; messageIndex += 1) {
    const message = rows[messageIndex];
    const parts = contentParts(message);
    const role = String(message?.role ?? "assistant");
    if (isToolResultRole(role)) {
      const resultId = message.toolCallId ?? message.callId;
      const paired = typeof resultId === "string" && callIds.has(resultId);
      if (!paired) timeline.push({
        key: `unlinked-result:${resultId ?? messageIndex}`,
        kind: "unlinked-result",
        toolName: String(message.toolName ?? message.name ?? "tool"),
        output: textOf(message.content ?? message.result ?? message.output),
        failed: isErrorResult(message),
        timestamp: message.timestamp,
      });
      continue;
    }

    if (!parts.length) {
      const fallback = textOf(message?.content);
      if (fallback) timeline.push({ key: `message:${message?.id ?? messageIndex}`, kind: "message", role, text: fallback, timestamp: message?.timestamp });
      continue;
    }

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if ((part?.type === "toolCall" || part?.type === "tool_call") && typeof part === "object") {
        const callId = callIdOf(part);
        const result = callId ? resultsByCallId.get(callId) : undefined;
        const args = part.arguments ?? part.input ?? {};
        const call = {
          key: `tool:${callId ?? `${message?.id ?? messageIndex}:${partIndex}`}`,
          kind: "tool",
          callId,
          toolName: String(part.name ?? part.toolName ?? "tool"),
          args,
          summary: typeof args === "object" && args
            ? String(args.command ?? args.cmd ?? args.path ?? args.query ?? "")
            : String(args),
          output: result ? textOf(result.content ?? result.result ?? result.output) : "",
          state: result ? isErrorResult(result) ? "error" : "complete" : "unconfirmed",
          timestamp: message?.timestamp,
        };
        timeline.push(call);
        if (!result) unresolvedCalls.push(call);
        continue;
      }
      if (part?.type === "text" && typeof part.text === "string" && part.text) {
        timeline.push({ key: `message:${message?.id ?? messageIndex}:${partIndex}`, kind: "message", role, text: part.text, timestamp: message?.timestamp });
      } else if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
        timeline.push({ key: `thinking:${message?.id ?? messageIndex}:${partIndex}`, kind: "thinking", text: part.thinking, timestamp: message?.timestamp });
      } else if (part?.type === "image") {
        timeline.push({ key: `image:${message?.id ?? messageIndex}:${partIndex}`, kind: "image", part, timestamp: message?.timestamp });
      }
    }
  }

  if (agentStatus === "running" && unresolvedCalls.length) {
    const latest = unresolvedCalls.at(-1);
    latest.state = "running";
  }
  return timeline;
}

function agentName(agent) {
  const named = [agent?.name, agent?.agentName, agent?.label].find((value) => typeof value === "string" && value.trim());
  return named?.trim() ?? "";
}

function compactText(value, maxLength = 156) {
  if (typeof value !== "string") return "";
  const full = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
  if (!full) return "";
  const firstLine = full.split(/(?<=[.!?。！？])\s+/u)[0].trim();
  const summary = firstLine || full;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1).trimEnd()}…` : summary;
}

/** Human-facing short identity; duplicate names receive a stable ID suffix. */
export function ompSubagentIdentity(agent, index, fallback = `subagent-${String(index + 1).padStart(2, "0")}`, peers = []) {
  const named = agentName(agent);
  const id = String(agent?.id ?? "");
  if (!named) return `${fallback}${id ? ` · ${id.slice(-6)}` : ""}`;
  const duplicate = peers.filter((peer) => agentName(peer).toLocaleLowerCase() === named.toLocaleLowerCase());
  if (duplicate.length < 2) return named;
  const suffix = id ? id.slice(-6) : `#${index + 1}`;
  if (duplicate.some((peer) => peer !== agent && String(peer?.id ?? "").slice(-6) === suffix)) return `${named} · ${suffix} (#${index + 1})`;
  return `${named} · ${suffix}`;
}

/** Short task label for cards; the original task remains available in the transcript/details. */
export function ompSubagentTaskSummary(agent) {
  const value = [agent?.task, agent?.description].find((item) => typeof item === "string" && item.trim());
  return compactText(value);
}

/** Current native progress is kept separate from the originally assigned task. */
export function ompSubagentProgressSummary(agent) {
  const progress = agent?.progress && typeof agent.progress === "object" ? agent.progress : {};
  const currentTool = String(progress.currentTool ?? progress.current_tool ?? "").trim();
  const waitingTool = currentTool.toLowerCase() === "wait" || currentTool.toLowerCase() === "vibe_wait";
  const toolIntent = [progress.currentToolIntent, progress.current_tool_intent].find((item) => typeof item === "string" && item.trim());
  const value = [
    progress.stage,
    !waitingTool && currentTool && toolIntent ? `${currentTool}: ${toolIntent}` : !waitingTool ? currentTool : "",
    progress.lastIntent,
    progress.message,
    progress.activity,
    agent?.currentAction,
    agent?.current_action,
  ]
    .find((item) => typeof item === "string" && item.trim());
  return compactText(value, 112);
}

export function ompSubagentRetryState(agent, now = Date.now()) {
  if (!agent || agent.observedActive === false) return null;
  const progress = agent.progress && typeof agent.progress === "object" ? agent.progress : {};
  const retry = progress.retryState ?? progress.retry_state;
  if (!retry || typeof retry !== "object") return null;
  const attempt = Number(retry.attempt);
  const maxAttempts = Number(retry.maxAttempts ?? retry.max_attempts);
  const delayMs = Number(retry.delayMs ?? retry.delay_ms);
  const startedAtMs = Number(retry.startedAtMs ?? retry.started_at_ms);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) return null;
  return {
    attempt: Math.max(0, attempt),
    maxAttempts: Math.max(0, maxAttempts),
    delayMs: Math.max(0, delayMs),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : undefined,
    remainingMs: Number.isFinite(startedAtMs) ? Math.max(0, startedAtMs + Math.max(0, delayMs) - now) : Math.max(0, delayMs),
    errorMessage: compactText(retry.errorMessage ?? retry.error_message, 160),
  };
}

export function ompSubagentRetryFailure(agent) {
  const progress = agent?.progress && typeof agent.progress === "object" ? agent.progress : {};
  const failure = progress.retryFailure ?? progress.retry_failure;
  if (!failure || typeof failure !== "object") return null;
  const attempt = Number(failure.attempt);
  const errorMessage = compactText(failure.errorMessage ?? failure.error_message, 240);
  if (!Number.isFinite(attempt) && !errorMessage) return null;
  return { attempt: Number.isFinite(attempt) ? Math.max(0, attempt) : 0, errorMessage };
}

export function ompSubagentResolvedModel(agent) {
  const progress = agent?.progress && typeof agent.progress === "object" ? agent.progress : {};
  const model = progress.resolvedModelIdentity ?? progress.resolvedModel ?? progress.resolved_model_identity ?? progress.resolved_model;
  return typeof model === "string" ? compactText(model, 96) : "";
}

export function ompSubagentIsFallbackModel(agent) {
  const progress = agent?.progress && typeof agent.progress === "object" ? agent.progress : {};
  return progress.resolvedModelIsFallback === true || progress.resolved_model_is_fallback === true;
}

export function ompSubagentIsRetrying(agent) {
  if (!agent || agent.observedActive === false) return false;
  return ompSubagentStatusKey(ompSubagentLifecycleStatus(agent)) === "running" && Boolean(ompSubagentRetryState(agent));
}

export function ompSubagentStatusKey(status) {
  const value = String(status ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["running", "started", "pending", "in_progress"].includes(value)) return "running";
  if (["waiting", "waiting_on_own_work", "waiting_for_subagents", "waiting_for_jobs"].includes(value)) return "waiting";
  if (["complete", "completed", "success", "succeeded"].includes(value)) return "completed";
  if (["timeout", "timed_out"].includes(value)) return "timed_out";
  if (["cancelled", "canceled", "aborted"].includes(value)) return "aborted";
  if (["stopped", "interrupted"].includes(value)) return "stopped";
  if (["failed", "failure", "error"].includes(value)) return "failed";
  if (value === "denied") return "denied";
  return "";
}

/** OMP keeps a waiting agent's lifecycle status as running; its active tool
 * identifies the two calls that mean it is waiting on its own agents/jobs. */
export function ompSubagentIsWaiting(agent) {
  if (!agent || agent.observedActive === false) return false;
  const status = ompSubagentLifecycleStatus(agent);
  if (ompSubagentStatusKey(status) === "waiting") return true;
  if (ompSubagentStatusKey(status) !== "running") return false;
  const progress = agent.progress && typeof agent.progress === "object" ? agent.progress : {};
  const tool = String(progress.currentTool ?? progress.current_tool ?? agent.currentTool ?? agent.current_tool ?? "")
    .toLowerCase();
  return tool === "wait" || tool === "vibe_wait";
}

/**
 * The status a reader should see, by evidence strength: a delivered
 * `<task-result>` outranks the child's transcript, which outranks OMP's last
 * lifecycle snapshot. A live agent always reports its own live status.
 */
export function ompSubagentLifecycleStatus(agent) {
  const settled = [agent?.deliveryOutcome, agent?.transcriptOutcome]
    .find((value) => typeof value === "string" && value);
  if (settled) return settled;
  if (agent?.observedActive === false) return agent?.lastKnownStatus ?? agent?.status ?? "";
  return agent?.status ?? "";
}

/** Infer an agent's terminal outcome only from an explicit terminal assistant stop reason. */
export function ompSubagentTranscriptOutcome(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const lastMessage = rows.at(-1);
  if (String(lastMessage?.role ?? "").toLowerCase() !== "assistant") return "";
  const reason = String(lastMessage?.stopReason ?? lastMessage?.stop_reason ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["stop", "end_turn", "endturn", "completed", "complete", "success", "succeeded"].includes(reason)) return "completed";
  if (["error", "failed", "failure"].includes(reason)) return "failed";
  if (["aborted", "cancelled", "canceled"].includes(reason)) return "aborted";
  return "";
}

/** Full source text for hover/details; never substitute it for live progress. */
export function ompSubagentTaskDetail(agent) {
  const value = [agent?.task, agent?.description].find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : "";
}
