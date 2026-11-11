//! End-to-end check for the cua-driver backend against a live window.
//!
//! Ignored by default: it spawns `cua-driver`, needs a real desktop session, and
//! targets whatever window `CU_TEST_PID` / `CU_TEST_WINDOW` name. Run it with:
//!
//! ```text
//! set CUA_DRIVER_BACKEND=1
//! set CU_TEST_PID=<pid> & set CU_TEST_WINDOW=<hwnd>
//! cargo test -p host-core --bin pi-desktop-host-core cua_live -- --ignored --nocapture
//! ```
//!
//! What it proves, in order: the driver spawns and handshakes, `list_targets`
//! enumerates, `inspect` returns nodes with real actions, and a `Click` against
//! a node uid actually lands. The last step is the one that matters — the whole
//! reason this backend exists.

use super::cua::CuaDesktop;
use super::*;
use crate::computer::{Action, ActionKind, Point};

fn live_target() -> Option<(TargetRef, String)> {
    let pid = std::env::var("CU_TEST_PID").ok()?.parse::<i32>().ok()?;
    let window = std::env::var("CU_TEST_WINDOW").ok()?.parse::<u64>().ok()?;
    let uid = std::env::var("CU_TEST_UID").unwrap_or_default();
    Some((
        TargetRef {
            target_id: format!("{pid}:{window}"),
            pid,
            window,
            app_key: String::new(),
        },
        uid,
    ))
}

#[test]
#[ignore = "spawns cua-driver and drives a live window"]
fn cua_live_inspect_and_click() {
    let Some((target, uid)) = live_target() else {
        eprintln!("skipped: CU_TEST_PID / CU_TEST_WINDOW not set");
        return;
    };

    let backend = CuaDesktop::new().expect("cua-driver spawns and handshakes");

    let caps = backend.capabilities();
    assert_eq!(caps.backend, "cua-driver-mcp");
    eprintln!("backend={} platform={}", caps.backend, caps.platform);

    let targets = backend.list_targets().expect("list_targets");
    eprintln!("enumerated {} window(s)", targets.len());
    assert!(
        targets
            .iter()
            .any(|t| t.target.pid == target.pid && t.target.window == target.window),
        "the live target must appear in the driver's own enumeration"
    );

    let measured = backend.measure(&target).expect("measure");
    eprintln!(
        "measured {}x{}",
        measured.bounds.width, measured.bounds.height
    );
    assert!(measured.bounds.width > 0.0 && measured.bounds.height > 0.0);

    let inspection = backend.inspect(&target, 500).expect("inspect");
    eprintln!(
        "inspect: {} node(s), truncated={}, fidelity={:?}",
        inspection.nodes.len(),
        inspection.truncated,
        inspection.fidelity
    );
    assert!(!inspection.nodes.is_empty(), "a live window yields nodes");
    assert!(
        inspection.nodes.iter().any(|n| !n.actions.is_empty()),
        "at least one node must advertise an action, or nothing is clickable"
    );

    if uid.is_empty() {
        eprintln!("no CU_TEST_UID: stopping before the click assertion");
        return;
    }

    let node = inspection
        .nodes
        .iter()
        .find(|n| n.uid == uid)
        .or_else(|| {
            inspection
                .nodes
                .iter()
                .find(|n| n.label.as_deref() == Some(uid.as_str()))
        })
        .expect("the requested uid or label is in the tree");
    eprintln!(
        "target node: uid={} role={} label={:?} actions={:?}",
        node.uid, node.role, node.label, node.actions
    );
    assert!(
        !node.actions.is_empty(),
        "a clickable node advertises an action"
    );

    let action = Action {
        kind: Some(node.actions[0]),
        uid: Some(node.uid.clone()),
        ..Default::default()
    };
    let dispatched = backend
        .perform(&target, Some(&node.uid), &action)
        .expect("perform");
    eprintln!("dispatched {:?} on {}", dispatched, node.uid);
}

