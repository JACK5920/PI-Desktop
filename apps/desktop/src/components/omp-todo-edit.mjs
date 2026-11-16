const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned"]);
const MAX_TODO_JSON_BYTES = 1024 * 1024;
const MAX_TREE_NODES = 200_000;
const CORE_PHASE_KEYS = new Set(["name", "tasks"]);
const CORE_TASK_KEYS = new Set(["content", "status"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeExtraFields(value, coreKeys) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !coreKeys.has(key) && !UNSAFE_KEYS.has(key)));
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function coreTodos(phases) {
  if (!Array.isArray(phases)) return null;
  const result = [];
  for (const phase of phases) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || !TODO_STATUSES.has(task.status)) return null;
      tasks.push({ content: task.content, status: task.status });
    }
    result.push({ name: phase.name, tasks });
  }
  return result;
}

/** Validate editable OMP todos while retaining every JSON extension field. */
export function normalizeEditableOmpTodos(phases) {
  const core = coreTodos(phases);
  if (!core || !core.length) return null;
  let serialized;
  try {
    serialized = JSON.stringify(phases);
  } catch {
    return null;
  }
  if (typeof serialized !== "string" || utf8Length(serialized) > MAX_TODO_JSON_BYTES) return null;
  try {
    return jsonClone(phases).map((phase) => ({
      ...safeExtraFields(phase, CORE_PHASE_KEYS),
      name: phase.name,
      tasks: phase.tasks.map((task) => ({
        ...safeExtraFields(task, CORE_TASK_KEYS),
        content: task.content,
        status: task.status,
      })),
    }));
  } catch {
    return null;
  }
}

export function updateEditableOmpTodoTask(phases, phaseIndex, taskIndex, patch) {
  const normalized = normalizeEditableOmpTodos(phases);
  if (!normalized) throw new TypeError("OMP todo snapshot is invalid or exceeds the safe edit limit");
  if (!Number.isInteger(phaseIndex) || !Number.isInteger(taskIndex) || !normalized[phaseIndex]?.tasks[taskIndex]) {
    throw new RangeError("OMP todo task does not exist");
  }
  const task = normalized[phaseIndex].tasks[taskIndex];
  if (patch && Object.hasOwn(patch, "content")) {
    if (typeof patch.content !== "string" || !patch.content.trim()) throw new TypeError("OMP todo task content is required");
    task.content = patch.content.trim();
  }
  if (patch && Object.hasOwn(patch, "status")) {
    if (!TODO_STATUSES.has(patch.status)) throw new TypeError("Invalid OMP todo status");
    task.status = patch.status;
  }
  if (patch && Object.hasOwn(patch, "details")) {
    if (typeof patch.details !== "string") throw new TypeError("OMP todo details must be text");
    if (patch.details.trim()) task.details = patch.details.trim();
    else delete task.details;
  }
  if (patch && Object.hasOwn(patch, "notes")) {
    const notes = Array.isArray(patch.notes)
      ? patch.notes
      : typeof patch.notes === "string"
        ? patch.notes.split(/\r?\n/)
        : null;
    if (!notes || notes.some((note) => typeof note !== "string")) throw new TypeError("OMP todo notes must be text lines");
    const normalizedNotes = notes.map((note) => note.trim()).filter(Boolean);
    if (normalizedNotes.length) task.notes = normalizedNotes;
    else delete task.notes;
  }
  if (utf8Length(JSON.stringify(normalized)) > MAX_TODO_JSON_BYTES) {
    throw new RangeError("OMP todo snapshot exceeds the safe edit limit");
  }
  return normalized;
}

/** Compare only the fields OMP's live TodoTracker exposes through get_state. */
export function sameOmpTodoCore(left, right) {
  const a = coreTodos(left);
  const b = coreTodos(right);
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

function snapshotFromEntry(entry) {
  if (!isRecord(entry)) return null;
  if (entry.type === "custom" && entry.customType === "user_todo_edit") {
    const phases = entry.data?.phases;
    return Array.isArray(phases) ? phases : null;
  }
  const message = entry.type === "message" ? entry.message : null;
  if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) return null;
  if (message.details?.op === "view" || !Array.isArray(message.details?.phases)) return null;
  return message.details.phases;
}

