import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOmpSubagentFrame,
  getOmpSubagentRoster,
  isOmpTaskBatch,
  ompToolResultText,
  ompSubagentDeliveryPreview,
  parseOmpTaskResultDeliveries,
  recordOmpSubagentDeliveries,
  recordOmpSubagentRoster,
  recordOmpSubagentTranscriptOutcome,
  summarizeOmpBatchRoster,
} from "../src/components/omp-subagent-roster.mjs";
import { ompSubagentLifecycleStatus } from "../src/components/omp-subagent-timeline.mjs";

const receipt = (id, status, output = "") =>
  `<task-result id="${id}" agent="task" status="${status}" duration="1m">\n<output>\n${output}\n</output>\n</task-result>`;

test("a delayed active roster cannot regress a transcript-confirmed terminal subagent", () => {
  const sessionId = `status-monotonic-${Math.random()}`;
  recordOmpSubagentRoster(sessionId, [{
    id: "AgentA",
    parentToolCallId: "task-call-1",
    status: "running",
  }]);
  recordOmpSubagentRoster(sessionId, []);
  recordOmpSubagentTranscriptOutcome(sessionId, "AgentA", "completed");

  const roster = recordOmpSubagentRoster(sessionId, [{
    id: "AgentA",
    parentToolCallId: "task-call-1",
    status: "running",
  }]);
  const agent = roster.find((row) => row.id === "AgentA");
  assert.equal(agent.transcriptOutcome, "completed");
  assert.equal(agent.status, "completed");
  assert.equal(agent.lastKnownStatus, "completed");
  assert.equal(agent.observedActive, false);
});

test("a live agent's transcript is not terminal evidence", () => {
  const sessionId = `status-live-${Math.random()}`;
  recordOmpSubagentRoster(sessionId, [{
    id: "AgentA",
    parentToolCallId: "task-call-1",
    status: "running",
  }]);

  // Every finished assistant round ends with a terminal stop reason, so only
  // an agent OMP already dropped from its running roster may be confirmed.
  const untouched = recordOmpSubagentTranscriptOutcome(sessionId, "AgentA", "completed");
  assert.equal(untouched.find((row) => row.id === "AgentA").transcriptOutcome, undefined);

  recordOmpSubagentRoster(sessionId, []);
  const roster = recordOmpSubagentTranscriptOutcome(sessionId, "AgentA", "completed");
  const agent = roster.find((row) => row.id === "AgentA");
  assert.equal(agent.transcriptOutcome, "completed");
  assert.equal(agent.observedActive, false);
  // OMP's own status stays untouched: the transcript outcome is separate
  // evidence, and every reader prefers it when present.
  assert.equal(agent.status, "running");
});

test("the roster poller is shared beyond the subagent pane", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const poller = await read("../src/components/omp-subagent-roster-polling.ts");
  const group = await read("../src/features/chat/transcript/ActivityGroup.tsx");
  const pane = await read("../src/components/workpanel/OmpSubagentBatchTab.tsx");

  // Terminal probing waits for OMP to drop the agent from its running roster,
  // or for a settled parent Task plus an unchanged transcript across two polls.
  assert.match(poller, /agent\.observedActive === false/);
  assert.match(poller, /settledParentToolCallIds/);
  assert.match(poller, /previousLength !== rows\.length/);
  assert.match(group, /useOmpSubagentRosterPolling\(hasOmpBatch \? activeSessionId : null\)/);
  assert.match(pane, /useOmpSubagentRosterPolling\(sessionId\)/);
  assert.doesNotMatch(pane, /window\.setInterval\(\(\) => \{ void refreshRoster\(\); \}, 2000\)/);
  // The transcript card lives on the row, not the pane; a closed pane must not
  // stop the poller.
  const row = await read("../src/features/chat/transcript/ToolRow.tsx");
  assert.match(row, /useOmpSubagentRosterPolling\(ompBatchCandidate \? activeSessionId : null\)/);
});

test("an OMP tool without a tasks array is not a subagent batch", () => {
  // A plain list/todo call from the OMP engine must not register as a batch:
  // it would otherwise drive the roster UI and polling with no agents behind it.
  assert.equal(isOmpTaskBatch("omp", "list", { items: ["a", "b"] }), false);
  assert.equal(isOmpTaskBatch("omp", "todo", undefined), false);
  assert.equal(isOmpTaskBatch("omp", "Task", {}), true);
  assert.equal(isOmpTaskBatch("omp", "Task", { tasks: [{ task: "x" }] }), true);
  assert.equal(isOmpTaskBatch(undefined, "mcp.task", { tasks: [{ task: "x" }] }), true);
  assert.equal(isOmpTaskBatch(undefined, "list", { tasks: [{ task: "x" }] }), false);
});

test("a different parent Task is treated as a new subagent generation", () => {
  const sessionId = `status-generation-${Math.random()}`;
  recordOmpSubagentRoster(sessionId, [{
    id: "AgentA",
    parentToolCallId: "task-call-old",
    status: "running",
  }]);
  recordOmpSubagentRoster(sessionId, []);
  recordOmpSubagentTranscriptOutcome(sessionId, "AgentA", "completed");

  const roster = recordOmpSubagentRoster(sessionId, [{
    id: "AgentA",
    parentToolCallId: "task-call-new",
    status: "running",
  }]);
  const agent = roster.find((row) => row.id === "AgentA");
  assert.equal(agent.parentToolCallId, "task-call-new");
  assert.equal(agent.transcriptOutcome, undefined);
  assert.equal(agent.status, "running");
  assert.equal(agent.observedActive, true);
  assert.equal(getOmpSubagentRoster(sessionId).length, 1);
});