#[test]
#[ignore = "spawns cua-driver"]
fn cua_live_hover_is_refused() {
    let Some((target, _)) = live_target() else {
        return;
    };
    let backend = CuaDesktop::new().expect("cua-driver spawns");
    let inspection = backend.inspect(&target, 100).expect("inspect");
    let Some(node) = inspection.nodes.iter().find(|n| !n.actions.is_empty()) else {
        return;
    };
    let action = Action {
        kind: Some(ActionKind::Hover),
        uid: Some(node.uid.clone()),
        point: Some(Point { x: 1.0, y: 1.0 }),
        ..Default::default()
    };
    // The contract is a refusal, not a silent no-op: the caller must be able to
    // fall back to the native backend for hover.
    assert_eq!(
        backend.perform(&target, Some(&node.uid), &action),
        Err(DesktopError::NotActionable)
    );
}

// ---------------------------------------------------------------------------
// Wire-shape tests: what the bridge actually sends the driver.
//
// These spawn a recorder in place of `cua-driver`, so they touch no window and
// need no desktop session. They exist because the driver accepts wrong input
// silently — a `cmd` modifier is dropped and the bare key is sent, and a missing
// `amount` becomes the default three ticks — so the only way to hold the mapping
// is to assert on the arguments themselves.
// ---------------------------------------------------------------------------

/// A driver stand-in that records every `tools/call` and answers minimally.
fn recorder_driver(dir: &std::path::Path) -> std::path::PathBuf {
    use std::io::Write;
    std::fs::create_dir_all(dir).expect("recorder dir");
    let script = dir.join("fake.js");
    let mut file = std::fs::File::create(&script).expect("recorder script");
    file.write_all(RECORDER_JS.as_bytes())
        .expect("write recorder");
    drop(file);
    #[cfg(windows)]
    let entry = dir.join("cua-driver.cmd");
    #[cfg(not(windows))]
    let entry = dir.join("cua-driver");
    let mut entry_file = std::fs::File::create(&entry).expect("recorder entry");
    #[cfg(windows)]
    entry_file
        .write_all(format!("@echo off\r\nnode \"{}\" %*\r\n", script.display()).as_bytes())
        .expect("write entry");
    #[cfg(not(windows))]
    entry_file
        .write_all(format!("#!/bin/sh\nexec node \"{}\" \"$@\"\n", script.display()).as_bytes())
        .expect("write entry");
    drop(entry_file);
    entry
}

const RECORDER_JS: &str = r#"
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'captured-calls.jsonl');
let nextSnapshot = 1;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'recorder', version: '0.0.1' } } });
      continue;
    }
    if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, result: {} }); continue; }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    fs.appendFileSync(LOG, JSON.stringify({ tool: name, args }) + '\n', 'utf8');
    let structured = {};
    if (name === 'get_window_state') {
      const cap = 's' + String(nextSnapshot++).padStart(8, '0');
      structured = { snapshot_id: cap, element_count: 3, truncated: false,
        tree_markdown: '- Window "Fake"\n  - [0] Pane [actions=[scroll]]\n    - [1] ComboBox "Combo:" [actions=[expand,scroll]]\n      - [2] ListItem "Alpha" [actions=[select]]\n' };
    } else if (name === 'press_key' || name === 'hotkey') {
      if (!args.delivery_mode || args.delivery_mode === 'background') {
        send({ jsonrpc: '2.0', id, result: { isError: true,
          content: [{ type: 'text', text: 'background dropped; retry with delivery_mode foreground' }],
          structuredContent: { code: 'background_unavailable',
            escalation: { reason: 'background dropped', recommended: 'foreground' } } } });
        continue;
      }
      structured = { ok: true, delivery: { mode: args.delivery_mode } };
    } else if (name === 'scroll') {
      structured = { ok: true };
    }
    send({ jsonrpc: '2.0', id, result: { isError: false,
      content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } });
  }
});
process.stdin.on('end', () => process.exit(0));
"#;

