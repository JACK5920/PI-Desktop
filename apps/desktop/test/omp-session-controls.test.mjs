import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { flattenOmpSessionTree, normalizeOmpForkableMessages, normalizeOmpSessionControlState, ompQueuePromotionPayload, ompQueueRemovalPayload } from "../src/components/omp-session-controls.mjs";

test("OMP session control state preserves native queue and known session values without inventing fields", () => {
  assert.deepEqual(normalizeOmpSessionControlState({
    isStreaming: true,
    hasPendingAsyncWork: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    interruptMode: "wait",
    autoCompactionEnabled: false,
    desktopRpcCapabilities: { supportsBashExcludeFromContext: true },
    sessionName: "Review",
    messageCount: 4,
    queuedMessages: { steering: ["fix test", 3], followUp: ["then rerun"] },
    autoRetryEnabled: true,
  }), {
    isStreaming: true,
    hasPendingAsyncWork: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    interruptMode: "wait",
    autoCompactionEnabled: false,
    supportsBashExcludeFromContext: true,
    sessionName: "Review",
    messageCount: 4,
    queuedMessages: { steering: ["fix test"], followUp: ["then rerun"] },
  });
});

test("OMP queue actions use native exact-text request shapes and reject invalid input", () => {
  assert.deepEqual(ompQueueRemovalPayload("followUp", "continue"), { queue: "followUp", message: "continue" });
  assert.deepEqual(ompQueuePromotionPayload("continue"), { message: "continue" });
  assert.throws(() => ompQueueRemovalPayload("invalid", "continue"));
  assert.throws(() => ompQueuePromotionPayload(""));
});

test("OMP native session tree flattens safely with active leaf and bounded text", () => {
  const tree = flattenOmpSessionTree({
    leafId: "b",
    tree: [{
      entry: { id: "a", type: "message", message: { role: "user", content: [{ type: "text", text: "  first\n prompt " }] } },
      children: [{ entry: { id: "b", parentId: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }, label: "Final" }],
    }],
  });
  assert.equal(tree.leafId, "b");
  assert.deepEqual(tree.rows.map(({ id, depth, active, summary, label }) => ({ id, depth, active, summary, label })), [
    { id: "a", depth: 0, active: false, summary: "first prompt", label: null },
    { id: "b", depth: 1, active: true, summary: "answer", label: "Final" },
  ]);
  const bounded = flattenOmpSessionTree({ tree: Array.from({ length: 4 }, (_, i) => ({ entry: { id: String(i), type: "custom" } })) }, 2);
  assert.equal(bounded.rows.length, 2);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(flattenOmpSessionTree({ tree: [{ children: [{}] }] }).rows, []);
});

test("OMP forkable-message list preserves native entry IDs and bounds displayed text", () => {
  assert.deepEqual(normalizeOmpForkableMessages({ messages: [
    { entryId: "user-1", text: "  question\nwith details " },
    { entryId: "user-2", text: "follow-up" },
    { role: "assistant", text: "not forkable" },
    { entryId: 42, text: "invalid id" },
  ] }), [
    { entryId: "user-1", text: "question with details" },
    { entryId: "user-2", text: "follow-up" },
  ]);
  assert.equal(normalizeOmpForkableMessages({ messages: Array.from({ length: 5 }, (_, i) => ({ entryId: String(i), text: String(i) })) }, 2).length, 2);
  assert.equal(normalizeOmpForkableMessages({ messages: [{ entryId: "x", text: "x".repeat(500) }] })[0].text.length, 400);
});

test("OMP extension title, status, and string-array widgets render as distinct structured sections and reset per session", async () => {
  const source = await readFile(new URL("../src/components/OmpRpcInteraction.tsx", import.meta.url), "utf8");
  assert.match(source, /method === "setStatus"[\s\S]*?updateOmpStatusMap\(/);
  assert.match(source, /method === "setWidget"[\s\S]*?updateOmpWidgetMap\(/);
  assert.match(source, /method === "setTitle"[\s\S]*?setNativeTitle\(/);
  assert.match(source, /omp-rpc-status-title/);
  assert.match(source, /omp-rpc-status-text/);
  assert.match(source, /omp-rpc-widget-lines/);
  assert.match(source, /setNativeTitle\(""\);[\s\S]*?setWidgets\(\{\}\)/);
  const runtime = await readFile(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /PI_RPC_EMIT_TITLE: "1"/);
});


test("OMP session panel routes mutations through native RPC and clearly separates its shell from PI approvals", async () => {
  const component = await readFile(new URL("../src/components/OmpSessionControls.tsx", import.meta.url), "utf8");
  const allowlist = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  for (const command of ["remove_queued_message", "promote_queued_message", "set_label", "set_steering_mode", "set_follow_up_mode", "set_interrupt_mode", "set_auto_compaction", "set_auto_retry", "set_cache_warming", "compact", "abort_retry", "export_html", "handoff", "bash", "abort_bash"]) {
    assert.ok(component.includes(`"${command}"`), `panel should expose ${command}`);
    assert.ok(allowlist.includes(`"${command}"`), `IPC should allow ${command}`);
  }
  assert.doesNotMatch(component, /command: "clear_queue"/);
  assert.match(component, /ompRpcCommand\(\{ sessionId, command: "bash"/);
  assert.match(component, /native RPC shell|PI's queue or permission state/);
  assert.match(component, /generation !== refreshGenerationRef\.current \|\| sessionRef\.current !== id/);
  assert.match(component, /command: "get_tree"/);
  assert.match(component, /command: "get_branch_messages"/);
  assert.match(component, /normalizeOmpForkableMessages/);
  assert.doesNotMatch(component, /branchPreviewGenerationRef|setBranchPreviewLoading/);
  assert.match(component, /command: "get_session_stats"/);
  assert.match(component, /command: "get_session_lease"/);
  assert.match(component, /sessionLeaseState/);
  assert.match(component, /command: "get_last_assistant_text"/);
  const picker = await readFile(new URL("../src/features/chat/composer/ComposerOmpModelPicker.tsx", import.meta.url), "utf8");
  assert.match(picker, /command: "set_slow_mode"/);
  assert.match(picker, /slowModeSupported/);
  assert.match(component, /flattenOmpSessionTree/);
  assert.match(component, /Read-only|sessionTreeReadOnly/);
  assert.match(component, /forkSelectedEntry/);
  assert.match(component, /api\.forkOmpSession\(\{ sessionId, entryId: selectedTreeEntry \}\)/);
  assert.match(component, /syncNativeSessionTranscript\(sessionId, result\.parentMessages\)/);
  assert.match(component, /selectSession\(result\.session\.id\)/);
  // Historical navigation is intentionally represented as a durable fork,
  // never as a mutation of the active PI conversation's message list.
  assert.doesNotMatch(component, /command: "navigate_tree"|navigateToSelectedEntry|replaceSessionMessages\(sessionId/);
  assert.match(component, /settings\.omp\.forkFromEntry/);
  assert.match(component, /cacheWarmingMode/);
  assert.match(component, /cache_warming_start/);
  assert.match(component, /cache_warming_end/);
  assert.match(component, /excludeFromContext: true/);
  assert.match(component, /supportsBashExcludeFromContext/);
});
