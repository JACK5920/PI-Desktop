import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import type { OmpRpcFrame } from "./rpc-runtime";

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block: any) => {
    if (block?.type === "text" && typeof block.text === "string") return [block.text];
    return [];
  }).join("");
}

function thinkingContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((block: any) => {
    if (block?.type === "thinking" && typeof block.thinking === "string") return [block.thinking];
    return [];
  }).join("");
}

function orderedInlineContent(value: unknown): Array<
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; mimeType: string }
> {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const output: Array<
    | { type: "text"; text: string }
    | { type: "image"; dataUrl: string; mimeType: string }
  > = [];
  let totalChars = 0;
  let imageCount = 0;
  for (const block of value) {
    if (block?.type === "text" && typeof block.text === "string") {
      output.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type !== "image" || typeof block.data !== "string") continue;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType.toLowerCase() : "";
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]+=*)$/i.exec(block.data);
    const base64 = match ? match[2] : block.data;
    const resolvedMime = match ? match[1].toLowerCase() : mimeType;
    if (!base64 || !allowed.has(resolvedMime) || (mimeType && mimeType !== resolvedMime) || !/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(base64)) continue;
    const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (base64.length > 2 * 1024 * 1024 || bytes > 2 * 1024 * 1024 || totalChars + base64.length > 4 * 1024 * 1024 || imageCount >= 4) continue;
    totalChars += base64.length;
    imageCount += 1;
    output.push({ type: "image", dataUrl: `data:${resolvedMime};base64,${base64}`, mimeType: resolvedMime });
  }
  return output;
}

function plainCommandOutput(value: unknown): string {
  if (typeof value !== "string") return "";
  // TUI-oriented local slash commands can include ANSI styling; render only
  // their readable text in PI's transcript surface.
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function finiteAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** OMP reports pi-style usage on assistant snapshots. Accept both the short
 * (`input`/`output`) and verbose (`inputTokens`) spellings, but never invent a
 * number for a frame that only carried partial data: the footer would then
 * show a confidently wrong cost. */
function ompUsage(value: unknown): UiMessage["usage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const parsed = finiteCount(raw[key]);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  };
  const inputTokens = pick("input", "inputTokens");
  const outputTokens = pick("output", "outputTokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadTokens = pick("cacheRead", "cacheReadTokens");
  const cacheWriteTokens = pick("cacheWrite", "cacheWriteTokens");
  const totalTokens =
    pick("totalTokens") ??
    inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const rawCost = raw.cost;
  const cost =
    rawCost && typeof rawCost === "object"
      ? (() => {
          const source = rawCost as Record<string, unknown>;
          const fields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
          const resolved = fields.map((field) => finiteAmount(source[field]));
          if (resolved.some((amount) => amount === undefined)) return undefined;
          const [input, output, cacheRead, cacheWrite, total] = resolved as number[];
          return { input, output, cacheRead, cacheWrite, total };
        })()
      : undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    totalTokens,
    ...(cost ? { cost, costStatus: "reported" as const } : {}),
  };
}

export function ompMessageToUiMessage(value: unknown, messageId: string, status: UiMessage["status"]): UiMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, any>;
  if (message.role !== "assistant" && message.role !== "user") return null;
  const createdAt = typeof message.timestamp === "number"
    ? new Date(message.timestamp).toISOString()
    : typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString();
  const isAssistant = message.role === "assistant";
  const usage = isAssistant ? ompUsage(message.usage) : undefined;
  const orderedContent = orderedInlineContent(message.content);
  const inlineImages = orderedContent.flatMap((block) => block.type === "image"
    ? [{ dataUrl: block.dataUrl, mimeType: block.mimeType }]
    : []);
  // OMP times are milliseconds as floats; the durable side stores integers.
  const duration = isAssistant ? finiteCount(message.duration) : undefined;
  const ttft = isAssistant ? finiteCount(message.ttft) : undefined;
  return {
    id: messageId,
    role: message.role,
    content: textContent(message.content),
    ...(thinkingContent(message.content) ? { thinking: thinkingContent(message.content) } : {}),
    ...(inlineImages.length ? { inlineImages } : {}),
    ...(orderedContent.some((block) => block.type === "image") ? { inlineContent: orderedContent } : {}),
    createdAt,
    status,
    // Both fields are set so the footer renders even when the two names agree;
    // `modelId` alone used to be the only gate, which hid every OMP reply.
    ...(typeof message.model === "string"
      ? { modelId: message.model, responseModelId: message.model }
      : {}),
    ...(isAssistant && typeof message.provider === "string"
      ? { providerId: message.provider }
      : {}),
    ...(isAssistant ? { engineOrigin: "omp" as const } : {}),
    ...(usage ? { usage } : {}),
    ...(duration !== undefined ? { responseDurationMs: duration } : {}),
    ...(ttft !== undefined ? { providerWaitMs: ttft } : {}),
    ...(duration !== undefined && ttft !== undefined
      ? { modelStreamDurationMs: Math.max(0, duration - ttft) }
      : {}),
  };
}