/// Read back what the recorder captured.
fn captured(dir: &std::path::Path) -> Vec<serde_json::Value> {
    let path = dir.join("captured-calls.jsonl");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Fresh scratch dir per test, so parallel tests cannot read each other's log.
fn recorder_dir(name: &str) -> std::path::PathBuf {
    let base = std::env::var("PI_SCRATCH_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join(format!("cua-wire-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn fake_target() -> TargetRef {
    TargetRef {
        target_id: "4242:777".into(),
        pid: 4242,
        window: 777,
        app_key: String::new(),
    }
}

/// A `cmd+a` chord must reach the driver as `["ctrl","a"]`, and the retry after
/// `background_unavailable` must carry `delivery_mode: "foreground"`.
///
/// Measured on a live WPF target: the driver accepts `cmd` without complaint and
/// then sends a bare `a`, so a wrong mapping is a silent wrong keystroke rather
/// than an error. That is why this asserts on the wire, not on a return value.
#[test]
fn a_macos_chord_reaches_the_driver_as_ctrl_and_escalates() {
    let dir = recorder_dir("chord");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&recorder_driver(&dir)).expect("recorder spawns"),
    );
    let action = Action {
        kind: Some(ActionKind::PressKeys),
        keys: Some(vec!["cmd+a".into()]),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), None, &action)
        .expect("press_keys dispatches against the recorder");

    let calls = captured(&dir);
    let hotkeys: Vec<_> = calls.iter().filter(|c| c["tool"] == "hotkey").collect();
    assert!(
        !hotkeys.is_empty(),
        "a chord must go out as `hotkey`, not `press_key`; captured: {calls:?}"
    );
    assert_eq!(
        hotkeys[0]["args"]["keys"],
        serde_json::json!(["ctrl", "a"]),
        "`cmd` must be rewritten to `ctrl` before the driver sees it"
    );
    assert!(
        hotkeys.len() >= 2,
        "the first refusal must be retried once, captured: {hotkeys:?}"
    );
    assert_eq!(
        hotkeys[1]["args"]["delivery_mode"], "foreground",
        "the retry must carry the escalation the driver asked for"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A scroll delta must arrive as a tick count, not a bare direction.
#[test]
fn a_scroll_delta_reaches_the_driver_as_a_tick_count() {
    let dir = recorder_dir("scroll");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&recorder_driver(&dir)).expect("recorder spawns"),
    );
    let action = Action {
        kind: Some(ActionKind::Scroll),
        scroll: Some(crate::computer::Scroll { dx: 0.0, dy: 20.0 }),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), None, &action)
        .expect("scroll dispatches against the recorder");

    let calls = captured(&dir);
    let scrolls: Vec<_> = calls.iter().filter(|c| c["tool"] == "scroll").collect();
    assert_eq!(scrolls.len(), 1, "captured: {calls:?}");
    assert_eq!(scrolls[0]["args"]["direction"], "down");
    assert_eq!(
        scrolls[0]["args"]["amount"], 20,
        "dy=20 must become amount=20, not the driver default of 3"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The driver's own ceiling is 50; anything above must be clamped here rather
/// than silently truncated there.
#[test]
fn an_oversized_scroll_is_clamped_to_the_driver_ceiling() {
    let dir = recorder_dir("scroll-clamp");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&recorder_driver(&dir)).expect("recorder spawns"),
    );
    let action = Action {
        kind: Some(ActionKind::Scroll),
        scroll: Some(crate::computer::Scroll { dx: 0.0, dy: 900.0 }),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), None, &action)
        .expect("scroll dispatches against the recorder");

    let calls = captured(&dir);
    let scrolls: Vec<_> = calls.iter().filter(|c| c["tool"] == "scroll").collect();
    assert_eq!(scrolls[0]["args"]["amount"], 50, "captured: {calls:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A driver stand-in whose chord answer is scripted: the first `hotkey` call
/// answers with the scan-timeout refusal and every later one succeeds.
///
/// The real driver reports a chord it cannot resolve two ways, and only one of
/// them leaves the question open. The bridge retries the first kind and
/// propagates the second, so the difference has to hold on the wire.
fn scripted_recorder_driver(dir: &std::path::Path, script: &str) -> std::path::PathBuf {
    use std::io::Write;
    std::fs::create_dir_all(dir).expect("recorder dir");
    let path = dir.join("fake.js");
    let mut file = std::fs::File::create(&path).expect("recorder script");
    file.write_all(script.as_bytes()).expect("write recorder");
    drop(file);
    #[cfg(windows)]
    let entry = dir.join("cua-driver.cmd");
    #[cfg(not(windows))]
    let entry = dir.join("cua-driver");
    let mut entry_file = std::fs::File::create(&entry).expect("recorder entry");
    #[cfg(windows)]
    entry_file
        .write_all(format!("@echo off\r\nnode \"{}\" %*\r\n", path.display()).as_bytes())
        .expect("write entry");
    #[cfg(not(windows))]
    entry_file
        .write_all(format!("#!/bin/sh\nexec node \"{}\" \"$@\"\n", path.display()).as_bytes())
        .expect("write entry");
    drop(entry_file);
    entry
}

/// The recorder that times out on the first chord and succeeds on the second.
const SCAN_TIMEOUT_RECORDER_JS: &str = r##"
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'captured-calls.jsonl');
let nextSnapshot = 1;
let chords = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'recorder', version: '0.0.1' } } });
      continue;
    }
    if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, result: {} }); continue; }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    fs.appendFileSync(LOG, JSON.stringify({ tool: name, args }) + '\n', 'utf8');
    let structured = {};
    if (name === 'list_windows') {
      structured = { windows: [
        { pid: 4242, window_id: 777, title: 'recorder', app_name: 'recorder.exe',
          bounds: { x: 0, y: 0, w: 100, h: 100 } }
      ] };
    } else if (name === 'get_window_state') {
      const cap = 's' + String(nextSnapshot++).padStart(8, '0');
      structured = { snapshot_id: cap, element_count: 3, truncated: false, tree_markdown: '',
        elements_complete: true,
        elements: [
          { element_index: 2, element_token: cap + ':2', role: 'TabItem', label: 'tab', actions: ['select'] },
          { element_index: 6, element_token: cap + ':6', role: 'MenuItem', label: 'File', actions: ['invoke', 'expand'] }
        ] };
    } else if (name === 'hotkey') {
      chords += 1;
      if (chords === 1) {
        send({ jsonrpc: '2.0', id, result: { isError: true,
          content: [{ type: 'text', text: 'hotkey (UIA path): UIA accelerator scan exceeded 4000ms; a UIA provider in the target app is likely unresponsive' }],
          structuredContent: { code: 'tool_invocation_failed' } } });
        continue;
      }
      structured = { ok: true };
    }
    send({ jsonrpc: '2.0', id, result: { isError: false,
      content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } });
  }
});
process.stdin.on('end', () => process.exit(0));
"##;

