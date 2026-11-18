const IMAGE_LIMIT = 2 * 1024 * 1024;
const IMAGE_TOTAL_LIMIT = 4 * 1024 * 1024;
const IMAGE_COUNT_LIMIT = 4;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function blocksOf(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value : null;
}

function timestampOf(message, index) {
  const value = message.timestamp ?? message.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  // No data is invented for the content; deterministic IDs remain stable for a
  // given snapshot even when an older OMP entry has no timestamp.
  return new Date(index).toISOString();
}

function safeBashDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value;
  const details = {};
  if (typeof source.exitCode === "number" && Number.isSafeInteger(source.exitCode)) {
    details.exitCode = source.exitCode;
  }
  if (source.fork && typeof source.fork === "object" && !Array.isArray(source.fork)) {
    const fork = {};
    if (typeof source.fork.carried === "boolean") fork.carried = source.fork.carried;
    if (typeof source.fork.jobs === "boolean") fork.jobs = source.fork.jobs;
    if (Object.keys(fork).length > 0) details.fork = fork;
  }
  return Object.keys(details).length > 0 ? details : null;
}

function imageData(block, budget) {
  if (!block || block.type !== "image" || typeof block.data !== "string") return null;
  const mime = typeof block.mimeType === "string" ? block.mimeType.toLowerCase() : "";
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]+=*)$/i.exec(block.data);
  const data = match ? match[2] : block.data;
  const resolvedMime = (match?.[1] ?? mime).toLowerCase();
  if (!data || !IMAGE_TYPES.has(resolvedMime) || (mime && mime !== resolvedMime)) return null;
  if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(data)) return null;
  const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (bytes > IMAGE_LIMIT || budget.total + bytes > IMAGE_TOTAL_LIMIT || budget.count >= IMAGE_COUNT_LIMIT) return null;
  budget.total += bytes;
  budget.count += 1;
  return { dataUrl: `data:${resolvedMime};base64,${data}`, mimeType: resolvedMime };
}

/**
 * Build a PI display transcript only when every OMP snapshot entry is
 * representable. This is intentionally a strict gate for destructive branch
 * synchronization: unknown roles/content and dangling tool calls must never
 * cause a partial transcript replacement.
 */
export function normalizeOmpTranscriptSnapshot(value) {
  const rawMessages = Array.isArray(value) ? value : value?.messages;
  if (!Array.isArray(rawMessages)) return { ok: false, reason: "invalid_messages", messages: [] };
  const toolCalls = new Map();
  const pendingToolIds = new Set();
  for (const message of rawMessages) {
    if (!message || typeof message !== "object") return { ok: false, reason: "invalid_message", messages: [] };
    if (message.role !== "assistant") continue;
    const blocks = blocksOf(message.content);
    if (!blocks) return { ok: false, reason: "unsupported_content", messages: [] };
    for (const block of blocks) {
      if (block?.type === "toolCall" || block?.type === "tool_call") {
        const id = block.id ?? block.toolCallId;
        const name = block.name ?? block.toolName;
        if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
          return { ok: false, reason: "invalid_tool_call", messages: [] };
        }
        toolCalls.set(id, { name, args: block.arguments ?? block.input ?? {} });
        pendingToolIds.add(id);
      }
    }
  }

  const budget = { total: 0, count: 0 };
  const messages = [];
  for (let index = 0; index < rawMessages.length; index += 1) {
    const message = rawMessages[index];
    if (!message || typeof message !== "object" || !["user", "assistant", "tool", "toolResult"].includes(message.role)) {
      return { ok: false, reason: "unsupported_role", messages: [] };
    }
    const blocks = blocksOf(message.content);
    if (!blocks) return { ok: false, reason: "unsupported_content", messages: [] };
    let content = "";
    let thinking = "";
    const inlineImages = [];
    const inlineContent = [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        content += block.text;
        inlineContent.push({ type: "text", text: block.text });
      }
      else if (block?.type === "thinking" && typeof block.thinking === "string" && message.role === "assistant") thinking += block.thinking;
      else if (block?.type === "image" && (message.role === "user" || message.role === "assistant")) {
        const image = imageData(block, budget);
        if (!image) return { ok: false, reason: "unsupported_image", messages: [] };
        inlineImages.push(image);
        inlineContent.push({ type: "image", ...image });
      } else if ((block?.type === "toolCall" || block?.type === "tool_call") && message.role === "assistant") {
        // The associated tool result is represented as its own PI tool row.
      } else return { ok: false, reason: "unsupported_content_block", messages: [] };
    }
    const timestamp = timestampOf(message, index);
    const id = `omp:snapshot:${index}:${Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : index}`;
    if (message.role === "tool" || message.role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : typeof message.id === "string" ? message.id : "";
      const call = toolCalls.get(callId);
      if (callId) pendingToolIds.delete(callId);
      const result = content || blocks.map((block) => block?.text ?? "").filter(Boolean).join("");
      const bashDetails = call?.name?.toLowerCase() === "bash" ? safeBashDetails(message.details) : null;
      messages.push({
        id: callId || id,
        role: "tool",
        engineOrigin: "omp",
        content: result,
        toolCallId: callId || undefined,
        toolName: typeof message.toolName === "string" ? message.toolName : call?.name,
        toolArgs: call?.args,
        toolResult: bashDetails ? { details: bashDetails } : result,
        toolStatus: message.isError === true ? "error" : "success",
        isError: message.isError === true,
        createdAt: timestamp,
        status: "complete",
      });
      continue;
    }
    if (!content.trim() && !thinking.trim() && !inlineImages.length && !blocks.some((block) => block?.type === "toolCall" || block?.type === "tool_call")) {
      return { ok: false, reason: "empty_unrepresentable_message", messages: [] };
    }
    const assistant = message.role === "assistant";
    messages.push({
      id,
      role: message.role,
      content,
      ...(thinking ? { thinking } : {}),
      ...(inlineImages.length ? { inlineImages } : {}),
      ...(inlineImages.length ? { inlineContent } : {}),
      createdAt: timestamp,
      status: "complete",
      ...(assistant && typeof message.model === "string" ? { modelId: message.model, responseModelId: message.model } : {}),
      ...(assistant && typeof message.provider === "string" ? { providerId: message.provider } : {}),
      ...(assistant ? { engineOrigin: "omp" } : {}),
    });
  }
  if (pendingToolIds.size) return { ok: false, reason: "unmatched_tool_call", messages: [] };
  return { ok: true, reason: null, messages };
}

/**
 * Persist both sides of a native OMP fork before retiring its durable recovery
 * journal. Each replace is idempotent, so callers can safely retry the whole
 * pair after a partial Host failure without losing either transcript.
 */
export async function persistOmpForkTranscriptSnapshots(input) {
  const { parentSessionId, childSessionId, parentMessages, childMessages, replaceMessages, complete } = input ?? {};
  if (!parentSessionId || !childSessionId || parentSessionId === childSessionId ||
      !Array.isArray(parentMessages) || !Array.isArray(childMessages) ||
      typeof replaceMessages !== "function" || typeof complete !== "function") {
    throw new TypeError("Invalid OMP fork transcript persistence transaction");
  }
  await replaceMessages(parentSessionId, parentMessages);
  await replaceMessages(childSessionId, childMessages);
  await complete(parentSessionId, childSessionId);
}