/** Convert only the shared conversation/tool lifecycle subset. All raw OMP
 * frames are also delivered to the OMP UI channel so OMP-specific controls
 * never need to be represented as PI runtime events. */
export function ompFrameToAgentEvent(input: {
  sessionId: string;
  runId: string;
  turnId?: string;
  frame: OmpRpcFrame;
  messageIds: Set<string>;
}): AgentEventEnvelope | null {
  const { sessionId, runId, turnId, frame, messageIds } = input;
  const ts = Date.now();
  const envelope = (event: AgentEventEnvelope["event"]): AgentEventEnvelope => ({ sessionId, ...(turnId ? { turnId } : {}), ts, event });
  switch (frame.type) {
    case "agent_start": return envelope({ type: "agent_start" });
    case "turn_start": return envelope({ type: "turn_start" });
    case "turn_end": return envelope({ type: "turn_end" });
    case "command_output": {
      const content = plainCommandOutput(frame.text);
      if (!content.trim()) return null;
      const id = `omp:${runId}:command-output:${messageIds.size + 1}`;
      const message = ompMessageToUiMessage({ role: "assistant", content, timestamp: ts }, id, "complete");
      if (!message) return null;
      messageIds.add(id);
      return envelope({ type: "message_end", message });
    }
    case "message_start":
    case "message_update":
    case "message_end": {
      const messageId = typeof frame.messageId === "string" ? frame.messageId : undefined;
      if (!messageId) return null;
      const raw = frame.message;
      const role = (raw as any)?.role;
      if (role !== "assistant") return null; // user rows are persisted before RPC admission; tool results have tool_execution_* events.
      const status = frame.type === "message_end" ? "complete" : "streaming";
      // OMP message IDs are only unique within one RPC process. Prefix the
      // durable PI row ID with this process run ID to avoid collisions after
      // a desktop restart or an OMP process recovery.
      const durableMessageId = `omp:${runId}:${messageId}`;
      const message = ompMessageToUiMessage(raw, durableMessageId, status);
      if (!message) return null;
      messageIds.add(durableMessageId);
      if (frame.type === "message_start") return envelope({ type: "message_start", message });
      if (frame.type === "message_update") return envelope({ type: "message_update", message });
      return envelope({ type: "message_end", message });
    }
    case "tool_execution_start": {
      const toolCall = frame.toolCall as Record<string, unknown> | undefined;
      const toolCallId = String(frame.toolCallId ?? toolCall?.id ?? "");
      const toolName = String(frame.toolName ?? toolCall?.name ?? "unknown");
      if (!toolCallId) return null;
      return envelope({ type: "tool_start", toolCallId, toolName, args: frame.args ?? frame.arguments ?? toolCall?.arguments ?? {}, engineOrigin: "omp" });
    }
    case "tool_execution_update": {
      const toolCallId = String(frame.toolCallId ?? "");
      return toolCallId ? envelope({ type: "tool_update", toolCallId, partialResult: frame.partialResult ?? frame.result }) : null;
    }
    case "tool_stream_update": {
      const toolCallId = String(frame.toolCallId ?? "");
      return toolCallId ? envelope({ type: "tool_update", toolCallId, partialResult: frame.update }) : null;
    }
    case "tool_execution_end": {
      const toolCallId = String(frame.toolCallId ?? "");
      return toolCallId ? envelope({ type: "tool_end", toolCallId, result: frame.result ?? frame.content ?? "", isError: frame.isError === true }) : null;
    }
    case "prompt_result": {
      if (frame.status === "completed") {
        // OMP can yield while async work is still able to wake the session.
        // Keep PI's durable turn open until RPC reports session_settled.
        return frame.sessionSettled === false ? null : envelope({ type: "agent_end", messageIds: [...messageIds] });
      }
      const errorText = typeof frame.error === "string" ? frame.error : String((frame.error as any)?.message ?? (frame.status === "aborted" ? "任务已停止" : "OMP 任务失败"));
      return envelope({ type: "error", error: {
        code: frame.status === "aborted" ? "TURN_ABORTED" : String((frame.error as any)?.code ?? "OMP_RUNTIME_ERROR"),
        message: errorText,
        retriable: Boolean((frame.error as any)?.retryable),
      } });
    }
    case "session_settled":
      return envelope({ type: "agent_end", messageIds: [...messageIds] });
    case "runtime_error":
      return envelope({ type: "error", error: { code: "OMP_RUNTIME_ERROR", message: String(frame.message ?? "OMP runtime error"), retriable: true } });
    default: return null;
  }
}
