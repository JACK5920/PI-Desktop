export function normalizeOmpSessionControlState(value) {
  const raw = value && typeof value === "object" ? value : {};
  const queues = raw.queuedMessages && typeof raw.queuedMessages === "object" ? raw.queuedMessages : {};
  return {
    ...(typeof raw.isStreaming === "boolean" ? { isStreaming: raw.isStreaming } : {}),
    ...(typeof raw.isCompacting === "boolean" ? { isCompacting: raw.isCompacting } : {}),
    ...(typeof raw.hasPendingAsyncWork === "boolean" ? { hasPendingAsyncWork: raw.hasPendingAsyncWork } : {}),
    ...(raw.steeringMode === "all" || raw.steeringMode === "one-at-a-time" ? { steeringMode: raw.steeringMode } : {}),
    ...(raw.followUpMode === "all" || raw.followUpMode === "one-at-a-time" ? { followUpMode: raw.followUpMode } : {}),
    ...(raw.interruptMode === "immediate" || raw.interruptMode === "wait" ? { interruptMode: raw.interruptMode } : {}),
    ...(typeof raw.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: raw.autoCompactionEnabled } : {}),
    ...(typeof raw.desktopRpcCapabilities?.supportsBashExcludeFromContext === "boolean" ? { supportsBashExcludeFromContext: raw.desktopRpcCapabilities.supportsBashExcludeFromContext } : {}),
    ...(typeof raw.sessionName === "string" ? { sessionName: raw.sessionName } : {}),
    ...(typeof raw.sessionFile === "string" ? { sessionFile: raw.sessionFile } : {}),
    ...(Number.isSafeInteger(raw.messageCount) && raw.messageCount >= 0 ? { messageCount: raw.messageCount } : {}),
    queuedMessages: {
      steering: Array.isArray(queues.steering) ? queues.steering.filter((message) => typeof message === "string") : [],
      followUp: Array.isArray(queues.followUp) ? queues.followUp.filter((message) => typeof message === "string") : [],
    },
  };
}

export function ompQueueRemovalPayload(queue, message) {
  if (queue !== "steering" && queue !== "followUp") throw new TypeError("Invalid OMP queue");
  if (typeof message !== "string" || message.length === 0) throw new TypeError("OMP queue message is required");
  return { queue, message };
}

export function ompQueuePromotionPayload(message) {
  if (typeof message !== "string" || message.length === 0) throw new TypeError("OMP queue message is required");
  return { message };
}

/** Flatten OMP's native session tree for read-only GUI inspection. This helper
 * deliberately returns entry ids and summaries only; it never changes OMP's
 * active leaf or PI's transcript mirror. */
export function flattenOmpSessionTree(value, limit = 300) {
  const raw = value && typeof value === "object" ? value : {};
  const roots = Array.isArray(raw.tree) ? raw.tree : [];
  const rows = [];
  const visit = (nodes, depth) => {
    for (const node of nodes) {
      if (rows.length >= limit) return;
      const entry = node && typeof node === "object" && node.entry && typeof node.entry === "object" ? node.entry : null;
      if (!entry || typeof entry.id !== "string") continue;
      const message = entry.message && typeof entry.message === "object" ? entry.message : null;
      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ").trim();
      rows.push({
        id: entry.id,
        parentId: typeof entry.parentId === "string" ? entry.parentId : null,
        type: typeof entry.type === "string" ? entry.type : "entry",
        role: typeof message?.role === "string" ? message.role : null,
        depth,
        active: entry.id === raw.leafId,
        label: typeof node.label === "string" ? node.label : null,
        summary: (text || (typeof entry.summary === "string" ? entry.summary : "")).replace(/\s+/g, " ").slice(0, 240),
      });
      if (Array.isArray(node.children)) visit(node.children, depth + 1);
    }
  };
  visit(roots, 0);
  return { leafId: typeof raw.leafId === "string" ? raw.leafId : null, rows, truncated: rows.length >= limit };
}

/** Normalize the native list of user entries that OMP allows the TUI to fork from. */
export function normalizeOmpForkableMessages(value, limit = 200) {
  const raw = value && typeof value === "object" ? value : {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return messages.slice(-limit).flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const entryId = typeof message.entryId === "string" ? message.entryId : typeof message.id === "string" ? message.id : null;
    const text = typeof message.text === "string" ? message.text : "";
    return entryId ? [{ entryId, text: text.replace(/\s+/g, " ").trim().slice(0, 400) }] : [];
  });
}
