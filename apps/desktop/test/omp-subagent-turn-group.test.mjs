import assert from "node:assert/strict";
import test from "node:test";
import { buildOmpSubagentTurnGroup } from "../src/components/omp-subagent-turn-group.mjs";

function batch(toolCallId, tasks = [{}]) {
  return { message: {
    id: `message-${toolCallId}`,
    toolCallId,
    engineOrigin: "omp",
    toolName: "Task",
    toolArgs: { tasks },
  } };
}

test("turn group collects only explicitly linked agents across sibling OMP Task calls", () => {
  const group = buildOmpSubagentTurnGroup([
    batch("call-a", [{ name: "one" }, { name: "two" }]),
    { message: { id: "ordinary-tool", engineOrigin: "omp", toolName: "bash", toolArgs: {} } },
    batch("call-b"),
  ], [
    { id: "agent-b", parentToolCallId: "call-b", status: "failed", observedActive: false },
    { id: "agent-unrelated", parentToolCallId: "other-turn-call", status: "running" },
    { id: "agent-a1", parentToolCallId: "call-a", status: "completed", observedActive: false },
    { id: "agent-a2", parentToolCallId: "call-a", status: "running", observedActive: true },
  ]);

  assert.deepEqual(group.toolCallIds, ["call-a", "call-b"]);
  assert.equal(group.requestedCount, 3);
  assert.deepEqual(group.agents.map(({ agent }) => agent.id), ["agent-a1", "agent-a2", "agent-b"]);
  assert.equal(group.runningCount, 1);
  assert.equal(group.completedCount, 1);
  assert.equal(group.failedCount, 1);
  assert.equal(group.unknownCount, 0);
  assert.equal(group.abortedCount, 0);
  assert.equal(group.unconfirmedCount, 0);
});

test("turn group keeps aborted and unconfirmed outcomes separate from failures", () => {
  const group = buildOmpSubagentTurnGroup([batch("call-a", [{}, {}, {}])], [
    { id: "agent-aborted", parentToolCallId: "call-a", status: "cancelled", observedActive: false },
    { id: "agent-unknown", parentToolCallId: "call-a", status: "running", lastKnownStatus: "running", observedActive: false },
    { id: "agent-failed", parentToolCallId: "call-a", status: "failed", observedActive: false },
  ]);
  assert.equal(group.abortedCount, 1);
  assert.equal(group.failedCount, 1);
  assert.equal(group.unconfirmedCount, 1);
});

test("a subagent that left the active roster is not presented as running without terminal evidence", () => {
  const group = buildOmpSubagentTurnGroup([batch("call-a")], [
    { id: "agent-a", parentToolCallId: "call-a", status: "running", lastKnownStatus: "running", observedActive: false },
  ]);

  assert.equal(group.agents[0].status, "unknown");
  assert.equal(group.runningCount, 0);
  assert.equal(group.unknownCount, 1);
});

test("a running subagent waiting on its own wait tool is shown separately from active work", () => {
  const group = buildOmpSubagentTurnGroup([batch("call-a")], [
    { id: "agent-waiting", parentToolCallId: "call-a", status: "running", observedActive: true, progress: { currentTool: "wait" } },
  ]);

  assert.equal(group.agents[0].status, "waiting");
  assert.equal(group.agents[0].statusKey, "waiting");
  assert.equal(group.runningCount, 0);
  assert.equal(group.waitingCount, 1);
  assert.equal(group.unknownCount, 0);
});

test("OMP 19.2 retry backoff is separate from active work and its native stage remains visible", () => {
  const group = buildOmpSubagentTurnGroup([batch("call-a")], [
    {
      id: "agent-retrying",
      parentToolCallId: "call-a",
      status: "running",
      observedActive: true,
      progress: {
        currentTool: "bash",
        stage: "Inspecting failing test",
        retryState: { attempt: 2, maxAttempts: 5, delayMs: 12_000, startedAtMs: 1_000, errorMessage: "HTTP 429" },
      },
    },
  ]);

  assert.equal(group.agents[0].status, "retrying");
  assert.equal(group.runningCount, 0);
  assert.equal(group.retryingCount, 1);
  assert.equal(group.waitingCount, 0);
  assert.equal(group.unknownCount, 0);
});

test("turn group excludes ordinary tools and unlinked roster entries", () => {
  const group = buildOmpSubagentTurnGroup([
    { message: { id: "omp-bash", engineOrigin: "omp", toolName: "bash", toolArgs: { command: "echo hi" } } },
  ], [{ id: "agent-a", parentToolCallId: "omp-bash" }]);

  assert.equal(group.batches.length, 0);
  assert.equal(group.requestedCount, 0);
  assert.deepEqual(group.agents, []);
});
