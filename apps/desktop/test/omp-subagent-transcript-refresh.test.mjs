import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ompSubagentImageSource } from "../src/components/omp-subagent-image.mjs";
import { buildOmpSubagentTimeline, ompSubagentIdentity, ompSubagentProgressSummary, ompSubagentStatusKey, ompSubagentTaskDetail, ompSubagentTaskSummary, ompSubagentTranscriptOutcome } from "../src/components/omp-subagent-timeline.mjs";
import { buildOmpSubagentTranscriptTurns } from "../src/components/omp-subagent-transcript.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("OMP subagent events refresh the selected snapshot and its transcript incrementally", async () => {
  const controls = await read("../src/components/OmpNativeControls.tsx");
  const ipc = await read("../electron/main/ipc/register.ts");
  const runtime = await read("../electron/main/omp/rpc-runtime.ts");
  const panel = await read("../src/components/workpanel/OmpSubagentBatchTab.tsx");
  const sharedContent = await read("../src/components/workpanel/SubagentTranscriptContent.tsx");
  const nodeCard = await read("../src/features/chat/transcript/SubagentNodeCard.tsx");
  const toolRow = await read("../src/features/chat/transcript/ToolRow.tsx");
  const en = await read("../../../packages/i18n/src/locales/en/index.ts");
  const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");
  assert.match(controls, /selectedAgentRef\.current = selected/);
  assert.match(controls, /frame\.type\.startsWith\("subagent_"\)[\s\S]*?get_subagents[\s\S]*?refreshSelectedAgentTranscript\(sessionId, selectedId, "append"\)/);
  assert.match(controls, /set_subagent_subscription[\s\S]*?level: "events"/);
  assert.match(controls, /applyOmpSubagentFrame\(sessionId, frame\)/);
  assert.match(controls, /command: "set_subagent_subscription", fields: \{ level: "off" \} \}\)\.catch/);
  assert.match(controls, /fields: \{ subagentId: agentId, fromByte \}/);
  assert.match(controls, /data\?\.reset \|\| mode === "replace" \? messages : \[\.\.\.current, \.\.\.messages\]/);
  assert.match(controls, /agentTranscriptPendingRef/);
  assert.match(controls, /t\("common\.refresh"\)/);
  const listenerAt = controls.indexOf("const unsubscribe = api.onOmpRpcEvent");
  const subscriptionAt = controls.indexOf('await api.ompRpcCommand({ sessionId, command: "set_subagent_subscription", fields: { level: "events" } });');
  const snapshotAt = controls.indexOf('command: "get_subagents"', subscriptionAt);
  assert.ok(listenerAt >= 0 && subscriptionAt > listenerAt && snapshotAt > subscriptionAt,
    "install the renderer listener before enabling OMP events, then read the canonical roster");
  assert.match(controls.slice(subscriptionAt, snapshotAt + 120), /await api\.ompRpcCommand[\s\S]*?set_subagent_subscription[\s\S]*?if \(!active[\s\S]*?get_subagents/);
  assert.match(runtime, /if \(type === "set_subagent_subscription"[\s\S]*?this\.subagentSubscriptions\.set\(sessionId, fields\.level\)/);
  assert.match(runtime, /set_subagent_subscription", \{\s*level: this\.subagentSubscriptions\.get\(input\.sessionId\) \?\? "off"/,
    "restarted OMP RPC sessions restore the renderer's requested subscription level");
  assert.match(ipc, /frameType === "tool_execution_end"[\s\S]*?archiveOmpTaskProgress\(ompSubagentArchive, event\.sessionId, event\.frame\)[\s\S]*?scheduleOmpSubagentCapture\(event\.sessionId, 250\)/,
    "Task result identities are archived before OMP's running-only roster can drop them");
  assert.match(controls, /OmpSubagentMessage/);
  assert.match(panel, /buildOmpSubagentTranscriptTurns/);
  assert.match(panel, /<SubagentTranscriptContent/);
  assert.match(panel, /focusedAgentView[\s\S]*?visibleAgents\.map/);
  assert.match(panel, /compactTasks/);
  assert.match(panel, /selectedAgentProgress/);
  assert.match(panel, /compactTasks=\{!focusedAgentView\}/);
  assert.match(panel, /omp-native-agent-live-status/);
  assert.doesNotMatch(panel, /omp-native-agent-assigned-task/);
  assert.match(toolRow, /ompSubagentProgressSummary/);
  assert.match(toolRow, /summaryDetail=\{taskDetail/);
  assert.match(nodeCard, /subagent-topology-node-activity/);
  assert.match(panel, /steer_subagent/);
  assert.match(panel, /cancel_subagent/);
  assert.match(sharedContent, /<ToolRow key=\{row\.message\.id\} message=\{row\.message\} \/>/);
  assert.match(sharedContent, /<ThinkingRow/);
  assert.match(sharedContent, /<Markdown source=\{row\.message\.content\}/);
  assert.match(controls, /part\?\.type === "toolCall"[\s\S]*?JSON\.stringify\(args, null, 2\)/);
  assert.match(controls, /part\?\.type === "thinking"[\s\S]*?<details/);
  assert.match(controls, /part\?\.type === "image"[\s\S]*?ompSubagentImageSource\(part\)[\s\S]*?<img className="omp-native-agent-image"/);
  assert.match(controls, /omp-subagent-image\.mjs/);
  for (const key of ["subagentThinking", "subagentToolCall", "subagentImageAttachment"]) {
    assert.match(en, new RegExp(`${key}:`));
    assert.match(zh, new RegExp(`${key}:`));
  }
});

test("OMP subagent image preview accepts bounded raster data only", () => {
  assert.equal(ompSubagentImageSource({ mimeType: "image/png", data: "aGVsbG8=" }), "data:image/png;base64,aGVsbG8=");
  assert.equal(ompSubagentImageSource({ mimeType: "image/jpeg", data: "data:image/jpeg;base64,aGVsbG8=" }), "data:image/jpeg;base64,aGVsbG8=");
  assert.equal(ompSubagentImageSource({ mimeType: "image/png", data: "data:image/svg+xml;base64,PHN2Zz4=" }), null);
  assert.equal(ompSubagentImageSource({ mimeType: "image/png", data: "javascript:alert(1)" }), null);
  assert.equal(ompSubagentImageSource({ mimeType: "image/png", data: "x".repeat(14 * 1024 * 1024 + 1) }), null);
});

test("OMP subagent timeline pairs tool results only by explicit call ID and reports unconfirmed work honestly", () => {
  const timeline = buildOmpSubagentTimeline([
    { id: "user-1", role: "user", content: [{ type: "text", text: "Inspect the file" }], timestamp: 100 },
    { id: "assistant-1", role: "assistant", content: [
      { type: "text", text: "I will inspect it." },
      { type: "toolCall", id: "call-read", name: "bash", arguments: { command: "cat report.txt" } },
    ], timestamp: 200 },
    { id: "tool-result-1", role: "tool", toolCallId: "call-read", toolName: "bash", content: [{ type: "text", text: "report contents" }] },
    { id: "assistant-2", role: "assistant", content: [{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "out.txt" } }] },
  ], "running");
  assert.deepEqual(timeline.map((item) => item.kind), ["message", "message", "tool", "tool"]);
  assert.equal(timeline[2].state, "complete");
  assert.equal(timeline[2].output, "report contents");
  assert.equal(timeline[3].state, "running");

  const unlinked = buildOmpSubagentTimeline([
    { id: "tool-result-orphan", role: "tool", toolName: "bash", content: "output without a call ID" },
    { id: "call-no-result", role: "assistant", content: [{ type: "toolCall", id: "call-no-result", name: "bash", arguments: { command: "pwd" } }] },
  ], "completed");
  assert.equal(unlinked[0].kind, "unlinked-result");
  assert.equal(unlinked[1].state, "unconfirmed");

  const nativeToolResult = buildOmpSubagentTimeline([
    { id: "assistant-tool-call", role: "assistant", content: [{ type: "toolCall", id: "native-call", name: "bash", arguments: { command: "printf done" } }] },
    { id: "native-tool-result", role: "toolResult", toolCallId: "native-call", content: [{ type: "text", text: "done" }] },
  ], "completed");
  assert.equal(nativeToolResult.length, 1, "a native OMP toolResult belongs on its call card, not as a duplicate assistant bubble");
  assert.equal(nativeToolResult[0].kind, "tool");
  assert.equal(nativeToolResult[0].state, "complete");
  assert.equal(nativeToolResult[0].output, "done");
});

