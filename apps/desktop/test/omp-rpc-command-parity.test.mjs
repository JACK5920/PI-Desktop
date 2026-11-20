import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Canonical RpcCommand union from oh-my-pi v18.22.2
// (can1357/oh-my-pi, tag commit e1ae2cc). The upstream RPC command/types and
// documentation are byte-identical to v18.22.1, so the command manifest stays
// unchanged; update this list only after auditing the new release source.
// Keep this list synchronized when the managed OMP release changes; a new
// upstream command must be implemented, deliberately handled internally, or
// explicitly rejected with a documented reason before the update is accepted.
const UPSTREAM_RPC_COMMANDS = [
  "abort", "abort_and_prompt", "abort_and_restore_queue", "abort_bash", "abort_branch_summary",
  "abort_retry", "bash", "branch", "btw", "btw_cancel", "cancel_subagent", "compact",
  "cycle_model", "cycle_thinking_level", "dictation_start", "dictation_stop", "export_html",
  "follow_up", "fork", "get_available_commands", "get_available_models", "get_available_thinking_levels",
  "get_branch_messages", "get_btw_history", "get_entries", "get_last_assistant_text", "get_login_providers",
  "get_logout_accounts", "get_messages", "get_messages_page", "get_session_lease", "get_session_stats",
  "get_state", "get_subagent_messages", "get_subagents", "get_tree", "goal", "handoff", "live_connect",
  "live_mute", "live_start", "live_stop", "login", "logout", "navigate_tree", "negotiate_protocol",
  "new_session", "open_session", "predict_word", "predict_word_feedback", "promote_queued_message", "prompt",
  "remove_queued_message", "set_ask_dialog", "set_auto_compaction", "set_auto_retry", "set_cache_warming",
  "set_event_filter", "set_fast_mode", "set_follow_up_mode", "set_host_tools", "set_host_uri_schemes",
  "set_interrupt_mode", "set_label", "set_model", "set_session_name", "set_slow_mode", "set_steering_mode",
  "set_subagent_subscription", "set_thinking_level", "set_todos", "steer", "steer_subagent", "switch_session",
];

// navigate_tree is issued only by the controlled native-history adapter after
// validating the selected OMP tree node; it must not be exposed as arbitrary
// renderer IPC because that could desynchronize the PI transcript mirror.
const INTERNAL_COMMANDS = ["navigate_tree", "negotiate_protocol", "set_host_tools", "set_host_uri_schemes"];

test("OMP RPC command parity accounts for every command in the pinned upstream release", async () => {
  const ipc = await readFile(new URL("../electron/main/ipc/register.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../electron/main/omp/rpc-runtime.ts", import.meta.url), "utf8");
  const settingsStart = ipc.indexOf("const managementCommands = new Set([");
  const allowStart = ipc.indexOf("const allowedCommands = new Set([");
  assert.notEqual(settingsStart, -1, "OMP provider settings must keep a dedicated RPC allowlist");
  assert.notEqual(allowStart, -1, "OMP chat RPC must keep a session-scoped command allowlist");
  const settingsEnd = ipc.indexOf("]);", settingsStart);
  const allowEnd = ipc.indexOf("]);", allowStart);
  assert.ok(settingsEnd > settingsStart);
  assert.ok(allowEnd > allowStart);

  const readSet = (source) => new Set(
    [...source.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]),
  );
  const management = readSet(ipc.slice(settingsStart, settingsEnd));
  const allowed = readSet(ipc.slice(allowStart, allowEnd));
  const upstream = new Set(UPSTREAM_RPC_COMMANDS);

  assert.equal(UPSTREAM_RPC_COMMANDS.length, 74, "pinned upstream command manifest changed unexpectedly");
  assert.equal(upstream.size, UPSTREAM_RPC_COMMANDS.length, "manifest must not contain duplicate commands");
  assert.deepEqual(
    [...upstream].filter((command) => !allowed.has(command)).sort(),
    [...INTERNAL_COMMANDS].sort(),
    "every non-internal upstream command must be available through the desktop RPC adapter",
  );
  assert.deepEqual(
    [...allowed].filter((command) => !upstream.has(command)),
    [],
    "desktop RPC allowlist must not drift beyond OMP's native protocol",
  );
  assert.ok([...management].every((command) => allowed.has(command)));
  assert.deepEqual(
    [...management].filter((command) => !["get_state", "get_available_models", "get_available_thinking_levels", "get_login_providers", "get_logout_accounts", "login", "logout", "set_model"].includes(command)),
    [],
    "the dedicated provider-management RPC surface must remain narrower than chat RPC",
  );

  assert.match(runtime, /command\(session\.sessionId, "negotiate_protocol"/);
  assert.match(runtime, /command\(session\.sessionId, "set_host_tools"/);
  assert.match(runtime, /command\(session\.sessionId, "set_host_uri_schemes"/);
});
