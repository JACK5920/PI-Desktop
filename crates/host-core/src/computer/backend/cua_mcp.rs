//! Minimal MCP (Model Context Protocol) client over stdio for cua-driver.
//!
//! Why this exists: the native UIA backend in `windows.rs` cannot drive
//! WPF/Electron/UWP trees (those elements carry no HWND, so the backend's
//! ownership test rejects them), truncates its walk at 400 nodes, and cannot
//! reach TreeView/DataGridView content or WinForms combo boxes. `cua-driver`
//! handles all five; this module speaks its wire protocol so the same
//! `Desktop` contract can be served by it.
//!
//! Protocol shape (verified against cua-driver 0.44.0):
//!   -> {"jsonrpc":"2.0","id":N,"method":"initialize","params":{...}}\n
//!   <- {"jsonrpc":"2.0","id":N,"result":{"protocolVersion":"2025-06-18",...}}\n
//!   -> {"jsonrpc":"2.0","method":"notifications/initialized"}\n
//!   -> {"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"...","arguments":{...}}}\n
//!
//! Frame delimiter is a single `\n`. A response without `id` is a
//! notification and is dropped.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How long one `tools/call` may take. Generous because a UIA walk over a large
/// window plus a background click can each take seconds.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// `initialize` is fast; a slow one means the binary is wrong or wedged.
const INIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub enum McpError {
    /// No `cua-driver` binary could be located.
    NotInstalled,
    /// The process could not be started, or its pipes closed.
    Spawn(String),
    /// The server answered with a JSON-RPC error object.
    Rpc { code: i64, message: String },
    /// No answer inside the deadline.
    Timeout(String),
    /// The answer did not parse into the shape this module expects.
    Protocol(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::NotInstalled => write!(f, "cua-driver is not installed"),
            McpError::Spawn(m) => write!(f, "cua-driver could not start: {m}"),
            McpError::Rpc { code, message } => write!(f, "cua-driver refused ({code}): {message}"),
            McpError::Timeout(m) => write!(f, "cua-driver timed out: {m}"),
            McpError::Protocol(m) => write!(f, "cua-driver protocol error: {m}"),
        }
    }
}

/// Locate the driver the same way the plugin's `cua.js` does, so the two
/// never disagree about which binary is in use.
pub fn find_binary() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "cua-driver.exe"
    } else {
        "cua-driver"
    };

    // 1) PATH
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 2) Known install locations.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
        if let Some(local) = local.as_ref() {
            candidates.push(local.join("Programs").join("Cua").join("cua-driver").join("bin").join(exe));
            candidates.push(local.join("Programs").join("Cua").join("cua-driver").join(exe));
            candidates.push(local.join("Programs").join("cua-driver").join(exe));
        }
        if let Some(home) = home.as_ref() {
            candidates.push(home.join(".local").join("bin").join(exe));
            candidates.push(home.join(".cua").join("bin").join(exe));
        }
    } else if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local").join("bin").join(exe));
        candidates.push(home.join(".cua").join("bin").join(exe));
        candidates.push(PathBuf::from("/usr/local/bin").join(exe));
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(exe));
    }
    candidates.into_iter().find(|c| c.is_file())
}

/// A single long-lived `cua-driver mcp` process.
///
/// One process holds one runtime, so element tokens minted by a
/// `get_window_state` stay valid across the calls that follow it — which is
/// exactly what the wire protocol requires (a token from another process is
/// refused as `stale_element_token`).
pub struct McpClient {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    /// Responses arrive on a reader thread; calls wait on this channel keyed by
    /// request id. A `None` id means the reader thread hit EOF.
    rx: Mutex<Receiver<(u64, Result<Value, McpError>)>>,
    next_id: AtomicU64,
    binary: PathBuf,
}

impl McpClient {
    /// Spawn a server and complete the handshake. Blocking; call once at
    /// backend construction and keep the client for the backend's lifetime.
    pub fn spawn() -> Result<Arc<Self>, McpError> {
        let binary = find_binary().ok_or(McpError::NotInstalled)?;
        Self::spawn_at(&binary)
    }

