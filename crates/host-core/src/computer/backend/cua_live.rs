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
    eprintln!("measured {}x{}", measured.bounds.width, measured.bounds.height);
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
        .or_else(|| inspection.nodes.iter().find(|n| n.label.as_deref() == Some(uid.as_str())))
        .expect("the requested uid or label is in the tree");
    eprintln!("target node: uid={} role={} label={:?} actions={:?}",
        node.uid, node.role, node.label, node.actions);
    assert!(!node.actions.is_empty(), "a clickable node advertises an action");

    let action = Action {
        kind: Some(node.actions[0]),
        uid: Some(node.uid.clone()),
        ..Default::default()
    };
    let dispatched = backend.perform(&target, Some(&node.uid), &action).expect("perform");
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
    file.write_all(RECORDER_JS.as_bytes()).expect("write recorder");
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