test("a delivered task-result settles exactly the agent id it names", () => {
  const sessionId = `delivery-settles-${Math.random()}`;
  recordOmpSubagentRoster(sessionId, [
    { id: "UriTools", parentToolCallId: "batch-1", status: "running" },
    { id: "FsTools", parentToolCallId: "batch-1", status: "running" },
  ]);
  // OMP's roster RPC is running-only; both agents dropped out before the wait
  // receipt arrived, which is exactly the state that used to read "pending".
  recordOmpSubagentRoster(sessionId, []);

  const roster = recordOmpSubagentDeliveries(sessionId, "wait-1",
    `${receipt("UriTools", "completed", "PASS 14 / FAIL 0")}\n${receipt("FsTools", "failed (exit 7)", "boom")}`);
  const uri = roster.find((row) => row.id === "UriTools");
  assert.equal(uri.deliveryOutcome, "completed");
  assert.equal(uri.deliveryStatus, "completed");
  assert.equal(uri.deliveryOutput, "PASS 14 / FAIL 0");
  assert.equal(uri.observedActive, false);
  assert.equal(uri.status, "completed");
  assert.equal(ompSubagentLifecycleStatus(uri), "completed");

  const fs = roster.find((row) => row.id === "FsTools");
  assert.equal(fs.deliveryOutcome, "failed");
  assert.equal(fs.deliveryStatus, "failed (exit 7)");
  assert.equal(fs.deliveryOutput, "boom");

  const summary = summarizeOmpBatchRoster(roster, ["batch-1"]);
  assert.deepEqual(
    [summary.total, summary.completed, summary.aborted, summary.failed, summary.unconfirmed, summary.running],
    [2, 1, 0, 1, 0, 0],
  );
});

test("an unclosed envelope, an unknown id, and a repeated receipt change nothing", () => {
  const sessionId = `delivery-guards-${Math.random()}`;
  recordOmpSubagentRoster(sessionId, [{ id: "AgentA", parentToolCallId: "batch-1", status: "running" }]);

  assert.deepEqual(parseOmpTaskResultDeliveries('<task-result id="AgentA" status="completed">\n<output>half'), []);
  recordOmpSubagentDeliveries(sessionId, "wait-1", '<task-result id="AgentA" status="completed">\n<output>half');
  assert.equal(getOmpSubagentRoster(sessionId).find((row) => row.id === "AgentA").deliveryOutcome, undefined);

  // A receipt for an agent this tab never observed must not invent a member.
  const untouched = recordOmpSubagentDeliveries(sessionId, "wait-1", receipt("SomeoneElse", "completed", "x"));
  assert.equal(untouched.length, 1);

  const first = recordOmpSubagentDeliveries(sessionId, "wait-1", receipt("AgentA", "completed", "done"));
  const second = recordOmpSubagentDeliveries(sessionId, "wait-2", receipt("AgentA", "completed", "done"));
  assert.equal(first, second, "re-reading the same conclusion must not republish");

  // A late running lifecycle frame cannot undo a delivered conclusion.
  const afterFrame = applyOmpSubagentFrame(sessionId, { type: "subagent_lifecycle", payload: { id: "AgentA", parentToolCallId: "batch-1", status: "running" } });
  const agent = afterFrame.find((row) => row.id === "AgentA");
  assert.equal(agent.status, "completed");
  assert.equal(agent.deliveryOutcome, "completed");
  assert.equal(agent.observedActive, false);
});

test("tool result text is read from block arrays and escaped JSON payloads", () => {
  const block = { role: "toolResult", content: [{ type: "text", text: receipt("A", "completed", "ok") }] };
  assert.match(ompToolResultText(block), /<task-result id="A"/);
  assert.equal(parseOmpTaskResultDeliveries(ompToolResultText(block))[0].output, "ok");
  const escaped = { content: JSON.stringify(block.content) };
  assert.match(ompToolResultText(escaped), /<task-result id="A"/);
});

test("OMP delivery previews remove common Markdown noise and remain bounded", () => {
  const preview = ompSubagentDeliveryPreview([
    "## **结论**",
    "- `PASS`: 14 / 14 tests",
    "| Item | Result |",
    "| --- | --- |",
    "| Build | **green** |",
  ].join("\n"));
  assert.equal(preview, "结论 · PASS: 14 / 14 tests · Item · Result · Build · green");
  assert.ok(ompSubagentDeliveryPreview("x".repeat(1000)).length <= 241);
  assert.equal(ompSubagentDeliveryPreview("  \n  "), "");
});

test("batch surfaces show buckets and the delivered conclusion instead of an N/N claim", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const row = await read("../src/features/chat/transcript/ToolRow.tsx");
  const pane = await read("../src/components/workpanel/OmpSubagentBatchTab.tsx");
  const poller = await read("../src/components/omp-subagent-roster-polling.ts");

  assert.match(row, /ompBatchUnconfirmed/);
  assert.match(row, /ompSubagentLifecycleStatus/);
  assert.doesNotMatch(row, /ompBatchFinished/);
  assert.match(pane, /deliveryOutput/);
  assert.match(pane, /subagentDelivery/);
  assert.match(poller, /recordOmpSubagentDeliveries/);
});