    pub fn spawn_at(binary: &Path) -> Result<Arc<Self>, McpError> {
        let mut child = Command::new(binary)
            .arg("mcp")
            .current_dir(binary.parent().unwrap_or_else(|| Path::new(".")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| McpError::Spawn(e.to_string()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Spawn("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Spawn("no stdout".into()))?;

        let (tx, rx) = mpsc::channel::<(u64, Result<Value, McpError>)>();
        std::thread::Builder::new()
            .name("cua-mcp-reader".into())
            .spawn(move || read_loop(stdout, tx))
            .map_err(|e| McpError::Spawn(e.to_string()))?;

        let client = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            rx: Mutex::new(rx),
            next_id: AtomicU64::new(1),
            binary: binary.to_path_buf(),
        });

        client.handshake()?;
        Ok(client)
    }

    pub fn binary_path(&self) -> &Path {
        &self.binary
    }

    fn handshake(&self) -> Result<(), McpError> {
        // `initialize` is the one request that must not wait behind the usual
        // per-call timeout: a slow first launch (cold page cache) is normal.
        let init = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "pi-desktop-host-core", "version": env!("CARGO_PKG_VERSION") }
        });
        self.call_raw("initialize", init, INIT_TIMEOUT)?;
        // The follow-up notification carries no id and gets no response.
        self.notify("notifications/initialized", json!({}))?;
        Ok(())
    }

    fn write_frame(&self, value: &Value) -> Result<(), McpError> {
        let mut line = serde_json::to_string(value)
            .map_err(|e| McpError::Protocol(format!("serialize: {e}")))?;
        line.push('\n');
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| McpError::Spawn("stdin poisoned".into()))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| McpError::Spawn(format!("write: {e}")))
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), McpError> {
        self.write_frame(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn call_raw(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.write_frame(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;

        let rx = self
            .rx
            .lock()
            .map_err(|_| McpError::Spawn("receiver poisoned".into()))?;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(McpError::Timeout(method.to_string()));
            }
            match rx.recv_timeout(left) {
                Ok((got_id, Ok(value))) if got_id == id => return Ok(value),
                // A response for an older, already-abandoned request. Drop it.
                Ok((_, _)) => continue,
                Err(RecvTimeoutError::Timeout) => return Err(McpError::Timeout(method.to_string())),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(McpError::Spawn("server closed stdout".into()))
                }
            }
        }
    }

    /// Call a tool and return its `structuredContent` plus the joined text
    /// blocks. `isError: true` becomes `Err`, so callers never have to check.
    pub fn call_tool(&self, name: &str, args: Value) -> Result<ToolResult, McpError> {
        let raw = self.call_raw(
            "tools/call",
            json!({ "name": name, "arguments": args }),
            CALL_TIMEOUT,
        )?;
        ToolResult::from_raw(name, raw)
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // Closing stdin is the documented shutdown: the server owns its runtime
        // and exits on EOF. Kill only if it ignores that.
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = stdin.flush();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn read_loop(stdout: ChildStdout, tx: mpsc::Sender<(u64, Result<Value, McpError>)>) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            // A non-JSON line on stdout is protocol noise; skip rather than
            // poison every later call.
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            // Notification (no id). Nothing waits for it.
            continue;
        };
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let _ = tx.send((id, Err(McpError::Rpc { code, message })));
            continue;
        }
        let result = value.get("result").cloned().unwrap_or(Value::Null);
        let _ = tx.send((id, Ok(result)));
    }
}

/// One `tools/call` response, flattened into the two shapes callers need.
pub struct ToolResult {
    pub structured: Option<Value>,
    /// Every `content[].text` block joined with newlines. This is what carries
    /// the human-facing summary and, for `get_window_state`, the markdown tree.
    pub text: String,
}

