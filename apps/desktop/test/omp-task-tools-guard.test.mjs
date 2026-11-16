import assert from "node:assert/strict";
import test from "node:test";
import { OMP_TASK_TOOLS_GUARD_EXTENSION, normalizeOmpTaskToolsInput } from "../electron/main/omp/task-tools-guard.mjs";
import { readFile } from "node:fs/promises";

test("native OMP built-ins mistakenly supplied as Task.tools are omitted before spawn", () => {
  const result = normalizeOmpTaskToolsInput({
    context: "shared context",
    tasks: [{ task: "inspect", agent: "scout" }],
    tools: ["bash", "read", "write", "grep", "glob"],
  });
  assert.deepEqual(result?.input, {
    context: "shared context",
    tasks: [{ task: "inspect", agent: "scout" }],
  });
  assert.equal(result?.removed.length, 5);
  assert.match(result?.additionalContext ?? "", /parent Python\/JS Eval kernel/);
});

test("mixed Task.tools keeps exact Eval names while stripping known OMP built-ins", () => {
  const result = normalizeOmpTaskToolsInput({ tools: ["bash", "project_lookup"] });
  assert.deepEqual(result?.input, { tools: ["project_lookup"] });
});

test("valid custom Eval tools and ambiguous inputs pass through unchanged", () => {
  assert.equal(normalizeOmpTaskToolsInput({ tools: ["project_lookup", "release_notes"] }), null);
  assert.equal(normalizeOmpTaskToolsInput({ tools: ["bash", 3] }), null);
  assert.equal(normalizeOmpTaskToolsInput({ tools: [] }), null);
  assert.equal(normalizeOmpTaskToolsInput({ task: "no tool restriction" }), null);
});

test("installed extension registers a pre-execution hook and applies the same correction", async () => {
  const extensionUrl = `data:text/javascript;base64,${Buffer.from(OMP_TASK_TOOLS_GUARD_EXTENSION).toString("base64")}`;
  const extension = await import(extensionUrl);
  let handler;
  extension.default({ on(event, callback) { assert.equal(event, "tool_call"); handler = callback; } });
  assert.equal(typeof handler, "function");
  const corrected = handler({ toolName: "Task", input: { tasks: [{ task: "x", context: "c" }], tools: ["bash", "read"] } });
  assert.deepEqual(corrected?.input, { tasks: [{ task: "x", context: "c" }] });
  assert.match(corrected?.additionalContext ?? "", /only accepts names of custom tools/);
  assert.equal(handler({ toolName: "read", input: { tools: ["bash"] } }), undefined);

  // OMP has shipped the batch tool under namespaced and lower-cased names; an
  // exact "Task" comparison skipped every real call.
  const namespaced = handler({ toolName: "omp.task", input: { tasks: [{ task: "x", context: "c" }], tools: ["bash"] } });
  assert.deepEqual(namespaced?.input, { tasks: [{ task: "x", context: "c" }] });

  // An empty instruction is provably broken; richer shapes must never be
  // guessed at, because a rejected call costs a full round trip.
  const empty = handler({ toolName: "Task", input: { tasks: [{ task: "", context: "c" }] } });
  assert.match(empty?.additionalContext ?? "", /non-empty/);
  assert.equal(empty?.input, undefined);
  assert.equal(handler({ toolName: "Task", input: { tasks: [{ task: "x" }] } }), undefined);
  assert.equal(handler({ toolName: "Task", input: { tasks: ["plain string task"] } }), undefined);
  const blankString = handler({ toolName: "task", input: { tasks: ["  "] } });
  assert.match(blankString?.additionalContext ?? "", /non-empty/);
  // tools on a task entry is the shape OMP actually received when a batch was
  // rejected with "Unknown eval tool(s)", so it must be cleaned there too.
  const nested = handler({ toolName: "task", input: { tasks: [
    { task: "x", tools: ["read", "bash", "todo", "wait", "eval"] },
    { task: "y", tools: ["my_eval_tool"] },
  ] } });
  assert.deepEqual(nested?.input?.tasks?.[0], { task: "x" });
  assert.deepEqual(nested?.input?.tasks?.[1]?.tools, ["my_eval_tool"]);
});

test("OMP Task batch cards render a native tool failure as failed instead of dispatched", async () => {
  const source = await readFile(new URL("../src/features/chat/transcript/ToolRow.tsx", import.meta.url), "utf8");
  const batchStatus = source.slice(source.indexOf("const statusLabel = ompBatch"), source.indexOf("const delegationPayload =", source.indexOf("const statusLabel = ompBatch")));
  assert.match(batchStatus, /status === "error"[\s\S]*?t\("chat\.toolFailed"\)/);
  assert.match(batchStatus, /status === "denied"[\s\S]*?t\("chat\.toolDenied"\)/);
});