test("OMP subagent cards keep concise task labels, live progress, and distinct duplicate names", () => {
  const sharedTask = "Run the same stress-test task";
  assert.equal(ompSubagentIdentity({ id: "agent-001", task: sharedTask }, 0, "子代理 1"), "子代理 1 · nt-001");
  assert.equal(ompSubagentIdentity({ id: "agent-002", task: sharedTask }, 1, "子代理 2"), "子代理 2 · nt-002");
  assert.equal(ompSubagentIdentity({ id: "id-1", name: "Researcher" }, 0, "子代理 1"), "Researcher");
  assert.equal(ompSubagentTaskSummary({ task: sharedTask }), sharedTask);
  const researchers = [{ id: "worker-a1b2c3", name: "Researcher" }, { id: "worker-d4e5f6", name: "Researcher" }];
  assert.equal(ompSubagentIdentity(researchers[0], 0, "子代理 1", researchers), "Researcher · a1b2c3");
  assert.equal(ompSubagentIdentity(researchers[1], 1, "子代理 2", researchers), "Researcher · d4e5f6");
  assert.equal(ompSubagentIdentity({ id: "same-a1b2c3", name: "Researcher" }, 2, "子代理 3", [{ id: "other-a1b2c3", name: "Researcher" }, { id: "same-a1b2c3", name: "Researcher" }]), "Researcher · a1b2c3 (#3)");

  const commandHeavyTask = "Review this repository, identify defects, and report findings.\n```powershell\nGet-ChildItem -Recurse\n```";
  assert.equal(ompSubagentTaskSummary({ task: commandHeavyTask }), "Review this repository, identify defects, and report findings.");
  assert.equal(ompSubagentTaskDetail({ task: commandHeavyTask }), commandHeavyTask);
  assert.equal(ompSubagentTaskSummary({ progress: { message: "Reading 18 files" } }), "");
  assert.equal(ompSubagentProgressSummary({ task: sharedTask, progress: { message: "Reviewing the test fixtures now" } }), "Reviewing the test fixtures now");
  assert.equal(ompSubagentStatusKey("in progress"), "running");
  assert.equal(ompSubagentStatusKey("success"), "completed");
  assert.equal(ompSubagentStatusKey("cancelled"), "aborted");
  assert.equal(ompSubagentStatusKey("vendor_specific_state"), "");
});