impl ToolResult {
    fn from_raw(tool: &str, raw: Value) -> Result<Self, McpError> {
        if raw.get("isError").and_then(Value::as_bool) == Some(true) {
            // cua-driver puts the refusal in `content[].text` and often echoes a
            // structured `refusal` object; surface whichever exists.
            let text = join_text_blocks(&raw);
            // The driver does not put every refusal in the same place. Some
            // tools echo `structuredContent.refusal.code`; the input tools put
            // their code at the top of `structuredContent` instead:
            //
            //   {"code":"background_unavailable","escalation":{...}}
            //
            // Reading only the nested path reported every one of those as
            // `tool_error`, which silently defeated the escalation the driver
            // was asking for. Both shapes are read here.
            let structured = raw.get("structuredContent");
            let code = structured
                .and_then(|s| s.get("refusal"))
                .and_then(|r| r.get("code"))
                .and_then(Value::as_str)
                .or_else(|| {
                    structured
                        .and_then(|s| s.get("code"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("tool_error");
            return Err(McpError::Protocol(format!("{tool} refused [{code}]: {text}")));
        }
        Ok(Self {
            structured: raw.get("structuredContent").cloned(),
            text: join_text_blocks(&raw),
        })
    }

    /// Read a field out of `structuredContent`, falling back to `Null`.
    pub fn field(&self, key: &str) -> Value {
        self.structured
            .as_ref()
            .and_then(|s| s.get(key))
            .cloned()
            .unwrap_or(Value::Null)
    }
}

fn join_text_blocks(raw: &Value) -> String {
    let Some(items) = raw.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                out.push(text.to_string());
            }
        }
    }
    out.join("\n")
}

/// Tool names this backend uses, kept in one place so a driver rename is a
/// one-line fix rather than a hunt.
pub mod tools {
    pub const LIST_WINDOWS: &str = "list_windows";
    pub const GET_WINDOW_STATE: &str = "get_window_state";
    pub const CLICK: &str = "click";
    pub const DOUBLE_CLICK: &str = "double_click";
    pub const RIGHT_CLICK: &str = "right_click";
    pub const SET_VALUE: &str = "set_value";
    pub const TYPE_TEXT: &str = "type_text";
    pub const PRESS_KEY: &str = "press_key";
    pub const HOTKEY: &str = "hotkey";
    pub const SCROLL: &str = "scroll";
    pub const DRAG: &str = "drag";
    /// Multi-step script executed inside one driver session. Required wherever
    /// an action needs look-then-act: a fresh `capture_id` and a live element
    /// token only survive within a single connection, so a popup that has to be
    /// opened before its options exist cannot be driven one tool call at a time.
    pub const RUN_SCRIPT: &str = "run_script";
}

/// Cache of the most recent snapshot per window.
///
/// Element tokens are `{snapshot_id}:{row}` and go stale the moment that
/// window is read again, so the backend must remember which snapshot its uids
/// came from. Shared by `Arc` because `Desktop` takes `&self`.
#[derive(Default)]
pub struct SnapshotCache {
    inner: Mutex<HashMap<(i32, u64), SnapshotEntry>>,
}

#[derive(Clone)]
pub struct SnapshotEntry {
    pub snapshot_id: String,
    /// Row index in the snapshot the uid was minted from, keyed by uid.
    pub rows: HashMap<String, usize>,
    /// The markdown tree that snapshot returned, so later lookups can re-derive
    /// a row without another round trip.
    pub markdown: String,
    pub truncated: bool,
    pub element_count: usize,
}

impl SnapshotCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&self, pid: i32, window: u64, entry: SnapshotEntry) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert((pid, window), entry);
        }
    }

    pub fn get(&self, pid: i32, window: u64) -> Option<SnapshotEntry> {
        self.inner
            .lock()
            .ok()
            .and_then(|map| map.get(&(pid, window)).cloned())
    }

    pub fn row_for_uid(&self, pid: i32, window: u64, uid: &str) -> Option<usize> {
        self.inner
            .lock()
            .ok()
            .and_then(|map| map.get(&(pid, window)).and_then(|e| e.rows.get(uid).copied()))
    }
}