/// A chord whose accessibility scan timed out is worth one more attempt.
///
/// The driver answers a chord it cannot resolve two ways. "could not find a
/// UIA AcceleratorKey" is settled -- the target exposes no accelerator and
/// repeating only spends the action's time. "UIA accelerator scan exceeded
/// 4000ms" claims a slow accessibility provider, which can pass, so on a
/// connection that has not enumerated yet the chord gets one more try.
#[test]
fn a_chord_whose_scan_timed_out_is_retried_once() {
    let dir = recorder_dir("scan-timeout");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&scripted_recorder_driver(
            &dir,
            SCAN_TIMEOUT_RECORDER_JS,
        ))
        .expect("recorder spawns"),
    );
    let action = Action {
        kind: Some(ActionKind::PressKeys),
        keys: Some(vec!["ctrl+s".into()]),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), None, &action)
        .expect("the retried chord succeeds against the recorder");

    let calls = captured(&dir);
    let hotkeys: Vec<_> = calls.iter().filter(|c| c["tool"] == "hotkey").collect();
    assert_eq!(
        hotkeys.len(),
        2,
        "a scan that timed out must be retried exactly once; captured: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// After the connection has enumerated the desktop's windows, the timeout
/// wording is not a timeout and must not be retried.
///
/// Measured on a live target: a fresh driver process answers a chord the
/// target exposes no accelerator for with the settled wording in ~50ms, and
/// the same chord after one `list_windows` answers with the timeout wording
/// in ~4ms -- a scan that exceeded 4000ms cannot answer in 4ms. The
/// contamination is sticky, so the repeat answers the same way and the retry
/// would spend the action's budget to arrive at the same refusal.
///
/// What the bridge owes the caller instead is the advice: the timeout
/// wording names a provider that is "likely unresponsive" and says nothing
/// about what to do, while the settled wording it stands in for says the
/// action is nested behind a closed menu and to click the item instead.
#[test]
fn a_chord_on_an_enumerated_connection_is_not_retried_and_keeps_the_advice() {
    let dir = recorder_dir("enumerated-timeout");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&scripted_recorder_driver(
            &dir,
            SCAN_TIMEOUT_RECORDER_JS,
        ))
        .expect("recorder spawns"),
    );
    // The enumeration is what turns the driver's diagnostic into a lie, and
    // the host is the one that does it.
    backend
        .list_targets()
        .expect("the recorder answers an enumeration");

    let action = Action {
        kind: Some(ActionKind::PressKeys),
        keys: Some(vec!["ctrl+s".into()]),
        ..Default::default()
    };
    let error = backend
        .perform(&fake_target(), None, &action)
        .expect_err("the chord is refused on an enumerated connection");
    let message = match error {
        super::super::DesktopError::Failed(message) => message,
        other => panic!("expected a refusal with a message, got {other:?}"),
    };
    assert!(
        message.contains("click the matching element directly")
            || message.contains("click` the matching element directly"),
        "the advice has to survive the wrong wording: {message}"
    );

    let calls = captured(&dir);
    let hotkeys: Vec<_> = calls.iter().filter(|c| c["tool"] == "hotkey").collect();
    assert_eq!(
        hotkeys.len(),
        1,
        "a refusal that cannot change must not be retried; captured: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A chord the target genuinely cannot resolve is not retried.
///
/// The settled refusal is an answer, not a hiccup: repeating it spends the
/// action's time and changes nothing.
#[test]
fn a_chord_with_no_accelerator_is_not_retried() {
    const SETTLED_RECORDER_JS: &str = r##"
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'captured-calls.jsonl');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'recorder', version: '0.0.1' } } });
      continue;
    }
    if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, result: {} }); continue; }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    fs.appendFileSync(LOG, JSON.stringify({ tool: name, args }) + '\n', 'utf8');
    if (name === 'hotkey') {
      send({ jsonrpc: '2.0', id, result: { isError: true,
        content: [{ type: 'text', text: 'hotkey on a modern XAML / UWP target could not find a UIA AcceleratorKey matching ctrl+s (scanned 42 element(s)).' }],
        structuredContent: { code: 'tool_invocation_failed' } } });
      continue;
    }
    send({ jsonrpc: '2.0', id, result: { isError: false,
      content: [{ type: 'text', text: '{}' }], structuredContent: {} } });
  }
});
process.stdin.on('end', () => process.exit(0));
"##;

    let dir = recorder_dir("no-accelerator");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&scripted_recorder_driver(&dir, SETTLED_RECORDER_JS))
            .expect("recorder spawns"),
    );
    let action = Action {
        kind: Some(ActionKind::PressKeys),
        keys: Some(vec!["ctrl+s".into()]),
        ..Default::default()
    };
    assert!(
        backend.perform(&fake_target(), None, &action).is_err(),
        "a chord with no accelerator must fail"
    );

    let calls = captured(&dir);
    let hotkeys: Vec<_> = calls.iter().filter(|c| c["tool"] == "hotkey").collect();
    assert_eq!(
        hotkeys.len(),
        1,
        "a settled refusal must not be retried; captured: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// An action on a minimized window is refused, and the bridge restores the
/// window and tries the same action again.
///
/// Measured on a live target: the driver resolves an element on a minimized
/// window to the Win32 iconic sentinel coordinates off the edge of every
/// display, so it refuses the action with `window_minimized` and names
/// `bring_to_front` as the way out. Without the bridge taking that step, a
/// minimized window is a dead end: every action on it is refused and the
/// refusal tells the model to call a tool it cannot call.
///
/// The retry carries the action unchanged, because the action was never
/// wrong -- it was addressed to a window that was not on screen.
#[test]
fn an_action_on_a_minimized_window_restores_it_and_tries_again() {
    const MINIMIZED_RECORDER_JS: &str = r##"
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'captured-calls.jsonl');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
let clicks = 0;
let restored = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'recorder', version: '0.0.1' } } });
      continue;
    }
    if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, result: {} }); continue; }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    fs.appendFileSync(LOG, JSON.stringify({ tool: name, args }) + '\n', 'utf8');
    if (name === 'click') {
      clicks += 1;
      // The window is minimized until it is brought to the front, so every
      // click before that is refused.
      if (!restored) {
        send({ jsonrpc: '2.0', id, result: { isError: true,
          content: [{ type: 'text', text: 'click refused [window_minimized]: refused (window_minimized): Element [6] resolves to (-31966,-31942), which is the Win32 iconic sentinel rather than a location on any display -- window 0x450778 is minimized, so clicking would be posted off-screen and silently do nothing. Call bring_to_front with this window_id to restore it, then re-snapshot with get_window_state.' }],
          structuredContent: { code: 'window_minimized' } } });
        continue;
      }
      send({ jsonrpc: '2.0', id, result: { isError: false,
        content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } } });
      continue;
    }
    if (name === 'bring_to_front') {
      restored = true;
      send({ jsonrpc: '2.0', id, result: { isError: false,
        content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } } });
      continue;
    }
    if (name === 'get_window_state') {
      const cap = 's00000001';
      send({ jsonrpc: '2.0', id, result: { isError: false,
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { snapshot_id: cap, element_count: 2, truncated: false,
          tree_markdown: '', elements_complete: true,
          elements: [
            { element_index: 6, element_token: cap + ':6', role: 'MenuItem', label: 'File', actions: ['invoke', 'expand'] }
          ] } } });
      continue;
    }
    send({ jsonrpc: '2.0', id, result: { isError: false,
      content: [{ type: 'text', text: '{}' }], structuredContent: {} } });
  }
});
process.stdin.on('end', () => process.exit(0));
"##;

    let dir = recorder_dir("minimized");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&scripted_recorder_driver(&dir, MINIMIZED_RECORDER_JS))
            .expect("recorder spawns"),
    );
    // The click needs a live element token, so the tree is read first.
    backend
        .inspect(&fake_target(), 100)
        .expect("the recorder answers a tree read");

    let action = Action {
        kind: Some(ActionKind::Click),
        uid: Some("s00000001:6".into()),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), Some("s00000001:6"), &action)
        .expect("the action lands once the window is restored");

    let calls = captured(&dir);
    let fronts = calls
        .iter()
        .filter(|c| c["tool"] == "bring_to_front")
        .count();
    assert_eq!(
        fronts, 1,
        "the window has to be restored exactly once; captured: {calls:?}"
    );
    let clicks: Vec<_> = calls.iter().filter(|c| c["tool"] == "click").collect();
    assert!(
        clicks.len() >= 2,
        "the action is tried again after the restore; captured: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A menu bar item is opened on the way, so the commands under it exist.
///
/// Measured on a live Notepad: the tree holds "File" and no "Save"; after the
/// item is expanded the tree holds "Save", "Save As" and the rest, and 29
/// elements become 56. The command is what the caller wanted, and it is only
/// reachable once the menu is open.
///
/// Only a menu is opened. A tree item can expand as well, and a combo box
/// can, but expanding one of those is not clicking it -- and a bridge that
/// expands first and reports success would claim an action that never
/// happened. So the role decides: a menu item is opened, everything else is
/// clicked.
#[test]
fn a_menu_bar_item_is_opened_and_an_ordinary_element_is_clicked() {
    const MENU_RECORDER_JS: &str = r##"
const fs = require('fs');
const path = require('path');
const LOG = path.join(__dirname, 'captured-calls.jsonl');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'recorder', version: '0.0.1' } } });
      continue;
    }
    if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, result: {} }); continue; }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    fs.appendFileSync(LOG, JSON.stringify({ tool: name, args }) + '\n', 'utf8');
    if (name === 'click' && args.action === 'expand') {
      // The element under the pointer decides: a menu bar item and a tree
      // item both expand, a tab item does not.
      if (args.element_token === 's00000001:6' || args.element_token === 's00000001:9') {
        send({ jsonrpc: '2.0', id, result: { isError: false,
          content: [{ type: 'text', text: 'Expanded UIA element via ExpandCollapsePattern.' }],
          structuredContent: { ok: true } } });
      } else {
        send({ jsonrpc: '2.0', id, result: { isError: true,
          content: [{ type: 'text', text: 'ExpandCollapsePattern unavailable: operation completed successfully. (0x00000000)' }],
          structuredContent: { code: 'tool_invocation_failed' } } });
      }
      continue;
    }
    if (name === 'get_window_state') {
      const cap = 's00000001';
      send({ jsonrpc: '2.0', id, result: { isError: false,
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { snapshot_id: cap, element_count: 3, truncated: false,
          tree_markdown: '', elements_complete: true,
          elements: [
            { element_index: 2, element_token: cap + ':2', role: 'TabItem', label: 'tab', actions: ['select'] },
            { element_index: 6, element_token: cap + ':6', role: 'MenuItem', label: 'File', actions: ['invoke', 'expand'] },
            { element_index: 9, element_token: cap + ':9', role: 'TreeItem', label: 'node', actions: ['invoke', 'expand'] }
          ] } } });
      continue;
    }
    send({ jsonrpc: '2.0', id, result: { isError: false,
      content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } } });
  }
});
process.stdin.on('end', () => process.exit(0));
"##;

    let dir = recorder_dir("menu");
    let backend = CuaDesktop::with_client(
        super::cua_mcp::McpClient::spawn_at(&scripted_recorder_driver(&dir, MENU_RECORDER_JS))
            .expect("recorder spawns"),
    );
    backend
        .inspect(&fake_target(), 100)
        .expect("the recorder answers a tree read");

    let action = Action {
        kind: Some(ActionKind::Click),
        uid: Some("s00000001:6".into()),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), Some("s00000001:6"), &action)
        .expect("the menu bar item is opened");

    let calls = captured(&dir);
    let clicks: Vec<_> = calls.iter().filter(|c| c["tool"] == "click").collect();
    assert_eq!(
        clicks.len(),
        1,
        "a menu bar item is opened with one expand; captured: {calls:?}"
    );
    assert_eq!(
        clicks[0]["args"]["action"], "expand",
        "the click has to be the expand; captured: {calls:?}"
    );

    // An element that can expand but is not a menu is clicked the ordinary
    // way. Expanding a tree item is not clicking it: the caller asked for a
    // click, and an expand would report success for an action that did not
    // happen.
    let tree = Action {
        kind: Some(ActionKind::Click),
        uid: Some("s00000001:9".into()),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), Some("s00000001:9"), &tree)
        .expect("a tree item is clicked");

    let calls = captured(&dir);
    let clicks: Vec<_> = calls.iter().filter(|c| c["tool"] == "click").collect();
    assert_eq!(
        clicks.len(),
        2,
        "a tree item is clicked, not expanded; captured: {calls:?}"
    );
    assert!(
        clicks[1]["args"].get("action").is_none(),
        "the tree item has to be clicked outright; captured: {calls:?}"
    );

    // An element that cannot be expanded is clicked the ordinary way too.
    let plain = Action {
        kind: Some(ActionKind::Click),
        uid: Some("s00000001:2".into()),
        ..Default::default()
    };
    backend
        .perform(&fake_target(), Some("s00000001:2"), &plain)
        .expect("an ordinary element is clicked");

    let calls = captured(&dir);
    let clicks: Vec<_> = calls.iter().filter(|c| c["tool"] == "click").collect();
    assert_eq!(
        clicks.len(),
        3,
        "the ordinary click follows; captured: {calls:?}"
    );
    assert!(
        clicks[2]["args"].get("action").is_none(),
        "the fallback is the plain click; captured: {calls:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