test("OMP transcript status is inferred only from explicit terminal assistant stop reasons", () => {
  assert.equal(ompSubagentTranscriptOutcome([]), "");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "toolUse" }]), "");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "assistant", content: [{ type: "text", text: "previous run done" }], stopReason: "stop" }, { role: "user", content: [{ type: "text", text: "new follow-up" }] }]), "");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }]), "completed");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "assistant", content: [], stop_reason: "end_turn" }]), "completed");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "assistant", content: [], stopReason: "error" }]), "failed");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "assistant", content: [], stopReason: "aborted" }]), "aborted");
  assert.equal(ompSubagentTranscriptOutcome([{ role: "toolResult", content: "done" }]), "");
});

test("OMP native transcript adapts into the same PI subagent turn and tool-row contract", () => {
  const [turn] = buildOmpSubagentTranscriptTurns([
    { id: "u1", role: "user", content: [{ type: "text", text: "Inspect and summarize" }], timestamp: 1_000 },
    { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat README.md" } }], timestamp: 2_000 },
    { id: "r1", role: "tool", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "README text" }] },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "The README describes the project." }], timestamp: 3_000 },
  ], "completed");
  assert.equal(turn.task, "Inspect and summarize");
  assert.deepEqual(turn.rows.map((row) => row.kind), ["tool", "answer"]);
  assert.equal(turn.rows[0].message.engineOrigin, "omp");
  assert.equal(turn.rows[0].message.toolCallId, "call-1");
  assert.equal(turn.rows[0].message.toolStatus, "success");
  assert.equal(turn.rows[0].message.toolResult, "README text");
  assert.equal(turn.rows[1].message.content, "The README describes the project.");
});

test("OMP focused transcript presents the assigned task as the PI-style user turn without duplicating an RPC prompt", () => {
  const [fallback] = buildOmpSubagentTranscriptTurns([
    { id: "a1", role: "assistant", content: [{ type: "text", text: "I found the repository files." }], timestamp: 2_000 },
  ], "running", {}, "Inspect the workspace and report the relevant files.");
  assert.equal(fallback.task, "Inspect the workspace and report the relevant files.");
  assert.equal(fallback.rows[0].message.content, "I found the repository files.");

  const [rpcPrompt] = buildOmpSubagentTranscriptTurns([
    { id: "u1", role: "user", content: [{ type: "text", text: "Inspect the workspace." }], timestamp: 1_000 },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 2_000 },
  ], "completed", {}, "Inspect the workspace.");
  assert.equal(rpcPrompt.task, "Inspect the workspace.");
  assert.equal(buildOmpSubagentTranscriptTurns([
    { id: "a1", role: "assistant", content: [{ type: "text", text: "I am working." }], timestamp: 2_000 },
  ], "running", {}, "Inspect the workspace.").length, 1);

  const empty = buildOmpSubagentTranscriptTurns([], "running", {}, "Inspect the workspace.");
  assert.deepEqual(empty, [{ task: "Inspect the workspace.", rows: [] }]);
});
