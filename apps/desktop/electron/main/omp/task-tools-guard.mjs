/** Native OMP tools that are commonly, but incorrectly, passed to Task.tools. */
export const OMP_NATIVE_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "todo",
  "wait",
  "eval",
  "Task",
  "TaskWait",
  "TaskStop",
  "TaskList",
]);

const nativeToolNames = new Set(OMP_NATIVE_TOOL_NAMES.map((name) => name.toLowerCase()));

function sanitizeToolList(list) {
  if (!Array.isArray(list) || !list.length || list.some((name) => typeof name !== "string")) return null;
  const isNativeTool = (name) => nativeToolNames.has(name.toLowerCase());
  const removed = list.filter(isNativeTool);
  if (!removed.length) return null;
  return { kept: list.filter((name) => !isNativeTool(name)), removed };
}

/**
 * `Task.tools` is for names registered in OMP's parent Eval kernel, not its
 * built-in tool catalog. A batch may carry `tools` at the top level or inside
 * each task entry, and OMP validates both, so both are cleaned here. Correct
 * only an unambiguous native-tool list; unknown names are left to OMP's native
 * validation, preserving custom Eval tools.
 */
export function normalizeOmpTaskToolsInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const removed = [];
  const next = { ...input };
  const top = sanitizeToolList(next.tools);
  if (top) {
    removed.push(...top.removed);
    if (top.kept.length) next.tools = top.kept;
    else delete next.tools;
  }
  if (Array.isArray(next.tasks)) {
    next.tasks = next.tasks.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const hit = sanitizeToolList(item.tools);
      if (!hit) return item;
      removed.push(...hit.removed);
      const nextItem = { ...item };
      if (hit.kept.length) nextItem.tools = hit.kept;
      else delete nextItem.tools;
      return nextItem;
    });
  }
  if (!removed.length) return null;
  return {
    input: next,
    removed,
    additionalContext: "Task.tools only accepts names of custom tools already defined in the parent Python/JS Eval kernel. The listed native OMP tools were removed from Task.tools; they remain governed by OMP's normal native tool behavior. Use Task.tools only for exact Eval-defined tool names, or omit it.",
  };
}

/** Installed into the app-owned OMP profile and loaded through OMP's public -e extension option. */
export const OMP_TASK_TOOLS_GUARD_EXTENSION = String.raw`
const nativeToolNames = new Set(${JSON.stringify(OMP_NATIVE_TOOL_NAMES.map((name) => name.toLowerCase()))});
const TASK_CONTRACT = "Task.tasks[] entries need complete, self-contained instructions: either a non-empty string or an object with a non-empty 'task' field. Omit 'tools' unless every name is an exact custom tool already defined in the parent Python/JS Eval kernel.";

// OMP has shipped the batch tool under namespaced and differently cased names,
// so an exact "Task" comparison would skip every real call.
function isTaskToolName(name) {
  const bare = String(name ?? "").split(".").at(-1).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return bare === "task";
}

export default function registerPiDesktopTaskToolsGuard(pi) {
  pi.on("tool_call", (event) => {
    if (!isTaskToolName(event.toolName)) return;
    const input = event.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const tasks = Array.isArray(input.tasks) ? input.tasks : null;
    if (tasks) {
      // Entries may be plain strings or objects, and OMP does not require a
      // context field, so only a provably empty instruction counts. A false
      // positive is expensive: OMP surfaces additionalContext as a rejected
      // call, which costs the model a whole round trip.
      const broken = tasks.findIndex((item) =>
        typeof item === "string" ? !item.trim()
          : !!item && typeof item === "object" && "task" in item && !String(item.task ?? "").trim());
      if (broken >= 0) {
        return { additionalContext: TASK_CONTRACT + " tasks[" + broken + "] is empty." };
      }
    }
    const isNativeTool = (name) => nativeToolNames.has(name.toLowerCase());
    const sanitize = (list) => {
      if (!Array.isArray(list) || !list.length || list.some((name) => typeof name !== "string")) return null;
      const removed = list.filter(isNativeTool);
      if (!removed.length) return null;
      return { kept: list.filter((name) => !isNativeTool(name)), removed };
    };
    const removedAll = [];
    const correctedInput = { ...input };
    const top = sanitize(correctedInput.tools);
    if (top) {
      removedAll.push(...top.removed);
      if (top.kept.length) correctedInput.tools = top.kept;
      else delete correctedInput.tools;
    }
    // tools may also sit on each task entry; OMP validates that copy too, and
    // cleaning only the top level let a bad batch reach the eval kernel.
    if (Array.isArray(correctedInput.tasks)) {
      correctedInput.tasks = correctedInput.tasks.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const hit = sanitize(item.tools);
        if (!hit) return item;
        removedAll.push(...hit.removed);
        const nextItem = { ...item };
        if (hit.kept.length) nextItem.tools = hit.kept;
        else delete nextItem.tools;
        return nextItem;
      });
    }
    if (!removedAll.length) return;
    return {
      input: correctedInput,
      additionalContext: "Task.tools only accepts names of custom tools already defined in the parent Python/JS Eval kernel. The listed native OMP tools were removed from Task.tools; they remain governed by OMP's normal native tool behavior. Use Task.tools only for exact Eval-defined tool names, or omit it.",
    };
  });
}
`;
