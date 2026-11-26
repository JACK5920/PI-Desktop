import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Outbound frame contract verified against OMP 19.2.0 docs/rpc.md and the
// isolated native binary. No new session event types were added in this release.
// `agent_pause` is deliberately absent: RPC converts it to a non-terminal
// `agent_end` on the wire. Host update/result frames are inbound, not here.
const OMP_SESSION_EVENT_FRAMES = [
  "agent_start", "agent_end", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_stream_update",
  "auto_compaction_start", "auto_compaction_end", "manual_compaction_start", "manual_compaction_end",
  "auto_retry_start", "auto_retry_end", "cache_warming_start", "cache_warming_end",
  "retry_fallback_applied", "retry_fallback_succeeded", "model_changed", "config_warnings_changed",
  "advisor_cost_changed", "advisor_yielded", "ttsr_triggered", "todo_reminder", "todo_auto_clear",
  "irc_message", "notice", "thinking_level_changed", "goal_updated", "queue_update",
];

const PI_AGENT_ADAPTER_FRAMES = [
  "agent_start", "agent_end", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_stream_update",
  "command_output", "prompt_result", "session_settled",
];

const RUNTIME_CONTROL_FRAMES = [
  "ready", "rpc_chunk", "response",
  "host_tool_call", "host_tool_cancel", "host_uri_request", "host_uri_cancel",
];

const OMP_NATIVE_UI_FRAMES = [
  "extension_ui_request", "extension_error", "available_commands_update",
  "subagent_lifecycle", "subagent_progress", "subagent_event", "btw_delta", "btw_record",
  "session_info_update", "config_update", "rpc_frame_error",
  "live_phase", "live_levels", "live_transcript", "live_end",
  "dictation_state", "dictation_transcript", "dictation_end",
];

const OMP_NATIVE_EVENT_FRAMES = [
  ...OMP_SESSION_EVENT_FRAMES.filter((frameType) => !PI_AGENT_ADAPTER_FRAMES.includes(frameType)),
  ...OMP_NATIVE_UI_FRAMES,
];

const OMP_OUTBOUND_FRAME_TYPES = [
  ...OMP_SESSION_EVENT_FRAMES,
  ...RUNTIME_CONTROL_FRAMES,
  ...OMP_NATIVE_UI_FRAMES,
  "command_output", "prompt_result", "session_settled",
];

test("OMP 19.2.0 outbound RPC frames all have one explicit desktop route", () => {
  const routed = [...PI_AGENT_ADAPTER_FRAMES, ...RUNTIME_CONTROL_FRAMES, ...OMP_NATIVE_EVENT_FRAMES];
  assert.equal(new Set(OMP_OUTBOUND_FRAME_TYPES).size, OMP_OUTBOUND_FRAME_TYPES.length, "upstream frame manifest must not contain duplicates");
  assert.equal(new Set(routed).size, routed.length, "desktop routing categories must not overlap");
  assert.deepEqual([...routed].sort(), [...OMP_OUTBOUND_FRAME_TYPES].sort(), "every upstream outbound frame must have exactly one desktop route");
  assert.ok(OMP_SESSION_EVENT_FRAMES.includes("notice"));
  assert.ok(PI_AGENT_ADAPTER_FRAMES.includes("prompt_result"));
  assert.ok(RUNTIME_CONTROL_FRAMES.includes("host_tool_call"));
  assert.ok(OMP_NATIVE_UI_FRAMES.includes("extension_ui_request"));
});

test("native RPC frames keep their original payload on the session event channel", async () => {
  const runtime = await readFile(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../electron/main/omp/rpc-event-adapter.ts", import.meta.url), "utf8");

  assert.match(runtime, /if \(frame\.type === "ready"\)/);
  assert.match(runtime, /if \(frame\.type === "host_tool_call" \|\| frame\.type === "host_uri_request"\)/);
  assert.match(runtime, /if \(frame\.type === "host_tool_cancel" \|\| frame\.type === "host_uri_cancel"\)/);
  assert.match(runtime, /if \(frame\.type === "response" && typeof frame\.id === "string"\)/);
  assert.match(runtime, /this\.options\.emit\(\{ sessionId: session\.sessionId, runId: session\.runId, frame \}\)/);
  assert.match(ipc, /sendToRenderer\(IPC\.event\.ompRpcEvent, event\)/);

  for (const frameType of PI_AGENT_ADAPTER_FRAMES) {
    assert.ok(adapter.includes(`case "${frameType}"`), `PI event adapter must explicitly map or settle ${frameType}`);
  }
  assert.match(adapter, /case "agent_end"[\s\S]*?return null/);
  assert.match(adapter, /case "prompt_result"/);
  assert.match(adapter, /case "session_settled"/);
});
