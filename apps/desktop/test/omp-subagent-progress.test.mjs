import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { OmpSubagentArchive } from "../electron/main/omp/subagent-archive.mjs";
import { archiveOmpTaskProgress } from "../electron/main/omp/subagent-progress-archive.mjs";
import { ompSubagentsFromTaskFrame } from "../electron/shared/omp-subagent-progress.mjs";
import { buildOmpSubagentTurnGroup } from "../src/components/omp-subagent-turn-group.mjs";

async function loadOmpEventAdapter() {
  const source = await readFile(new URL("../electron/main/omp/rpc-event-adapter.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("OMP Task result progress is explicit child evidence with exact parent call and status", () => {
  const agents = ompSubagentsFromTaskFrame({
    type: "tool_execution_end",
    toolName: "Task",
    toolCallId: "call-batch",
    result: { details: { progress: [
      { id: "FsProbe", agent: "task", task: "Inspect files", status: "pending" },
      { id: "SearchProbe", agent: "task", task: "Search tests", status: "completed" },
      { id: "bad\u0000id", task: "invalid", status: "running" },
      { task: "missing identity", status: "running" },
    ] } },
  });

  assert.deepEqual(agents.map((agent) => [agent.id, agent.name, agent.parentToolCallId, agent.status, agent.observedActive]), [
    ["FsProbe", "FsProbe", "call-batch", "pending", true],
    ["SearchProbe", "SearchProbe", "call-batch", "completed", false],
  ]);
  assert.ok(agents.every((agent) => agent.evidenceSource === "task_result"));
});

test("OMP Task progress does not manufacture agents for malformed calls or non-Task tools", () => {
  assert.deepEqual(ompSubagentsFromTaskFrame({ type: "tool_execution_end", toolName: "Task", toolCallId: "call-missing", result: { content: [{ text: "Missing tasks" }] } }), []);
  assert.deepEqual(ompSubagentsFromTaskFrame({ type: "tool_execution_end", toolName: "bash", toolCallId: "call-bash", result: { details: { progress: [{ id: "not-a-child" }] } } }), []);
  assert.deepEqual(ompSubagentsFromTaskFrame({ type: "tool_execution_end", toolName: "Task", result: { details: { progress: [{ id: "unlinked" }] } } }), []);
});

test("Task result progress backfills the turn card while native event roster is empty", () => {
  const group = buildOmpSubagentTurnGroup([{
    message: {
      id: "call-batch",
      toolCallId: "call-batch",
      engineOrigin: "omp",
      toolName: "Task",
      toolArgs: { tasks: [{}, {}, {}] },
      toolResult: { details: { progress: [
        { id: "FsProbe", agent: "task", task: "Read workspace files", status: "pending" },
        { id: "SearchProbe", agent: "task", task: "Search tests", status: "running" },
      ] } },
    },
  }], []);

  assert.equal(group.requestedCount, 3);
  assert.deepEqual(group.agents.map(({ agent }) => agent.id), ["FsProbe", "SearchProbe"]);
  assert.deepEqual(group.agents.map(({ toolCallId }) => toolCallId), ["call-batch", "call-batch"]);
  assert.equal(group.runningCount, 2);
});

test("live/archive roster wins over older Task-result status while retaining its parent link", () => {
  const group = buildOmpSubagentTurnGroup([{
    message: {
      id: "call-batch", toolCallId: "call-batch", engineOrigin: "omp", toolName: "Task",
      toolArgs: { tasks: [{}] },
      toolResult: { details: { progress: [{ id: "FsProbe", task: "Read files", status: "pending" }] } },
    },
  }], [{ id: "FsProbe", status: "completed", lastKnownStatus: "completed", observedActive: false }]);

  assert.equal(group.agents.length, 1);
  assert.equal(group.agents[0].agent.status, "completed");
  assert.equal(group.agents[0].toolCallId, "call-batch");
  assert.equal(group.completedCount, 1);
});

test("Task-result children are durably archived before the running-only roster can expire", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-task-progress-archive-"));
  try {
    const archive = new OmpSubagentArchive(root);
    const ids = await archiveOmpTaskProgress(archive, "session-1", {
      type: "tool_execution_end", toolName: "task", toolCallId: "call-batch",
      result: { details: { progress: [
        { id: "FsProbe", task: "Read files", status: "pending" },
        { id: "SearchProbe", task: "Search tests", status: "completed" },
      ] } },
    });
    const roster = await archive.getRoster("session-1");
    assert.deepEqual(ids, ["FsProbe", "SearchProbe"]);
    assert.deepEqual(roster.map(({ id }) => id), ids);
    assert.ok(roster.every((agent) => agent.parentToolCallId === "call-batch"));
    assert.equal(roster[0].lastKnownStatus, "pending");
    assert.equal(roster[1].lastKnownStatus, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native OMP Task completion frame flows through the event adapter into visible child cards", async () => {
  const { ompFrameToAgentEvent } = await loadOmpEventAdapter();
  const callId = "call-native-task-batch";
  const frame = {
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: "Task",
    result: {
      content: [{ type: "text", text: "Spawned 4 background agents using task." }],
      details: {
        async: true,
        progress: [
          { index: 0, id: "BashProbe", agent: "task", agentSource: "bundled", status: "pending", task: "Check shell" },
          { index: 1, id: "FsProbe", agent: "task", agentSource: "bundled", status: "pending", task: "Check files" },
          { index: 2, id: "SearchProbe", agent: "task", agentSource: "bundled", status: "pending", task: "Check search" },
          { index: 3, id: "EvalProbe", agent: "task", agentSource: "bundled", status: "pending", task: "Check eval" },
        ],
      },
    },
  };

  const mapped = ompFrameToAgentEvent({ sessionId: "session-native", runId: "omp-run", frame, messageIds: new Set() });
  assert.equal(mapped?.event.type, "tool_end");
  if (mapped?.event.type !== "tool_end") throw new Error("expected mapped OMP tool_end event");
  assert.deepEqual(mapped.event.result, frame.result, "the adapter must preserve the structured Task result envelope");

  const group = buildOmpSubagentTurnGroup([{
    message: {
      id: callId,
      role: "tool",
      engineOrigin: "omp",
      toolName: "Task",
      toolCallId: callId,
      toolArgs: { tasks: [{}, {}, {}, {}] },
      toolResult: mapped.event.result,
    },
  }], []);

  assert.equal(group.requestedCount, 4);
  assert.deepEqual(group.agents.map(({ agent }) => agent.id), ["BashProbe", "FsProbe", "SearchProbe", "EvalProbe"]);
  assert.ok(group.agents.every(({ toolCallId }) => toolCallId === callId));
  assert.equal(group.runningCount, 4, "OMP's pending state means the child has been dispatched and is still active");
});