/** Return the durable OMP entries on the current leaf's branch, root first. */
export function activeOmpTreeEntries(tree, leafId) {
  if (!Array.isArray(tree) || typeof leafId !== "string" || !leafId) return [];
  const byId = new Map();
  const stack = [...tree];
  let visited = 0;
  while (stack.length && visited < MAX_TREE_NODES) {
    const node = stack.pop();
    visited += 1;
    if (!isRecord(node) || !isRecord(node.entry) || typeof node.entry.id !== "string") continue;
    if (!byId.has(node.entry.id)) byId.set(node.entry.id, node.entry);
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push(child);
    }
  }
  if (stack.length) return [];
  const branch = [];
  const seen = new Set();
  let current = byId.get(leafId);
  while (current && !seen.has(current.id) && branch.length < MAX_TREE_NODES) {
    seen.add(current.id);
    branch.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  if (current || branch[0]?.id !== leafId) return [];
  branch.reverse();
  return branch;
}

/**
 * Rehydrate Todo extension fields from OMP's own durable session entries.
 * The RPC `get_state` TodoTracker intentionally returns only core fields, but
 * `set_todos` stores the submitted full snapshot in a native `user_todo_edit`
 * entry. This reads that active-branch journal; it creates no PI sidecar.
 */
export function mergeOmpTodoMetadata(phases, tree, leafId) {
  const core = coreTodos(phases);
  if (!core) return null;
  const branch = activeOmpTreeEntries(tree, leafId);
  if (!branch.length) return null;
  const phaseMetadata = new Map();
  const taskMetadata = new Map();
  for (const entry of branch) {
    const snapshot = snapshotFromEntry(entry);
    if (!snapshot) continue;
    const fullEditSnapshot = entry.type === "custom" && entry.customType === "user_todo_edit";
    const snapshotPhaseOccurrences = new Map();
    for (const phase of snapshot) {
      if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue;
      const phaseOccurrence = snapshotPhaseOccurrences.get(phase.name) ?? 0;
      snapshotPhaseOccurrences.set(phase.name, phaseOccurrence + 1);
      const phaseKey = JSON.stringify([phase.name, phaseOccurrence]);
      const extraPhase = safeExtraFields(phase, CORE_PHASE_KEYS);
      if (fullEditSnapshot) phaseMetadata.set(phaseKey, extraPhase);
      else if (Object.keys(extraPhase).length) phaseMetadata.set(phaseKey, { ...(phaseMetadata.get(phaseKey) ?? {}), ...extraPhase });

      const taskOccurrences = new Map();
      for (const task of phase.tasks) {
        if (!isRecord(task) || typeof task.content !== "string") continue;
        const taskOccurrence = taskOccurrences.get(task.content) ?? 0;
        taskOccurrences.set(task.content, taskOccurrence + 1);
        const taskKey = JSON.stringify([phase.name, phaseOccurrence, task.content, taskOccurrence]);
        const extraTask = safeExtraFields(task, CORE_TASK_KEYS);
        if (fullEditSnapshot) taskMetadata.set(taskKey, extraTask);
        else if (Object.keys(extraTask).length) taskMetadata.set(taskKey, { ...(taskMetadata.get(taskKey) ?? {}), ...extraTask });
      }
    }
  }

  const currentPhaseOccurrences = new Map();
  return phases.map((phase) => {
    const phaseOccurrence = currentPhaseOccurrences.get(phase.name) ?? 0;
    currentPhaseOccurrences.set(phase.name, phaseOccurrence + 1);
    const phaseKey = JSON.stringify([phase.name, phaseOccurrence]);
    const taskOccurrences = new Map();
    return {
      ...(phaseMetadata.get(phaseKey) ?? {}),
      ...phase,
      tasks: phase.tasks.map((task) => {
        const taskOccurrence = taskOccurrences.get(task.content) ?? 0;
        taskOccurrences.set(task.content, taskOccurrence + 1);
        const taskKey = JSON.stringify([phase.name, phaseOccurrence, task.content, taskOccurrence]);
        return { ...(taskMetadata.get(taskKey) ?? {}), ...task };
      }),
    };
  });
}

/** Confirm that the active native OMP branch durably recorded this exact edit. */
export function hasOmpTodoSnapshot(tree, leafId, phases) {
  const expected = normalizeEditableOmpTodos(phases);
  if (!expected) return false;
  const branch = activeOmpTreeEntries(tree, leafId);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshotFromEntry(branch[index]);
    if (!snapshot) continue;
    const normalizedSnapshot = normalizeEditableOmpTodos(snapshot);
    if (normalizedSnapshot && JSON.stringify(normalizedSnapshot) === JSON.stringify(expected)) return true;
  }
  return false;
}
