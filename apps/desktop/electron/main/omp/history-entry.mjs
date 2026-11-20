function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sameContent(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function timestampValue(message) {
  const value = message?.timestamp ?? message?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

function activePath(tree, leafId) {
  const byId = new Map();
  const visit = (nodes) => {
    for (const node of nodes) {
      const entry = node?.entry;
      if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
      if (Array.isArray(node?.children)) visit(node.children);
    }
  };
  visit(Array.isArray(tree) ? tree : []);
  const path = [];
  const seen = new Set();
  let cursor = leafId;
  while (typeof cursor === "string" && cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) return null;
    path.push(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : "";
  }
  return path.reverse();
}

function treeEntries(tree) {
  const entries = [];
  const visit = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node?.entry && typeof node.entry.id === "string") entries.push(node.entry);
      visit(node?.children);
    }
  };
  visit(tree?.tree);
  return entries;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

function messageImageCount(content) {
  return Array.isArray(content) ? content.filter((block) => block?.type === "image").length : 0;
}

function snapshotTimestamp(message, index) {
  return timestampValue(message) ?? index;
}

/** Identify the new OMP user node created by one accepted RPC prompt. */
export function findNewOmpNativeUserEntryId({ beforeTreeSnapshot, afterTreeSnapshot, expectedText, expectedImageCount = 0 } = {}) {
  if (typeof expectedText !== "string" || !Number.isSafeInteger(expectedImageCount) || expectedImageCount < 0) return null;
  const previousIds = new Set(treeEntries(beforeTreeSnapshot).map((entry) => entry.id));
  const afterPath = activePath(Array.isArray(afterTreeSnapshot?.tree) ? afterTreeSnapshot.tree : [], afterTreeSnapshot?.leafId);
  if (!afterPath) return null;
  const activeIds = new Set(afterPath.map((entry) => entry.id));
  const candidates = treeEntries(afterTreeSnapshot).filter((entry) =>
    entry?.type === "message" && entry.message?.role === "user" &&
    !previousIds.has(entry.id) && activeIds.has(entry.id) &&
    messageText(entry.message.content) === expectedText &&
    messageImageCount(entry.message.content) === expectedImageCount,
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * A Host UUID may be paired with a native OMP entry only for an immediately
 * admitted prompt on an idle session. Steers/follow-ups can be queued before
 * OMP appends their user node, so a later tree diff cannot prove which queued
 * request created a matching node.
 */
export function describeOmpNativePromptMappingSkip({
  messageId,
  commandType = "prompt",
  streamingBehavior,
  sessionBusy = false,
  pendingCommandCount = 0,
  nativeState,
} = {}) {
  if (typeof messageId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) return "message-id-not-uuid";
  if (commandType !== "prompt") return "command-type";
  if (streamingBehavior !== undefined) return "streaming-behavior";
  if (sessionBusy) return "session-busy";
  if (pendingCommandCount > 0) return "pending-commands";
  // Older engines omit isStreaming while idle; treating a missing field as
  // "not streaming" keeps mapping capture alive across engine versions instead
  // of silently disabling historical editing.
  if (nativeState?.isStreaming === true) return "native-streaming";
  if (nativeState?.isCompacting === true) return "native-compacting";
  if (nativeState?.hasPendingAsyncWork === true) return "native-async-work";
  if (nativeState?.isSettled === false) return "native-not-settled";
  return null;
}

export function canCaptureOmpNativePromptMapping(input = {}) {
  return describeOmpNativePromptMappingSkip(input) === null;
}

const CONVERSATION_ROLES = new Set(["user", "assistant", "tool", "toolResult"]);

/** OMP reports tool rows as `toolResult` in the tree but `tool` elsewhere. */
function roleKey(message) {
  const role = typeof message?.role === "string" ? message.role : "";
  return role === "tool" ? "toolResult" : role;
}

/**
 * get_messages omits structural assistant nodes that carry no text, thinking,
 * tool call or image (the engine still lists them in get_tree). Comparing the
 * two sequences literally would shift every ordinal after such a node.
 */
function isStructuralAssistantMessage(message) {
  if (roleKey(message) !== "assistant") return false;
  const content = message?.content;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return true;
  return !content.some((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string" ? block.text.trim() !== "" : true;
    if (block.type === "thinking") return typeof block.thinking === "string" ? block.thinking.trim() !== "" : true;
    // Every other block type (toolCall, tool, image, ...) carries payload, so
    // an unknown type must never be treated as a structural placeholder.
    return true;
  });
}

function comparableMessages(messages) {
  return messages.filter((message) =>
    message && typeof message === "object" &&
    CONVERSATION_ROLES.has(roleKey(message)) &&
    !isStructuralAssistantMessage(message));
}

function inspectLegacyLookup({
  messagesSnapshot,
  treeSnapshot,
  text,
  timestampMs,
  role = "user",
  maxDistanceMs = 5 * 60 * 1000,
} = {}) {
  const outcome = (reason, extra = {}) => ({ entryId: null, reason, messageCount: 0, pathMessageCount: 0, ...extra });
  if (typeof text !== "string" || !text) return outcome("invalid-input");
  const rawMessages = Array.isArray(messagesSnapshot)
    ? messagesSnapshot
    : Array.isArray(messagesSnapshot?.messages) ? messagesSnapshot.messages : null;
  if (!rawMessages) return outcome("invalid-input");
  if (!rawMessages.length) return outcome("native-history-empty");
  const expected = typeof timestampMs === "number" && Number.isFinite(timestampMs) ? timestampMs : null;
  const nearByTime = (message) => {
    if (expected === null) return true;
    const value = timestampValue(message);
    return value !== null && Math.abs(value - expected) <= maxDistanceMs;
  };
  const nativeMatches = rawMessages
    .filter((message) =>
      message && typeof message === "object" && message.role === role &&
      messageText(message.content) === text && nearByTime(message))
    .map((message) => ({
      message,
      distance: expected === null ? 0 : Math.abs(timestampValue(message) - expected),
    }))
    .sort((left, right) => left.distance - right.distance);
  if (!nativeMatches.length) return outcome("no-candidate");
  if (nativeMatches.length > 1) {
    if (expected === null) return outcome("ambiguous-candidate");
    if (!Number.isFinite(nativeMatches[0].distance) || nativeMatches[1].distance - nativeMatches[0].distance < 10_000) {
      return outcome("ambiguous-candidate");
    }
  }
  const chosen = nativeMatches[0].message;
  const path = activePath(Array.isArray(treeSnapshot?.tree) ? treeSnapshot.tree : [], treeSnapshot?.leafId);
  if (!path) return outcome("tree-path-unavailable");
  // The snapshot and the tree are read in parallel; if the branch changed in
  // between, their message sequences disagree. Fail closed instead of matching
  // by content alone. Identity then comes from the aligned ordinal, which also
  // separates identical text/time/image duplicates.
  const allMessages = comparableMessages(rawMessages);
  const pathMessages = path.filter((entry) =>
    entry?.type === "message" && entry.message && typeof entry.message.role === "string" &&
    CONVERSATION_ROLES.has(roleKey(entry.message)) && !isStructuralAssistantMessage(entry.message));
  const counts = { messageCount: allMessages.length, pathMessageCount: pathMessages.length };
  if (!allMessages.length || pathMessages.length !== allMessages.length) return outcome("sequence-mismatch", counts);
  const aligned = pathMessages.every((entry, index) => {
    const message = allMessages[index];
    const leftTimestamp = timestampValue(entry.message);
    const rightTimestamp = timestampValue(message);
    // A missing timestamp on either side proves nothing about identity, so it
    // must never count as evidence (null === null would silently pass).
    return leftTimestamp !== null && leftTimestamp === rightTimestamp &&
      roleKey(entry.message) === roleKey(message) &&
      // Full-content fingerprint also covers tool calls, thinking blocks and
      // other non-text parts that can differ between branches.
      messageFingerprint(entry.message.content) === messageFingerprint(message.content);
  });
  if (!aligned) return outcome("sequence-mismatch", counts);
  const ordinal = allMessages.indexOf(chosen);
  const entry = ordinal >= 0 ? pathMessages[ordinal] : null;
  if (!entry || entry.message.role !== role || messageText(entry.message.content) !== text || !nearByTime(entry.message)) {
    return outcome("ordinal-mismatch", counts);
  }
  return { entryId: entry.id, reason: null, ...counts };
}

/**
 * Recover the native entry for a prompt sent before mapping capture existed.
 * The desktop row and the native node share text and an approximate timestamp;
 * anything short of one unambiguous candidate stays unresolved so a wrong
 * edit can never rewrite an unrelated turn.
 */
export function lookupOmpNativeEntryIdForLegacyMessage(input = {}) {
  return inspectLegacyLookup(input).entryId;
}

/** Explain why a legacy rebuild returned nothing; logs must never carry prompt text. */
export function describeOmpNativeLegacyLookup(input = {}) {
  const { entryId, reason, messageCount, pathMessageCount } = inspectLegacyLookup(input);
  return { entryId, reason, messageCount, pathMessageCount };
}

function messageFingerprint(content) {
  if (content === undefined || content === null) return String(content);
  try {
    // Sorted keys keep the fingerprint stable when the two RPC paths emit the
    // same object with a different field order.
    return JSON.stringify(stableValue(content));
  } catch {
    return String(content);
  }
}

function chooseByTimestamp(candidates, expectedTimestamp, maxDistanceMs = 5 * 60 * 1000) {
  if (expectedTimestamp === null) return candidates.length === 1 ? candidates[0] : null;
  const timed = candidates.map((candidate) => ({
    candidate,
    distance: timestampValue(candidate.message) === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(timestampValue(candidate.message) - expectedTimestamp),
  })).filter((candidate) => candidate.distance <= maxDistanceMs)
    .sort((left, right) => left.distance - right.distance);
  if (!timed.length || (timed.length > 1 && timed[0].distance === timed[1].distance)) return null;
  return timed[0].candidate;
}

/**
 * Resolve a renderer message id back to an OMP-owned entry id. Snapshot ids
 * are verified by index and timestamp; live PI UUIDs require a persisted
 * message-to-entry mapping captured when the OMP prompt was accepted. In both
 * cases, the native message must still be on the active OMP tree path.
 */
export function resolveOmpNativeMessageEntryId({ messageId, messagesSnapshot, treeSnapshot, requiredRole, nativeEntryId } = {}) {
  const rawMessages = Array.isArray(messagesSnapshot)
    ? messagesSnapshot
    : Array.isArray(messagesSnapshot?.messages) ? messagesSnapshot.messages : null;
  if (!rawMessages) return null;

  const match = typeof messageId === "string"
    ? /^omp:snapshot:(\d+):(\d+)$/.exec(messageId)
    : null;
  const path = activePath(Array.isArray(treeSnapshot?.tree) ? treeSnapshot.tree : [], treeSnapshot?.leafId);
  if (!path) return null;

  if (match) {
    const index = Number(match[1]);
    const expectedSnapshotTimestamp = Number(match[2]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= rawMessages.length ||
      !Number.isSafeInteger(expectedSnapshotTimestamp) || snapshotTimestamp(rawMessages[index], index) !== expectedSnapshotTimestamp) return null;
    const raw = rawMessages[index];
    if (!raw || typeof raw !== "object" || !["user", "assistant"].includes(raw.role) || (requiredRole && raw.role !== requiredRole)) return null;
    const matches = path.filter((entry) => entry?.type === "message" && entry.message?.role === raw.role &&
      sameContent(entry.message.content, raw.content) &&
      (timestampValue(raw) === null || timestampValue(entry.message) === null || timestampValue(raw) === timestampValue(entry.message)));
    if (matches.length === 1) return matches[0].id;
    if (!matches.length) return null;
    const ordinal = rawMessages.slice(0, index + 1).filter((candidate) =>
      candidate?.role === raw.role && sameContent(candidate?.content, raw.content) &&
      (timestampValue(raw) === null || timestampValue(candidate) === timestampValue(raw)),
    ).length - 1;
    return Number.isSafeInteger(ordinal) && ordinal >= 0 ? matches[ordinal]?.id ?? null : null;
  }

  if (typeof nativeEntryId !== "string" || !nativeEntryId) return null;
  const mapped = findOmpNativeTreeEntry(treeSnapshot, nativeEntryId);
  if (mapped?.type !== "message" || mapped.message?.role !== (requiredRole ?? "user") ||
    !path.some((entry) => entry.id === nativeEntryId)) return null;
  return nativeEntryId;
}

/** Find one native tree message; callers still validate role and session state. */
export function findOmpNativeTreeEntry(treeSnapshot, entryId) {
  if (typeof entryId !== "string" || !entryId) return null;
  const visit = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node?.entry?.id === entryId) return node.entry;
      const nested = visit(node?.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(treeSnapshot?.tree);
}
