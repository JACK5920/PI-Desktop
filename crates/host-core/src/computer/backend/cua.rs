//! A `Desktop` backend served by `cua-driver` over MCP.
//!
//! # Why this backend exists
//!
//! The native `windows.rs` backend drives Windows through its own UIA calls. On
//! hardware measured in this repo it fails five situations that this backend
//! handles, all confirmed against a purpose-built target:
//!
//! | Case | Native | This backend |
//! |---|---|---|
//! | WPF window (elements carry HWND 0) | `disabled`, `actions=[]` | invokes |
//! | Electron / Chromium content | `disabled` | invokes |
//! | 515-element window, target at row 513 | unreachable past 400 | reachable |
//! | `SysTreeView32` (exposes `Pane`, no patterns) | `actions=[]` | `select`/`expand` |
//! | WinForms `ComboBox` | `set_value` shows text, app never told | `CBN_SELCHANGE` sent |
//!
//! # Element identity
//!
//! `Node::uid` is `{snapshot_id}:{row}` taken straight from cua-driver's
//! `element_token`. That is deliberately not stable across snapshots — the
//! protocol invalidates a token when the same window is read again — so the
//! snapshot cache records which read minted each uid. Acting on a uid from an
//! older read returns `ElementNotFound` with a re-inspect hint, matching what
//! the wire protocol itself does.
//!
//! # What this backend cannot do
//!
//! `Hover` has no equivalent: cua-driver's `move_cursor` moves an overlay
//! pointer, not the OS cursor, and `click` exposes only `action: "expand"`.
//! `perform` refuses `Hover` with `NotActionable` so the caller can fall back
//! rather than silently report a hover that never happened.

use std::sync::Arc;

use serde_json::{json, Value};

use super::cua_mcp::{tools, McpClient, McpError, SnapshotCache, SnapshotEntry};
use super::{Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef};
use crate::computer::{Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Rect};

/// Independent ceiling on the markdown tree handed to the model. cua-driver's
/// own default is 250; a mid-size real window needs more, and its walk is
/// already bounded by `timeout_ms`, so this only guards context size.
const MAX_MARKDOWN_CHARS: usize = 120_000;
/// Wall clock for one tree walk. Windows with ~500 nodes need more than the
/// driver's 1000 ms default; without this the walk reports `degraded` and
/// returns an empty tree.
const WALK_TIMEOUT_MS: u64 = 20_000;

/// How many nodes to ask the driver for.
///
/// This is deliberately larger than `MAX_NODES`: the driver truncates the
/// walk at its budget, and the truncation cuts the *tail* of the tree -- which
/// on a long window is where the composer and the action buttons live. A
/// window read at the driver's smaller budget can therefore omit the very
/// control the caller is about to use, while the model still only ever sees
/// the first `MAX_NODES` nodes.
///
/// Measured on a Chromium chat window with a long thread: its tree is 432
/// nodes, and a budget of 500 stopped the walk inside the message list with
/// the input box absent, while 800 returned the whole tree. 900 leaves
/// headroom for a longer thread without reading much more than the window
/// actually contains.
const DRIVER_WALK_NODES: u64 = 900;

/// The driver's own ceiling for one `scroll` call (`amount` is a 1..=50 tick
/// count, and anything above 50 is silently clamped by the driver).
const SCROLL_MAX_AMOUNT: i64 = 50;

pub struct CuaDesktop {
    client: Arc<McpClient>,
    snapshots: Arc<SnapshotCache>,
    /// The value the target held before the write that is being performed.
    ///
    /// A write is confirmed by what the field holds afterwards, and the field
    /// may well have held the same text already: `type_text` types at the
    /// caret, so a field that already ends with the requested text looks the
    /// same before and after. The value from before the write is what tells
    /// the two apart.
    baseline: Arc<std::sync::Mutex<Option<(i32, u64, usize, String)>>>,
    /// Whether this connection has enumerated the desktop's windows.
    ///
    /// The enumeration is what makes the driver's own chord diagnostics lie,
    /// so the bridge has to know it happened to read them correctly.
    /// See `ACCELERATOR_SCAN_TIMEOUT`.
    enumerated: Arc<std::sync::atomic::AtomicBool>,
}

/// The driver's error code for "this surface drops posted input; retry with
/// delivery_mode foreground". Matched on the refusal code the driver embeds in
/// its message, since that is the only structured part this client keeps.
const BACKGROUND_UNAVAILABLE: &str = "background_unavailable";
/// The driver's wording for an accessibility scan that ran out of time.
///
/// The driver refuses a chord on a target whose accessibility tree exposes no
/// accelerator for it, and it reports that two ways. One is settled: "could
/// not find a UIA AcceleratorKey ... matching ctrl+s". The other is a scan
/// that ran out of time -- "UIA accelerator scan exceeded 4000ms; a UIA
/// provider in the target app is likely unresponsive".
///
/// Measured on a live target, the second wording is not a timeout at all. It
/// is what the driver answers once the connection has enumerated the
/// desktop's windows: a fresh driver process answers the settled wording in
/// ~50ms, and the same chord after one `list_windows` answers with the
/// timeout wording in ~4ms. A scan that exceeded 4000ms cannot answer in
/// 4ms. The contamination is sticky -- no other call clears it -- and it
/// spares the actions that work: on every target whose chord actually
/// lands, the chord still lands after an enumeration. What it changes is the
/// wording of a refusal that was already a refusal, and the wording it
/// replaces is the one that carries the driver's advice:
///
///   "Common cause: the action is nested behind a closed menu ... use an
///    exposed accelerator or `click` the matching element directly."
///
/// The timeout wording carries no such advice, so the bridge restores the
/// settled wording -- advice included -- rather than passing on a message
/// that names a cause that did not happen.
const ACCELERATOR_SCAN_TIMEOUT: &str = "accelerator scan exceeded";

/// The driver's refusal for an action on a minimized window.
///
/// The driver resolves the element to the Win32 iconic sentinel coordinates
/// off the edge of every display, so the action would be posted where no
/// window is and would silently do nothing. Its refusal names
/// `bring_to_front` as the way out.
///
/// Measured on a live target: with the window minimized, a click on a menu
/// item is refused with this wording and nothing else happens -- the window
/// stays minimized and the action never lands. Without a way to restore the
/// window, a minimized target is a dead end, and the advice the model can act
/// on is a refusal it cannot fix.
const WINDOW_MINIMIZED: &str = "window_minimized";

/// The driver's refusal for an expand on an element that cannot be expanded.
///
/// Measured on a live target: a tree item refuses with "ExpandCollapsePattern
/// unavailable", while a menu bar item expands. The wording is what tells the
/// two apart, and it is the difference between a menu that opens and an
/// ordinary button that is clicked.
const EXPAND_UNAVAILABLE: &str = "ExpandCollapsePattern unavailable";

/// The settled wording the driver uses when a target exposes no accelerator
/// for a chord, and the advice it attaches.
///
/// This is the diagnostic the timeout wording stands in for, so restoring it
/// restores the advice with it. The wording is written to hold on any
/// target: the scan count is left out because the bridge does not know it,
/// and the rest of the sentence is the part that guides the caller.
const SETTLED_ACCELERATOR_REFUSAL: &str =
    "the target exposes no accelerator for this chord, and its accessibility provider did not \
     answer in time. Common cause: the action is nested behind a closed menu (e.g. modern \
     Notepad's Save under the File menu) -- its element isn't in the visible subtree until the \
     menu is opened. Call `get_window_state` to inspect the available UIA actions, then use an \
     exposed accelerator or `click` the matching element directly.";

/// Whether a field that now holds `actual` received `expected`.
///
/// `set_value` replaces the field, so the field must hold exactly what was
/// written. `type_text` types characters into the focused control, so the
/// field ends with what was written -- unless the control dropped some of
/// it, which is exactly what a `false` verdict has to report.
fn write_confirmed(actual: &str, expected: &str, baseline: Option<&str>) -> bool {
    // An empty write is not a confirmed write. Every string ends with the
    // empty string, so the suffix test would otherwise report a write of
    // nothing as a write that landed.
    if expected.is_empty() {
        return false;
    }
    // A text field normalises the line endings of what it is given.
    // Measured on a Windows text field: "\n" came back as "\r", "\r\n" as
    // "\r", and "a\r\nb" as "a\rb". That is the platform's own line-ending
    // convention, not a lost character, so both sides are normalised before
    // they are compared -- otherwise every write that contained a line
    // ending would be reported as a write that did not land.
    // The field's line endings are the platform's, so the field is compared
    // in the platform's convention: a "\n" that came back as "\r" is the
    // same line ending, and the trailing one the field adds on top of the
    // text is not part of the text.
    //
    // The expected side is the text as it was written, so its line endings
    // are read the same way -- otherwise a write of "hello" would be compared
    // against a field that holds "hello\r" and reported as a lost write.
    let as_field = |text: &str| text.replace("\r\n", "\r").replace('\n', "\r");
    let actual = as_field(actual);
    let actual = actual.strip_suffix('\r').unwrap_or(&actual);
    let expected = as_field(expected);
    let expected = expected.strip_suffix('\r').unwrap_or(&expected);
    if actual == expected {
        return true;
    }
    // A typed write puts the text at the caret, so the field ends with it. That
    // is only proof of THIS write when the field did not already end with it:
    // a field that already held the text looks the same before and after a
    // write that was dropped.
    //
    // The value from before the write is what tells the two apart. Without
    // it the best that can be said is "the field ends with the text", which
    // is not the same thing as "the text was just typed".
    if let Some(before) = baseline {
        let before = as_field(before);
        let before = before.strip_suffix('\r').unwrap_or(&before);
        if before.ends_with(&expected) {
            return false;
        }
    }
    actual.ends_with(&expected)
}

/// How many times a written field is read back before the write is called
/// unconfirmed.
///
/// The write and the tree are not in step: a keystroke reaches the
/// application through the input queue and the accessibility tree catches up
/// a moment later. Measured on a Chromium composer, the first read after the
/// write still showed the old text.
const WRITE_CONFIRM_ATTEMPTS: u32 = 4;
/// The pause between two read-back attempts.
const WRITE_CONFIRM_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

/// Whether the driver's refusal names the foreground escalation.
///
/// The driver refuses background keystrokes on a surface whose input stack
/// drops posted events -- a Chromium composer is exactly that -- and it says
/// so with a structured `background_unavailable` code. That refusal is not a
/// transient failure: re-issuing the same action unchanged fails the same
/// way, so the retry has to carry `delivery_mode: "foreground"`.
///
/// Every other refusal propagates. The bridge only overrides the driver's own
/// default when the driver asked for it in its error.
fn escalates_to_foreground(message: &str) -> bool {
    message.contains(BACKGROUND_UNAVAILABLE)
}

/// Whether a chord refusal is worth another attempt.
///
/// The driver's timeout wording is only a timeout when it is one. Measured on
/// a live target, the same chord on the same window answers with the settled
/// wording ("could not find a UIA AcceleratorKey") in a fresh driver process
/// and with the timeout wording ("accelerator scan exceeded 4000ms") after the
/// connection has enumerated the desktop's windows -- in ~4ms, which no
/// 4000ms scan can do. The enumeration is what turns the diagnostic into a
/// lie, and the lie is sticky: no later call clears it.
///
/// So a timeout wording only leaves the question open on a connection that
/// has not enumerated yet. After an enumeration it is a settled refusal
/// wearing the wrong words, and retrying it cannot succeed -- it would spend
/// the action's budget to arrive at the same refusal.
fn chord_retry_is_worth_it(message: &str, enumerated: bool) -> bool {
    if !message.contains(ACCELERATOR_SCAN_TIMEOUT) {
        return false;
    }
    !enumerated
}

/// The refusal to report for a chord the driver refused with the timeout
/// wording on a connection that has already enumerated.
///
/// The timeout wording names a cause that did not happen and carries no
/// advice. The settled wording it stands in for names the real cause and
/// says what to do about it, so that is what the caller is told. The advice
/// is the part that matters: on a modern Notepad the chord is refused
/// because the action sits behind a closed menu, and the way through is to
/// open the menu and click the item.
fn chord_refusal_message(message: &str, enumerated: bool) -> String {
    if chord_retry_is_worth_it(message, enumerated) {
        return message.to_string();
    }
    if !message.contains(ACCELERATOR_SCAN_TIMEOUT) {
        return message.to_string();
    }
    format!(
        "{message} The settled answer for this target is that it exposes no accelerator for \
              the chord. {SETTLED_ACCELERATOR_REFUSAL}"
    )
}

/// Whether a refusal is the driver's answer to an action on a minimized
/// window.
fn window_is_minimized(message: &str) -> bool {
    message.contains(WINDOW_MINIMIZED)
}

/// Translate one chord token into the driver's Windows vocabulary.
///
/// The model writes chords in the macOS idiom — the prompt's own example is
/// `["cmd+a", "delete"]` — while the driver on Windows recognises only
/// ctrl/control, shift, alt, win. Measured on a live target: the driver accepts
/// `cmd` without complaint and then sends a bare `a`, so an unmapped token is a
/// silently wrong keystroke rather than an error to fall back from.
///
/// Anything outside the mapped set is passed through unchanged, because the
/// driver's own vocabulary (return, tab, escape, up, pageup, f1..f12, letters,
/// digits) is already what the model is told to write.
fn normalise_key(token: &str) -> &str {
    let lowered = token.to_ascii_lowercase();
    match lowered.as_str() {
        // macOS spellings that mean Control on Windows.
        "cmd" | "command" | "meta" | "super" => "ctrl",
        "control" => "ctrl",
        "option" => "alt",
        "windows" => "win",
        "esc" => "escape",
        "del" => "delete",
        "enter" => "return",
        "ctrl" => "ctrl",
        "shift" => "shift",
        "alt" => "alt",
        "win" => "win",
        "backspace" => "backspace",
        _ => token,
    }
}

/// What a read of a combo box said about the option it displays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComboReading {
    /// The control shows the requested option.
    Shows,
    /// The control exposes a value, and it is a different one.
    Differs,
    /// The control exposes no value at all, so the tree cannot answer.
    Unreadable,
}

impl CuaDesktop {
    /// Spawn the driver and handshake. `Err` means fall back to the native
    /// backend; the caller decides, this type does not retry.
    pub fn new() -> Result<Self, McpError> {
        Ok(Self {
            client: McpClient::spawn()?,
            snapshots: Arc::new(SnapshotCache::new()),
            baseline: Arc::new(std::sync::Mutex::new(None)),
            enumerated: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }

    /// Construct from an already-running client. Used by tests so one driver
    /// process can serve several assertions.
    pub fn with_client(client: Arc<McpClient>) -> Self {
        Self {
            client,
            snapshots: Arc::new(SnapshotCache::new()),
            baseline: Arc::new(std::sync::Mutex::new(None)),
            enumerated: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn client(&self) -> &Arc<McpClient> {
        &self.client
    }

    fn list_windows_raw(&self) -> Result<Vec<RawTarget>, DesktopError> {
        let result = self
            .client
            .call_tool(tools::LIST_WINDOWS, json!({}))
            .map_err(map_err)?;
        // Enumerating the desktop is what puts the driver into the state where
        // its chord diagnostics turn into the timeout wording. The bridge has
        // to remember that it did this, because that is the only way to tell
        // the two wordings apart afterwards.
        self.enumerated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // The driver returns both `windows` and the legacy alias
        // `_legacy_windows`; the structured array is authoritative.
        let windows = result
            .field("windows")
            .as_array()
            .cloned()
            .or_else(|| result.field("_legacy_windows").as_array().cloned())
            .unwrap_or_default();

        let mut out = Vec::with_capacity(windows.len());
        for w in windows {
            let Some(target) = raw_target_from_window(&w) else {
                continue;
            };
            out.push(target);
        }
        Ok(out)
    }

    /// Walk one window and translate the markdown tree into `Node`s.
    ///
    /// The tree is read in the structured `elements` form rather than as
    /// markdown. A markdown row prints a value verbatim, and a value holding a
    /// newline breaks the row in half, so the quoted label of that row never
    /// closes and the row is dropped. A Chromium chat composer holds exactly
    /// such a value -- its placeholder ends in a newline -- so on markdown the
    /// composer was simply not in the tree.
    fn inspect_window(
        &self,
        target: &TargetRef,
        max_nodes: usize,
    ) -> Result<(RawInspection, SnapshotEntry), DesktopError> {
        let args = json!({
            "pid": target.pid,
            "window_id": target.window,
            "max_elements": clamp_walk_elements(max_nodes),
            "timeout_ms": WALK_TIMEOUT_MS,
            "tree_format": "elements"
        });
        let result = self
            .client
            .call_tool(tools::GET_WINDOW_STATE, args)
            .map_err(map_err)?;

        let snapshot_id = result
            .field("snapshot_id")
            .as_str()
            .unwrap_or_default()
            .to_string();
        if snapshot_id.is_empty() {
            return Err(DesktopError::Failed(
                "cua-driver returned no snapshot_id; element tokens cannot be minted".into(),
            ));
        }

        let complete = result.field("elements_complete").as_bool().unwrap_or(false);
        let element_count = result.field("element_count").as_u64().unwrap_or(0) as usize;

        let elements = result.field("elements");
        let walked = elements.as_array().map(|list| list.len()).unwrap_or(0);
        let (nodes, rows, roles) = parse_elements_tree(&elements, &snapshot_id);
        let values = element_values(&elements, &snapshot_id);
        let entry = SnapshotEntry {
            snapshot_id: snapshot_id.clone(),
            rows,
            markdown: String::new(),
            truncated: !complete,
            element_count,
            values,
            roles,
        };

        // The structured tree is bounded by the node budget instead of by a
        // character count, so the cut is decided by the node count alone.
        let truncated = !complete;

        Ok((
            RawInspection {
                total_nodes: walked,
                nodes,
                truncated,
                // cua-driver reports `elements_complete`, so a complete walk is
                // full fidelity for this driver — but the model still only sees
                // what markdown rendered, hence `Partial` when anything was cut.
                fidelity: if truncated {
                    Fidelity::Partial
                } else {
                    Fidelity::Full
                },
            },
            entry,
        ))
    }

    /// Whether the combo box reads back as showing `option`.
    ///
    /// Three answers, because a WPF combo box exposes no `value=` at all: a
    /// plain bool would report every such control as "the write did not take"
    /// and push the caller down a popup path that cannot work either.
    /// `Unreadable` is the honest third state — the tree simply does not say.
    fn combo_reads_back(
        &self,
        target: &TargetRef,
        token: &str,
        option: &str,
    ) -> Result<ComboReading, DesktopError> {
        let result = self
            .client
            .call_tool(
                tools::GET_WINDOW_STATE,
                json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "max_elements": DRIVER_WALK_NODES,
                    "timeout_ms": WALK_TIMEOUT_MS
                }),
            )
            .map_err(map_err)?;
        let markdown = result
            .field("tree_markdown")
            .as_str()
            .unwrap_or_default()
            .to_string();
        // The row for `token` renders as `- [N] ComboBox "..." [value="..."]`.
        let row = token.rsplit(':').next().unwrap_or_default();
        let needle = format!("[{row}] ComboBox");
        let Some(line) = markdown.lines().find(|line| line.contains(&needle)) else {
            return Ok(ComboReading::Unreadable);
        };
        if line.contains(&format!("value=\"{option}\"")) {
            return Ok(ComboReading::Shows);
        }
        if line.contains("[value=") {
            return Ok(ComboReading::Differs);
        }
        Ok(ComboReading::Unreadable)
    }

    /// Click the option row whose label matches, when the driver already lists
    /// it as a child of the combo box.
    ///
    /// WPF is the case this exists for: the rows are in the tree the whole
    /// time, `set_value` is unsupported, and `expand` is refused. Picking the
    /// row by its rendered label is the only thing left, and it is exactly what
    /// a person does.
    ///
    /// The driver's `click` is used, not its `select`: on a row the driver
    /// routes `click` through UIA's SelectionItem.Select and it works, while its
    /// own `select` tool answers `permission_denied` on the same row. Measured
    /// on a WPF combo box, both statements reproduced.
    fn click_option_row(&self, target: &TargetRef, option: &str) -> Result<bool, DesktopError> {
        let result = self
            .client
            .call_tool(
                tools::GET_WINDOW_STATE,
                json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "max_elements": DRIVER_WALK_NODES,
                    "timeout_ms": WALK_TIMEOUT_MS
                }),
            )
            .map_err(map_err)?;
        let markdown = result
            .field("tree_markdown")
            .as_str()
            .unwrap_or_default()
            .to_string();
        let capture = result
            .field("snapshot_id")
            .as_str()
            .unwrap_or_default()
            .to_string();
        let quoted = format!("ListItem \"{option}\"");
        let Some(line) = markdown.lines().find(|line| line.contains(&quoted)) else {
            return Ok(false);
        };
        let Some(row) = split_row_prefix(line.trim_start_matches(['-', ' ']).trim_end()) else {
            return Ok(false);
        };
        let token = format!("{capture}:{}", row.0);
        self.client
            .call_tool(
                tools::CLICK,
                json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "element_token": token
                }),
            )
            .map_err(map_err)?;
        Ok(true)
    }

    /// Send one key or chord, escalating to foreground input when the driver
    /// says the background route is unavailable.
    ///
    /// The driver refuses background keystrokes on surfaces whose input stack
    /// drops posted events (WPF, Chromium/Electron content) with a structured
    /// `background_unavailable` refusal that names the escalation. It is not a
    /// transient failure, so retrying unchanged only fails again — the retry has
    /// to carry `delivery_mode: "foreground"`.
    ///
    /// This is the one place the bridge overrides the driver's own default, and
    /// the driver asked for it in its error. Every other failure propagates.
    ///
    /// A scan that ran out of time is the one failure worth another attempt.
    /// The driver refuses a chord on a target whose accessibility tree exposes
    /// no accelerator for it, and it reports that either as a settled answer
    /// ("could not find a UIA AcceleratorKey") or as a scan that timed out
    /// ("accelerator scan exceeded 4000ms; a UIA provider in the target app is
    /// likely unresponsive"). The first is final. The second, on a connection
    /// that has not enumerated yet, names a cause that can pass, so the chord
    /// gets one more try.
    ///
    /// One retry, not more. A target that genuinely exposes no accelerator
    /// answers with the settled wording every time, so repeating past that
    /// would only spend the action's time.
    ///
    /// After the connection has enumerated the desktop's windows the timeout
    /// wording stops being a timeout: it is the settled refusal wearing the
    /// wrong words, and the words it replaces are the ones carrying the
    /// driver's advice. So the bridge restores that advice rather than
    /// retrying a refusal that cannot change.
    fn press_with_escalation(
        &self,
        tool: &str,
        mut args: Value,
        target: &TargetRef,
    ) -> Result<(), DesktopError> {
        match self.client.call_tool(tool, args.clone()) {
            Ok(_) => Ok(()),
            Err(McpError::Protocol(message)) if escalates_to_foreground(&message) => {
                args["delivery_mode"] = json!("foreground");
                self.client.call_tool(tool, args).map_err(map_err)?;
                Ok(())
            }
            Err(McpError::Protocol(message)) if window_is_minimized(&message) => {
                // The action was addressed to a window that was not on screen,
                // so the action itself was never wrong. Restore the window and
                // try it again unchanged.
                tracing::info!(
                    target: "computer",
                    tool,
                    "the target window is minimized; restoring it and trying again"
                );
                self.restore_window(target)?;
                self.client.call_tool(tool, args).map_err(map_err)?;
                Ok(())
            }
            Err(McpError::Protocol(message))
                if tool == tools::HOTKEY
                    && chord_retry_is_worth_it(&message, self.has_enumerated()) =>
            {
                tracing::info!(
                    target: "computer",
                    tool,
                    "the accessibility scan timed out; retrying the chord once",
                );
                self.client.call_tool(tool, args).map_err(map_err)?;
                Ok(())
            }
            Err(McpError::Protocol(message)) => {
                // The chord advice only belongs to a chord: a refused write
                // says nothing about accelerators.
                let message = if tool == tools::HOTKEY {
                    chord_refusal_message(&message, self.has_enumerated())
                } else {
                    message
                };
                Err(DesktopError::Failed(message))
            }
            Err(error) => Err(map_err(error)),
        }
    }

    /// Whether this connection has enumerated the desktop's windows.
    fn has_enumerated(&self) -> bool {
        self.enumerated.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Whether a click on this element should open a menu on the way.
    ///
    /// Only a menu item does. A tree item can expand too, and a combo box
    /// can, and both of them expand for a different reason: a tree item that
    /// is expanded has not been clicked, and the caller asked for a click.
    /// Expanding one of those instead of clicking it would report success
    /// for an action that did not happen.
    ///
    /// Measured on a live Notepad: the menu bar item is a `menu-item` with
    /// `actions=["invoke","expand"]`, and expanding it puts the commands
    /// under it into the tree. The commands themselves are `menu-item`s too,
    /// so the role alone does not say which of the two a click is aimed at --
    /// but a command that is already visible does not need opening, and the
    /// expand of a visible command is refused by the driver, so the role
    /// check is enough to keep the plain click for it.
    fn opens_a_menu(&self, target: &TargetRef, uid: Option<&str>) -> bool {
        let Some(uid) = uid else { return false };
        let Some(entry) = self.snapshots.get(target.pid, target.window) else {
            return false;
        };
        matches!(
            entry.roles.get(uid).map(String::as_str),
            Some("menu-item") | Some("menu-bar")
        )
    }

    /// Click an element, opening a menu on the way if it is one.
    ///
    /// A menu bar item holds no command of its own: the commands live in the
    /// menu that opens under it, and they are not in the tree until it is
    /// open. Measured on a live Notepad: before, the tree holds "File" and
    /// no "Save"; after the item is expanded, the tree holds "Save", "Save
    /// As", "Save All" and the rest, and 29 elements become 56.
    ///
    /// So a click on a menu bar item is not the end of the road. The driver
    /// refuses the expand on an element that cannot be expanded
    /// ("ExpandCollapsePattern unavailable"), so the expand is attempted and
    /// the plain click is the fallback -- the fallback is what an ordinary
    /// button gets, and it is what a menu bar item gets on a target whose
    /// menu does not open that way.
    ///
    /// The expand is not a substitute for the click: a menu bar item that is
    /// expanded is still a menu bar item, and the command under it is a
    /// separate element that the caller clicks next.
    fn click_opening_a_menu(
        &self,
        target: &TargetRef,
        tool: &str,
        args: &Value,
    ) -> Result<(), DesktopError> {
        self.click_opening_a_menu_once(target, tool, args, true)
    }

    /// The click itself, with the number of times the window may be restored
    /// still left.
    ///
    /// The restore is bounded because the window can refuse to come back: a
    /// window that stays minimized would otherwise turn one click into an
    /// endless loop of restores.
    fn click_opening_a_menu_once(
        &self,
        target: &TargetRef,
        tool: &str,
        args: &Value,
        may_restore: bool,
    ) -> Result<(), DesktopError> {
        let mut expand_args = args.clone();
        expand_args["action"] = json!("expand");
        match self.client.call_tool(tool, expand_args.clone()) {
            Ok(_) => {
                tracing::info!(
                    target: "computer",
                    tool,
                    "expanded a menu bar item so the items under it become reachable"
                );
                // The item is open now, so the menu is on screen. The click
                // that opened it is what the driver would have done anyway.
                Ok(())
            }
            Err(error) => {
                if Self::expand_failed(&error) {
                    // The element cannot be expanded, so it is not a menu.
                    // The click itself is still worth making.
                    return self.call_with_window_restore(tool, args.clone(), target);
                }
                if may_restore && Self::refusal_is_minimized(&error) {
                    // The expand was refused because the window is off
                    // screen, not because the element is the wrong one. So the
                    // window is restored and the whole thing is tried again:
                    // the element may well be a menu bar item after all.
                    tracing::info!(
                        target: "computer",
                        tool,
                        "the target window is minimized; restoring it and trying again"
                    );
                    self.restore_window(target)?;
                    return self.click_opening_a_menu_once(target, tool, args, false);
                }
                Err(map_err(error))
            }
        }
    }

    /// Whether a refusal is the driver's answer to an action on a minimized
    /// window.
    fn refusal_is_minimized(error: &McpError) -> bool {
        match error {
            McpError::Protocol(message) => window_is_minimized(message),
            McpError::Rpc { message, .. } => window_is_minimized(message),
            _ => false,
        }
    }

    /// Whether a refusal is the driver's answer to an expand on an element
    /// that cannot be expanded.
    fn expand_failed(error: &McpError) -> bool {
        match error {
            McpError::Protocol(message) => message.contains(EXPAND_UNAVAILABLE),
            McpError::Rpc { message, .. } => message.contains(EXPAND_UNAVAILABLE),
            _ => false,
        }
    }

    /// Restore a window that the driver refuses to act on because it is
    /// minimized.
    ///
    /// The driver's refusal names `bring_to_front` as the way out, and the
    /// bridge has to be the one that takes it: the model cannot call a driver
    /// tool, and the refusal it sees is not something it can resolve on its
    /// own. Measured on a live target, `bring_to_front` reports the window as
    /// foreground and the very next action lands.
    fn restore_window(&self, target: &TargetRef) -> Result<(), DesktopError> {
        self.client
            .call_tool(
                tools::BRING_TO_FRONT,
                json!({ "pid": target.pid, "window_id": target.window }),
            )
            .map_err(map_err)?;
        Ok(())
    }

    /// Call a driver tool, and if the driver refuses because the target
    /// window is minimized, restore the window and try the same action once
    /// more.
    ///
    /// The retry carries the action unchanged, because the action was never
    /// wrong: it was addressed to a window that was not on screen. The
    /// driver's own refusal says so.
    fn call_with_window_restore(
        &self,
        tool: &str,
        args: Value,
        target: &TargetRef,
    ) -> Result<(), DesktopError> {
        match self.client.call_tool(tool, args.clone()) {
            Ok(_) => Ok(()),
            Err(McpError::Protocol(message)) if window_is_minimized(&message) => {
                tracing::info!(
                    target: "computer",
                    tool,
                    "the target window is minimized; restoring it and trying again"
                );
                self.restore_window(target)?;
                self.client.call_tool(tool, args).map_err(map_err)?;
                Ok(())
            }
            Err(error) => Err(map_err(error)),
        }
    }
    /// Open a combo box and click the option row, entirely inside one driver
    /// session.
    ///
    /// A `capture_id` and an element token are both scoped to one connection,
    /// and the option rows only exist while the popup is open — so this cannot
    /// be expressed as several tool calls from here. The script does the whole
    /// look-then-act loop the driver offers for exactly this case.
    fn select_via_popup(
        &self,
        target: &TargetRef,
        token: &str,
        option: &str,
    ) -> Result<(), DesktopError> {
        // The option travels as a JS string literal, so it is JSON-encoded once
        // and used verbatim; JSON string escaping is a subset of JS's.
        let option_literal = serde_json::to_string(option)
            .map_err(|e| DesktopError::Failed(format!("option did not encode: {e}")))?;
        let token_literal = serde_json::to_string(token)
            .map_err(|e| DesktopError::Failed(format!("token did not encode: {e}")))?;
        let script = popup_script(target.pid, target.window, &token_literal, &option_literal);
        self.client
            .call_tool(
                tools::RUN_SCRIPT,
                json!({ "script": script, "timeout_ms": 60_000 }),
            )
            .map_err(map_err)?;
        Ok(())
    }

    fn element_token(&self, target: &TargetRef, uid: Option<&str>) -> Result<String, DesktopError> {
        let uid = uid.ok_or(DesktopError::NotActionable)?;
        // A uid minted by an earlier read is refused by the driver, and it would
        // silently address a different row here, so check the cache first.
        let cached = self.snapshots.get(target.pid, target.window);
        match cached {
            Some(entry) if entry.rows.contains_key(uid) => Ok(uid.to_string()),
            Some(_) => Err(DesktopError::ElementNotFound),
            None => Err(DesktopError::ElementNotFound),
        }
    }
    /// Read the value the target holds, so a write can be told apart from a
    /// field that already held the same text.
    ///
    /// A write is confirmed by what the field holds afterwards. That is not
    /// enough on its own: `type_text` types at the caret, so a field that
    /// already ended with the requested text looks the same before and after
    /// the write, and a suffix check would report a dropped write as a landed
    /// one. The value from before the write is what tells them apart.
    fn take_baseline(&self, target: &TargetRef, token: &str) {
        let Some(row) = token
            .rsplit(':')
            .next()
            .and_then(|row| row.parse::<usize>().ok())
        else {
            return;
        };
        // The value comes from the snapshot the caller already holds. Reading
        // the tree again would replace that snapshot and stale the handle the
        // write is about to use.
        let before = self
            .snapshots
            .get(target.pid, target.window)
            .and_then(|entry| entry.values.get(token).cloned());
        if let Ok(mut slot) = self.baseline.lock() {
            *slot = before.map(|value| (target.pid, target.window, row, value));
        }
    }

    /// The value one row currently holds, read from the driver's tree.
    fn read_value(&self, target: &TargetRef, row: usize) -> Option<String> {
        let result = self
            .client
            .call_tool(
                tools::GET_WINDOW_STATE,
                json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "max_elements": DRIVER_WALK_NODES,
                    "timeout_ms": WALK_TIMEOUT_MS,
                    "tree_format": "elements"
                }),
            )
            .ok()?;
        let elements = result.field("elements");
        let items = elements.as_array()?;
        let element = items.iter().find(|item| {
            item.get("element_index")
                .and_then(Value::as_u64)
                .map(|index| index as usize == row)
                .unwrap_or(false)
        })?;
        element
            .get("value")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// One read-back of the written row, or `None` while the tree has not
    /// caught up with the write yet.
    fn read_back_write(
        &self,
        target: &TargetRef,
        row: usize,
        expected: &str,
        baseline: Option<&str>,
    ) -> Option<bool> {
        let result = self
            .client
            .call_tool(
                tools::GET_WINDOW_STATE,
                json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "max_elements": DRIVER_WALK_NODES,
                    "timeout_ms": WALK_TIMEOUT_MS,
                    "tree_format": "elements"
                }),
            )
            .ok()?;
        let elements = result.field("elements");
        let items = match elements.as_array() {
            Some(items) => items,
            None => {
                tracing::info!(target: "computer", row, "confirm_write: the driver returned no elements array");
                return None;
            }
        };
        let element = match items.iter().find(|item| {
            item.get("element_index")
                .and_then(Value::as_u64)
                .map(|index| index as usize == row)
                .unwrap_or(false)
        }) {
            Some(element) => element,
            None => {
                tracing::info!(target: "computer", row, "confirm_write: the row is not in the elements array");
                return None;
            }
        };
        let value = match element.get("value").and_then(Value::as_str) {
            Some(value) => value,
            None => {
                tracing::info!(target: "computer", row, "confirm_write: the row carries no value");
                return None;
            }
        };
        Some(write_confirmed(value, expected, baseline))
    }
}

fn clamp_walk_elements(max_nodes: usize) -> u64 {
    // The driver caps at 5000; below that, honour the caller. The walk is
    // always given at least `DRIVER_WALK_NODES` so that a truncated walk
    // cannot silently drop the controls at the tail of the tree.
    (max_nodes.max(50) as u64).max(DRIVER_WALK_NODES).min(5000)
}

fn map_err(error: McpError) -> DesktopError {
    match error {
        McpError::NotInstalled => DesktopError::Unsupported,
        McpError::Timeout(_) => DesktopError::Timeout,
        McpError::Spawn(message) | McpError::Protocol(message) => DesktopError::Failed(message),
        McpError::Rpc { message, .. } => {
            let lowered = message.to_ascii_lowercase();
            if lowered.contains("stale_element_token") {
                DesktopError::ElementNotFound
            } else if lowered.contains("not_found") || lowered.contains("not found") {
                DesktopError::ElementNotFound
            } else if lowered.contains("timeout") {
                DesktopError::Timeout
            } else {
                DesktopError::Failed(message)
            }
        }
    }
}

fn raw_target_from_window(window: &Value) -> Option<RawTarget> {
    let pid = window.get("pid").and_then(Value::as_i64)? as i32;
    if pid == 0 {
        return None;
    }
    let window_id = window.get("window_id").and_then(Value::as_u64)?;
    if window_id == 0 {
        return None;
    }
    let title = window
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // The driver reports the process image name, e.g. `notepad.exe`, which is
    // exactly what `TargetRef::app_key` carries on Windows.
    let app_name = window
        .get("app_name")
        .and_then(Value::as_str)
        .or_else(|| window.get("process_name").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string();
    // The driver nests geometry under `bounds`; older payloads flattened it, so
    // accept both rather than silently reporting a 0x0 window.
    let geometry = window.get("bounds").unwrap_or(window);
    let number = |key: &str| -> f64 {
        geometry
            .get(key)
            .and_then(Value::as_f64)
            .or_else(|| window.get(key).and_then(Value::as_f64))
            .unwrap_or(0.0)
    };
    let bounds = Rect {
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
    };
    Some(RawTarget {
        target: TargetRef {
            // Same three-part shape the native backend mints, so a stored grant
            // stays resolvable if the backend is swapped between calls.
            target_id: format!("{}:{}:{}", pid, window_id, app_name),
            pid,
            window: window_id,
            app_key: app_name.clone(),
        },
        app_name,
        title,
        bounds,
        // The driver hides elevated targets from its own walk rather than
        // flagging them; a window it lists is one it can reach.
        elevated: false,
    })
}

/// The value every row held at the time of the read, keyed by uid.
///
/// A write is confirmed by what the field holds afterwards, and a field may
/// well have held the same text already -- `type_text` types at the caret, so
/// a field that already ends with the requested text looks the same before
/// and after the write. The value from before the write is what tells the two
/// apart.
fn element_values(
    elements: &Value,
    snapshot_id: &str,
) -> std::collections::HashMap<String, String> {
    let mut values = std::collections::HashMap::new();
    let Some(items) = elements.as_array() else {
        return values;
    };
    for item in items {
        let Some(row) = item.get("element_index").and_then(Value::as_u64) else {
            continue;
        };
        let Some(value) = item.get("value").and_then(Value::as_str) else {
            continue;
        };
        values.insert(format!("{snapshot_id}:{row}"), value.to_string());
    }
    values
}

/// Parse the driver's structured tree into `Node`s.
///
/// The driver can return the tree as markdown or as a structured `elements`
/// array. The structured form is preferred: a markdown row prints a value
/// verbatim, and a value that contains a newline breaks the row in half, so
/// the quoted label of that row no longer closes and the row is dropped
/// entirely. A Chromium chat composer holds exactly such a value (its
/// placeholder ends in a newline), so on markdown the composer was simply
/// absent from the tree.
///
/// The structured form carries the same fields the markdown rows carry --
/// role, label, value, actions -- plus the parent row and the element token,
/// so the translation is direct.
fn parse_elements_tree(
    elements: &Value,
    snapshot_id: &str,
) -> (
    Vec<Node>,
    std::collections::HashMap<String, usize>,
    std::collections::HashMap<String, String>,
) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut rows: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut roles: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let Some(items) = elements.as_array() else {
        return (nodes, rows, roles);
    };

    // The driver numbers its rows, and `element_index` is that number. The
    // node list is keyed by it, so a parent can be looked up directly.
    let mut by_row: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    // (parent row, role) -> how many same-role siblings have been seen, so
    // each node's `identity` can end in a stable ordinal.
    let mut siblings: std::collections::HashMap<(Option<usize>, String), usize> =
        std::collections::HashMap::new();

    for item in items {
        let Some(raw_role) = item.get("role").and_then(Value::as_str) else {
            continue;
        };
        let role = canonical_role(raw_role);
        if role.is_empty() {
            continue;
        }
        let Some(row) = item.get("element_index").and_then(Value::as_u64) else {
            continue;
        };
        let row = row as usize;
        let parent_row = item
            .get("parent_index")
            .and_then(Value::as_u64)
            .map(|value| value as usize);

        // The driver's `actions` list names the UIA patterns a row exposes.
        //
        // `text` on its own is NOT a write capability. Measured on a live
        // Chromium composer tree: a read-only message Text row reports
        // `actions=["text"]`, and the driver refuses `set_value` on it with
        // "does not implement ValuePattern". The real composer Edit reports
        // `actions=["set_value","text"]` and accepts the write. Mapping `text`
        // to a write action made every read-only label in the window look like
        // an input field, and moved the tree-budget anchor off the composer
        // onto a message row.
        //
        // A row that carries `set_value` *and* `text` is a real field: it can
        // take a value as a whole and it can be typed into character by
        // character, so both actions belong to it.
        let mut has_set_value = false;
        let mut has_text = false;
        let mut actions = match item.get("actions").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(|token| match token.trim().to_ascii_lowercase().as_str() {
                    "invoke" | "press" | "click" => Some(ActionKind::Click),
                    "set_value" | "setvalue" => {
                        has_set_value = true;
                        Some(ActionKind::SetValue)
                    }
                    "toggle" => Some(ActionKind::Click),
                    "select" | "selection" => Some(ActionKind::Select),
                    "expand" | "collapse" => Some(ActionKind::Click),
                    "scroll" | "scrollitem" => Some(ActionKind::Scroll),
                    "type_text" | "typetext" => Some(ActionKind::TypeText),
                    "text" => {
                        has_text = true;
                        None
                    }
                    _ => None,
                })
                .fold(Vec::new(), |mut out: Vec<ActionKind>, kind| {
                    if !out.contains(&kind) {
                        out.push(kind);
                    }
                    out
                }),
            None => Vec::new(),
        };
        if has_set_value && has_text && !actions.contains(&ActionKind::TypeText) {
            actions.push(ActionKind::TypeText);
        }
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(|label| unescape_markdown_label(label));

        // Whether the element holds a value the caller can write into.
        //
        // The driver's `value` field also carries the text of a read-only row
        // (a message body reports its own text as `value`), so keying on the
        // field alone marked every label in the window as a writable field.
        // `has_value` gates `set_value` in the answer validator, so it must
        // mean "this control takes a value" — which is what the driver says
        // by advertising `set_value`.
        let has_value = actions.contains(&ActionKind::SetValue);

        let parent = parent_row.and_then(|candidate| by_row.get(&candidate).copied());

        let ordinal = siblings
            .entry((parent_row, role.clone()))
            .and_modify(|count| *count += 1)
            .or_insert(0usize);
        let segment = format!("{role}#{ordinal}");
        let identity = match parent {
            Some(parent_index) => match nodes[parent_index].identity.as_deref() {
                Some(base) => format!("{base}/{segment}"),
                None => segment,
            },
            None => segment,
        };

        let index = nodes.len();
        nodes.push(Node {
            uid: format!("{snapshot_id}:{row}"),
            identity: Some(identity),
            role,
            label,
            has_value,
            enabled: item
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| actions.iter().any(|kind| is_dispatchable(*kind))),
            focused: item
                .get("focused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            bounds: None,
            parent,
            actions,
        });
        rows.insert(nodes[index].uid.clone(), row);
        roles.insert(nodes[index].uid.clone(), nodes[index].role.clone());
        by_row.insert(row, index);
    }

    (nodes, rows, roles)
}

/// Parse the driver's markdown tree into `Node`s.
///
/// Line shape (`- ` prefix optional, two spaces per depth):
/// ```text
/// - Window "CU WPF Target"
///   - [5] Button "WPF-BUTTON" [id=btnHead actions=[invoke]]
///     - Text "WPF-BUTTON"
///   - [6] Edit [value="typed" actions=[set_value,text,scroll]]
/// ```
/// Only lines carrying `[N]` become nodes; they are the ones with a token.
/// Untagged lines are container or static text rows and only contribute depth,
/// so the parent chain still points at the nearest node above them.
fn parse_markdown_tree(
    markdown: &str,
    snapshot_id: &str,
) -> (Vec<Node>, std::collections::HashMap<String, usize>) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut rows: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    // (indent depth, index into `nodes`) for the node stack, so `parent` can be
    // resolved without a second pass.
    let mut stack: Vec<(usize, usize)> = Vec::new();
    // (parent index, role) -> how many same-role siblings have been seen, so
    // each node's `identity` can end in a stable ordinal.
    let mut siblings: std::collections::HashMap<(Option<usize>, String), usize> =
        std::collections::HashMap::new();

    for raw_line in markdown.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let content = line.trim_start();
        if !content.starts_with('-') {
            continue;
        }
        let indent = (line.len() - content.len()) / 2;
        let content = content.trim_start_matches('-').trim_start();

        let Some((row, rest)) = split_row_prefix(content) else {
            continue;
        };

        let (raw_role, after_role) = take_token(rest);
        if raw_role.is_empty() {
            continue;
        }
        // The driver prints its own role words (`ComboBox`, `ListItem`); this
        // crate's vocabulary is the UIA control-type name (`combo-box`,
        // `list-item`). Policy and the answer validator both branch on the
        // latter, so the translation happens here once rather than at every
        // comparison downstream.
        let role = canonical_role(&raw_role);
        if role.is_empty() {
            continue;
        }

        let (label, after_label) = take_quoted(after_role);
        let actions = parse_actions(after_label);
        // A node holds a value when the tree says so (`[value=...]`) *or* when
        // it advertises the SetValue action. Chromium reports an empty text
        // field with no `value=` at all but still lists `set_value` in its
        // actions, so keying on the literal would make an empty field look
        // unwritable — which is exactly the state every field starts in.
        let has_value = after_label.contains("[value=") || actions.contains(&ActionKind::SetValue);
        let uid = format!("{snapshot_id}:{row}");

        while let Some((depth, _)) = stack.last() {
            if *depth >= indent {
                stack.pop();
            } else {
                break;
            }
        }
        let parent = stack.last().map(|(_, index)| *index);

        // Identity is a path of `role#ordinal` from the root, where `ordinal`
        // counts same-role siblings under the same parent. It excludes `row`
        // and `snapshot_id` on purpose: those are dispatch handles that the
        // driver re-mints on every read, so a path built from them could never
        // match across observations.
        //
        // The label is excluded too. A label that changed between observations
        // is normally the evidence that an action worked, so folding it in would
        // report "different element" exactly when the caller most needs "same
        // element, new state".
        let identity = {
            let ordinal = siblings
                .entry((parent, role.clone()))
                .and_modify(|count| *count += 1)
                .or_insert(0usize);
            let segment = format!("{role}#{ordinal}");
            match parent {
                Some(p) => match nodes[p].identity.as_deref() {
                    Some(base) => format!("{base}/{segment}"),
                    None => segment,
                },
                None => segment,
            }
        };

        let index = nodes.len();
        nodes.push(Node {
            uid: uid.clone(),
            identity: Some(identity),
            role,
            label,
            has_value,
            // The markdown omits `enabled`. A row is actionable only when it
            // advertises an action the driver can dispatch — `actions=[text]`
            // means "this row carries readable text", not "this row can be
            // operated". Treating that as enabled made every status label look
            // clickable, and the model spent steps on them.
            enabled: actions.iter().any(|kind| is_dispatchable(*kind)),
            focused: after_label.contains("[focused]"),
            bounds: None,
            parent,
            actions,
        });
        rows.insert(uid, row);
        stack.push((indent, index));
    }

    (nodes, rows)
}

/// Split `[N] rest` into the row number and the remainder.
fn split_row_prefix(content: &str) -> Option<(usize, &str)> {
    let start = content.find('[')?;
    if start != 0 {
        // A line like `Window "Title"` has no row prefix and is skipped earlier.
        return None;
    }
    let close = content.find(']')?;
    let number = content.get(1..close)?.trim();
    let row = number.parse::<usize>().ok()?;
    let rest = content.get(close + 1..).unwrap_or("").trim_start();
    Some((row, rest))
}

/// Take the leading control-type token, e.g. `Button` out of `Button "Ok" ...`.
/// Translate the driver's role word into this crate's control-type name.
///
/// The mapping matters beyond display: `answer.ts` asks whether a role is
/// "semantically selectable" and accepts only `combo-box` / `list` /
/// `list-item`, so a `ComboBox` that reached it unchanged would be refused
/// before the backend ever saw the request.
fn canonical_role(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    match lowered.as_str() {
        "combobox" | "combo-box" => "combo-box".into(),
        "listitem" | "list-item" => "list-item".into(),
        "list" => "list".into(),
        "edit" | "textfield" => "edit".into(),
        "button" => "button".into(),
        "checkbox" | "check-box" => "checkbox".into(),
        "radiobutton" | "radio-button" => "radio-button".into(),
        "menuitem" | "menu-item" => "menu-item".into(),
        "menubar" | "menu-bar" => "menu-bar".into(),
        "treeitem" | "tree-item" => "tree-item".into(),
        "tree" => "tree".into(),
        "tabitem" | "tab-item" => "tab-item".into(),
        "tab" => "tab".into(),
        "document" => "document".into(),
        "hyperlink" => "hyperlink".into(),
        "image" => "image".into(),
        "text" | "statictext" | "static-text" => "text".into(),
        "scrollbar" | "scroll-bar" => "scroll-bar".into(),
        "titlebar" | "title-bar" => "title-bar".into(),
        "toolbar" | "tool-bar" => "tool-bar".into(),
        "pane" | "group" | "custom" => "pane".into(),
        "window" => "window".into(),
        // An unmapped word keeps its original spelling rather than being
        // flattened to `pane`: an unknown role is information, and the model
        // reads it.
        _ => raw.trim().to_string(),
    }
}

fn take_token(input: &str) -> (String, &str) {
    let end = input
        .find(|c: char| c.is_whitespace() || c == '"' || c == '[')
        .unwrap_or(input.len());
    (input[..end].to_string(), input[end..].trim_start())
}

fn take_quoted(input: &str) -> (Option<String>, &str) {
    if !input.starts_with('"') {
        return (None, input);
    }
    let mut escaped = false;
    for (offset, ch) in input.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => {
                let inner = &input[1..offset];
                let label = unescape_markdown_label(inner);
                let rest = input.get(offset + 1..).unwrap_or("").trim_start();
                let label = if label.trim().is_empty() {
                    None
                } else {
                    Some(label)
                };
                return (label, rest);
            }
            _ => {}
        }
    }
    (None, input)
}

fn unescape_markdown_label(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
                continue;
            }
        }
        out.push(ch);
    }
    out
}

/// Map the driver's action words onto this crate's `ActionKind`.
/// Whether the action can actually be dispatched at a window element.
///
/// The judgement lives on `ActionKind` so the node budget and this backend
/// cannot drift apart: a node the budget kept because it is dispatchable must
/// be dispatchable here too.
///
/// `TypeText` is included because the driver can type into a focused field,
/// but a row that only advertises text (`actions=[text]`, the markdown word for
/// "readable") maps to nothing here — that is the point of the distinction.
fn is_dispatchable(kind: ActionKind) -> bool {
    kind.is_dispatchable()
}

fn parse_actions(input: &str) -> Vec<ActionKind> {
    let Some(start) = input.find("actions=[") else {
        return Vec::new();
    };
    let body_start = start + "actions=[".len();
    let Some(end_rel) = input[body_start..].find(']') else {
        return Vec::new();
    };
    let body = &input[body_start..body_start + end_rel];
    let mut out: Vec<ActionKind> = Vec::new();
    let mut has_set_value = false;
    let mut has_text = false;
    for token in body.split(',') {
        let kind = match token.trim().to_ascii_lowercase().as_str() {
            "invoke" | "press" | "click" => Some(ActionKind::Click),
            "set_value" | "setvalue" => {
                has_set_value = true;
                Some(ActionKind::SetValue)
            }
            "toggle" => Some(ActionKind::Click),
            "select" | "selection" => Some(ActionKind::Select),
            "expand" | "collapse" => Some(ActionKind::Click),
            "scroll" | "scrollitem" => Some(ActionKind::Scroll),
            "type_text" | "typetext" => Some(ActionKind::TypeText),
            // `text` marks a text-bearing element, not a writable one.
            //
            // Measured on a live Chromium composer: a read-only message row
            // reports `actions=[text]` and the driver refuses `set_value` on
            // it with "does not implement ValuePattern". The real composer
            // Edit reports `actions=[set_value,text]` and accepts `set_value`.
            // Mapping `text` to a write action made every read-only label
            // look like an input field, which moved the tree-budget anchor
            // off the composer and onto a message row.
            "text" => {
                has_text = true;
                None
            }
            _ => None,
        };
        if let Some(kind) = kind {
            if !out.contains(&kind) {
                out.push(kind);
            }
        }
    }
    // A row that carries `set_value` *and* `text` is a real field: it can
    // take a value as a whole and it can be typed into character by
    // character, so both actions belong to it.
    if has_set_value && has_text && !out.contains(&ActionKind::TypeText) {
        out.push(ActionKind::TypeText);
    }
    // The driver reports a list row as `actions=[select]` because it drives it
    // through UIA's SelectionItem pattern. Selection is what a click does to a
    // row, and the caller has no other way to ask for it: without this, every
    // option row in every list refuses `click` as "does not offer that action",
    // and a WPF combo box — which exposes no ValuePattern and no expandable
    // popup of its own — becomes unselectable by any action at all.
    if out.contains(&ActionKind::Select) && !out.contains(&ActionKind::Click) {
        out.push(ActionKind::Click);
    }
    out
}

impl Desktop for CuaDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: "win32".into(),
            backend: "cua-driver-mcp".into(),
            fidelity: Fidelity::Full,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: None,
            input_unsupported_reason: None,
        }
    }
    /// Read the field back and report whether it now holds `expected`.
    ///
    /// The driver reports each row's current `value` in its structured tree,
    /// so a write can be checked without exposing the value to the model:
    /// only the verdict leaves this function.
    /// Read the field back and report whether it now holds `expected`.
    ///
    /// The driver reports each row's current `value` in its structured tree,
    /// so a write can be checked without exposing the value to the model:
    /// only the verdict leaves this function.
    fn confirm_write(&self, target: &TargetRef, uid: Option<&str>, expected: &str) -> Option<bool> {
        let uid = uid?;
        // The uid is `<snapshot>:<row>`; the row is what identifies the
        // element in the next read.
        let row: usize = uid.rsplit(':').next()?.parse().ok()?;
        // The write and the tree are not in step. A keystroke reaches the
        // application through the input queue, and the accessibility tree is
        // updated a moment later -- measured on a Chromium composer, the
        // field still held the old text on the first read after the write.
        // So the read is retried for a short while before the write is
        // called unconfirmed.
        let baseline = self.baseline.lock().ok().and_then(|slot| {
            slot.clone()
                .filter(|(pid, window, baseline_row, _)| {
                    *pid == target.pid && *window == target.window && *baseline_row == row
                })
                .map(|(_, _, _, value)| value)
        });
        for attempt in 0..WRITE_CONFIRM_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(WRITE_CONFIRM_INTERVAL);
            }
            if let Some(verdict) = self.read_back_write(target, row, expected, baseline.as_deref())
            {
                return Some(verdict);
            }
        }
        None
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.list_windows_raw()
    }

    fn resolve_target(&self, target_id: &str) -> Result<Option<RawTarget>, DesktopError> {
        // Re-enumerate rather than trust the id: the driver mints ids from live
        // enumeration on every call, so the only honest answer is a fresh look.
        let targets = self.list_windows_raw()?;
        Ok(targets
            .into_iter()
            .find(|t| t.target.target_id == target_id))
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let targets = self.list_windows_raw()?;
        let found = targets
            .into_iter()
            .find(|t| t.target.pid == target.pid && t.target.window == target.window)
            .ok_or(DesktopError::TargetGone)?;
        Ok(Measured {
            bounds: found.bounds,
            app_key: found.target.app_key,
            title: found.title,
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        let (inspection, entry) = self.inspect_window(target, max_nodes)?;
        tracing::info!(target: "computer", pid = target.pid, window = target.window, snapshot = %entry.snapshot_id, rows = entry.rows.len(), nodes = inspection.nodes.len(), "cua inspect stored snapshot");
        self.snapshots.put(target.pid, target.window, entry);
        Ok(inspection)
    }
    fn self_pids(&self) -> Vec<i32> {
        // The windows that must be refused belong to the Electron parent that
        // spawned host-core, and `electron.exe` is not a name the static
        // self-key list can match. Shared with the native backend, which had
        // the same gap.
        super::self_pid_chain(4)
    }

    fn secure_input_active(&self) -> bool {
        // cua-driver exposes no "a password field has focus right now" probe.
        // The contract says a backend that cannot tell must answer `true`, and
        // the native backend already implements the real check — so this
        // backend declines rather than typing into an unknown field.
        true
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;

        match kind {
            ActionKind::Hover => Err(DesktopError::NotActionable),
            ActionKind::Click | ActionKind::DoubleClick | ActionKind::RightClick => {
                let token = self.element_token(target, uid)?;
                let tool = match kind {
                    ActionKind::DoubleClick => tools::DOUBLE_CLICK,
                    ActionKind::RightClick => tools::RIGHT_CLICK,
                    _ => tools::CLICK,
                };
                let args = json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "element_token": token
                });
                if kind == ActionKind::Click && self.opens_a_menu(target, uid) {
                    // A menu bar item is not the end of the road: the items
                    // under it only exist once it is open. Measured on a live
                    // Notepad: the tree holds "File" and nothing under it,
                    // and after the item is expanded the tree holds "Save",
                    // "Save As" and the rest -- 29 elements become 56.
                    //
                    // So the menu is opened on the way past, which is what
                    // makes the item the caller asked for reachable at all.
                    // The driver refuses the expand on an element that cannot
                    // be expanded ("ExpandCollapsePattern unavailable"), so
                    // the plain click is the fallback rather than a guess.
                    self.click_opening_a_menu(target, tool, &args)?;
                } else {
                    // Everything else is clicked. A tree item and a combo box
                    // can expand as well, and expanding one of those instead
                    // of clicking it would report success for an action that
                    // did not happen.
                    self.call_with_window_restore(tool, args, target)?;
                }
                Ok(Dispatched::AccessibilityAction)
            }
            ActionKind::SetValue => {
                let token = self.element_token(target, uid)?;
                let value = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                // The value the field holds now is the baseline the write is
                // measured against.
                self.take_baseline(target, &token);
                self.call_with_window_restore(
                    tools::SET_VALUE,
                    json!({
                        "pid": target.pid,
                        "window_id": target.window,
                        "element_token": token,
                        "value": value
                    }),
                    target,
                )?;
                Ok(Dispatched::AccessibilityAction)
            }
            ActionKind::Select => {
                let token = self.element_token(target, uid)?;
                let option = action
                    .option
                    .as_deref()
                    .ok_or(DesktopError::NotActionable)?;
                tracing::info!(target: "computer", pid = target.pid, window = target.window, token = %token, option = option, "cua select begin");

                // A native Win32 combo box accepts the option name through
                // `set_value`, which the driver turns into CB_SETCURSEL plus the
                // CBN_SELCHANGE notification a real choice sends. A DOM <select>
                // (Chromium) accepts the same call and reports success while
                // changing nothing, so the write is only trusted after a read
                // confirms it.
                let wrote = self
                    .client
                    .call_tool(
                        tools::SET_VALUE,
                        json!({
                            "pid": target.pid,
                            "window_id": target.window,
                            "element_token": token,
                            "value": option
                        }),
                    )
                    .is_ok();

                if wrote && self.combo_reads_back(target, &token, option) == Ok(ComboReading::Shows)
                {
                    return Ok(Dispatched::AccessibilityAction);
                }

                // A WPF combo box exposes neither a ValuePattern (`set_value`
                // answers `tool_invocation_failed`) nor a popup of its own
                // (`expand` answers `permission_denied`). Its option rows are
                // already children in the tree, though, and clicking one drives
                // UIA's SelectionItem.Select — which is a real choice.
                //
                // `Unreadable` counts as success here: the click reached the
                // driver and the driver reported its own SelectionItem call, and
                // this control will never confirm the choice any other way. The
                // popup script below is for rendered dropdowns, where the rows
                // do not exist until it opens.
                if self.click_option_row(target, option).unwrap_or(false) {
                    match self.combo_reads_back(target, &token, option) {
                        Ok(ComboReading::Shows) | Ok(ComboReading::Unreadable) => {
                            return Ok(Dispatched::AccessibilityAction);
                        }
                        _ => {}
                    }
                }

                // Fall back to the only path that works on a rendered popup:
                // open it with a real click, wait for the option row, click that.
                // Deliberately foreground: a synthetic click is dropped by the
                // Chromium popup, which is what the write above already proved.
                self.select_via_popup(target, &token, option)?;
                Ok(Dispatched::SystemInput)
            }
            ActionKind::TypeText => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                if let Some(token) = uid {
                    // The value the field holds now is the baseline the write
                    // is measured against: `type_text` types at the caret, so
                    // a field that already ends with the requested text looks
                    // the same before and after the write.
                    self.take_baseline(target, token);
                }
                let mut args = json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "text": text
                });
                if let Some(token) = uid {
                    if self
                        .snapshots
                        .get(target.pid, target.window)
                        .is_some_and(|e| e.rows.contains_key(token))
                    {
                        args["element_token"] = json!(token);
                    }
                }
                // The foreground escalation matters here: a Chromium composer
                // drops posted keystrokes and answers with a structured
                // refusal that names the escalation.
                self.press_with_escalation(tools::TYPE_TEXT, args, target)?;
                Ok(Dispatched::SystemInput)
            }
            ActionKind::PressKeys => {
                let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
                let mut args = json!({
                    "pid": target.pid,
                    "window_id": target.window
                });
                if let Some(token) = uid {
                    if self
                        .snapshots
                        .get(target.pid, target.window)
                        .is_some_and(|e| e.rows.contains_key(token))
                    {
                        args["element_token"] = json!(token);
                    }
                }
                // The model writes chords in the macOS idiom — the prompt's own
                // example is `["cmd+a", "delete"]` — while the driver on Windows
                // only recognises ctrl/control, shift, alt, win. Measured: the
                // driver accepts `cmd` without complaint and then sends a bare
                // `a`, so an unmapped chord is a silently wrong keystroke, not
                // an error to fall back from.
                for chord in keys {
                    let parts: Vec<String> = chord
                        .split('+')
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .map(|part| normalise_key(part).to_string())
                        .collect();
                    if parts.is_empty() {
                        continue;
                    }
                    let dispatched = if parts.len() > 1 {
                        // A chord is one `hotkey`: modifiers first, one key last.
                        let mut hot_args = args.clone();
                        hot_args["keys"] = json!(parts);
                        self.press_with_escalation(tools::HOTKEY, hot_args, target)
                    } else {
                        let mut key_args = args.clone();
                        key_args["key"] = json!(parts[0]);
                        self.press_with_escalation(tools::PRESS_KEY, key_args, target)
                    };
                    dispatched?;
                }
                Ok(Dispatched::SystemInput)
            }
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                // `scroll.dx/dy` are UIA increments (the prompt documents them as
                // page-like, max 100 per axis), and the driver's `amount` is the
                // same unit: one SB_LINEDOWN / SB_PAGEDOWN tick per increment.
                // So the delta carries straight across, clamped to the driver's
                // own 1..=50 bound rather than being dropped to a bare direction.
                let (direction, magnitude) = if scroll.dy < 0.0 {
                    ("up", -scroll.dy)
                } else if scroll.dy > 0.0 {
                    ("down", scroll.dy)
                } else if scroll.dx < 0.0 {
                    ("left", -scroll.dx)
                } else {
                    ("right", scroll.dx)
                };
                // The driver rejects `amount: 0` (its minimum is 1), and a
                // fractional delta is not a tick — round and never ask for none.
                let amount = (magnitude.round() as i64).clamp(1, SCROLL_MAX_AMOUNT);
                let mut args = json!({
                    "pid": target.pid,
                    "window_id": target.window,
                    "direction": direction,
                    "amount": amount
                });
                if let Some(token) = uid {
                    if self
                        .snapshots
                        .get(target.pid, target.window)
                        .is_some_and(|e| e.rows.contains_key(token))
                    {
                        args["element_token"] = json!(token);
                    }
                }
                self.client
                    .call_tool(tools::SCROLL, args)
                    .map_err(map_err)?;
                Ok(Dispatched::WindowEvent)
            }
            ActionKind::Drag => {
                let from = action.point.ok_or(DesktopError::NotActionable)?;
                let to = action.to.ok_or(DesktopError::NotActionable)?;
                self.client
                    .call_tool(
                        tools::DRAG,
                        json!({
                            "pid": target.pid,
                            "window_id": target.window,
                            "from_x": from.x,
                            "from_y": from.y,
                            "to_x": to.x,
                            "to_y": to.y
                        }),
                    )
                    .map_err(map_err)?;
                Ok(Dispatched::WindowEvent)
            }
        }
    }
}

/// The look-then-act program `select_via_popup` runs inside the driver.
///
/// Kept as a plain function so it can be reviewed next to the prose: everything
/// below happens between one `get_window_state` and the next, which is the only
/// window in which the popup exists at all.
fn popup_script(pid: i32, window: u64, token_literal: &str, option_literal: &str) -> String {
    format!(
        r#"
const app = await cua.getApp({{pid: {pid}, windowId: {window}}});
const token = {token_literal}, want = {option_literal};
const row = parseInt(String(token).split(":").pop(), 10);

// 1) Open the popup. Foreground on purpose: a synthetic click is dropped by the
//    rendered list, which is exactly what set_value already failed to do here.
const st0 = await cua.call("get_window_state", {{pid: {pid}, window_id: {window}, max_elements: {DRIVER_WALK_NODES}, timeout_ms: 20000}});
let opened = false;
try {{
  await cua.call("click", {{pid: {pid}, window_id: {window}, element_token: token, action: "expand"}});
  opened = true;
}} catch (e) {{}}
if (!opened) {{
  const combo = (await app.query({{role: "combobox"}}))[0];
  const wb = st0.window_bounds;
  await cua.call("click", {{
    pid: {pid}, window_id: {window},
    x: Math.round(combo.frame.x - wb.x + combo.frame.w / 2),
    y: Math.round(combo.frame.y - wb.y + combo.frame.h / 2),
    capture_id: st0.capture_id, delivery_mode: "foreground"
  }});
}}

// 2) Wait for the option row, then keep the newest snapshot and its frame.
let snap = null, optRow = -1, optFrame = null;
for (let i = 0; i < 12; i++) {{
  await cua.sleep(300);
  const st = await app.getState({{max_elements: {DRIVER_WALK_NODES}, timeout_ms: 20000}});
  const lines = (st.tree_markdown || "").split("\n");
  const hit = lines.find(line => line.indexOf(want) >= 0 && line.indexOf("ListItem") >= 0);
  if (!hit) continue;
  const m = hit.match(/\[(\d+)\]/);
  if (m) {{ snap = st.snapshot_id; optRow = parseInt(m[1], 10); }}
  const found = (await app.query({{role: "listitem"}}))
    .find(item => String(item.label || item.name || "").indexOf(want) >= 0);
  if (found && found.frame) optFrame = found.frame;
  break;
}}
if (optRow < 0) throw new Error("option " + want + " never appeared in the open list");

// 3) Click the row. Coordinates when the popup exposes them, the token otherwise.
const st2 = await cua.call("get_window_state", {{pid: {pid}, window_id: {window}, max_elements: {DRIVER_WALK_NODES}, timeout_ms: 20000}});
const wb2 = st2.window_bounds;
const args = optFrame
  ? {{ pid: {pid}, window_id: {window},
       x: Math.round(optFrame.x - wb2.x + optFrame.w / 2),
       y: Math.round(optFrame.y - wb2.y + optFrame.h / 2),
       capture_id: st2.capture_id, delivery_mode: "foreground" }}
  : {{ pid: {pid}, window_id: {window}, element_token: snap + ":" + optRow, delivery_mode: "foreground" }};
await cua.call("click", args);
await cua.sleep(500);

// 4) Prove it took, rather than reporting the driver's "sent" as success.
const st3 = await app.getState({{max_elements: {DRIVER_WALK_NODES}, timeout_ms: 20000}});
const line = (st3.tree_markdown || "").split("\n").find(entry => entry.indexOf("[" + row + "] ComboBox") >= 0);
if (!line || line.indexOf('value="' + want + '"') < 0) {{
  throw new Error("the list closed without the combo showing " + want);
}}
return {{ selected: want }};
"#,
        pid = pid,
        window = window,
        token_literal = token_literal,
        option_literal = option_literal,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        "- Window \"CU WPF Target\"\n",
        "  - [0] TitleBar [value=\"CU WPF Target\" actions=[set_value]]\n",
        "    - MenuBar \"系统\"\n",
        "  - [5] Button \"WPF-BUTTON\" [actions=[invoke]]\n",
        "    - Text \"WPF-BUTTON\"\n",
        "  - [6] Edit [actions=[set_value,text,scroll]]\n",
        "  - [7] CheckBox \"WPF Check\" [actions=[toggle]]\n",
    );

    #[test]
    fn identity_survives_a_new_snapshot_while_uid_does_not() {
        // This is the whole reason `Node::identity` exists. The driver re-mints
        // `uid` from a fresh snapshot on every read, so anything that compares
        // two observations against `uid` sees "everything changed" every time —
        // which silently disabled both the change signal and the completion
        // check. `identity` must be identical across reads of an unchanged tree.
        let (first, _) = parse_markdown_tree(SAMPLE, "s00000001");
        let (second, _) = parse_markdown_tree(SAMPLE, "s00000002");

        let first_identities: Vec<&str> = first
            .iter()
            .map(|n| n.identity.as_deref().expect("identity is always minted"))
            .collect();
        let second_identities: Vec<&str> = second
            .iter()
            .map(|n| n.identity.as_deref().expect("identity is always minted"))
            .collect();
        assert_eq!(
            first_identities, second_identities,
            "identity must not carry the snapshot id"
        );

        let first_uids: Vec<&str> = first.iter().map(|n| n.uid.as_str()).collect();
        let second_uids: Vec<&str> = second.iter().map(|n| n.uid.as_str()).collect();
        assert_ne!(
            first_uids, second_uids,
            "uid must still change per snapshot"
        );
    }

    #[test]
    fn identity_names_the_path_not_the_label() {
        // A label that changed is normally the evidence that an action worked,
        // so it must not be part of the identity: folding it in would report
        // "different element" exactly when the caller needs "same element, new
        // state".
        let before = "- Window \"W\"\n  - [0] Pane [actions=[scroll]]\n    - [1] Button \"Save\" [actions=[invoke]]\n";
        let after = "- Window \"W\"\n  - [0] Pane [actions=[scroll]]\n    - [1] Button \"Saved\" [actions=[invoke]]\n";
        let (a, _) = parse_markdown_tree(before, "s1");
        let (b, _) = parse_markdown_tree(after, "s2");
        assert_eq!(
            a[1].identity, b[1].identity,
            "a renamed control is the same control"
        );
        assert_ne!(a[1].label, b[1].label, "the label itself did change");
    }

    #[test]
    fn identity_is_unique_between_same_role_siblings() {
        // Ordinals are what keep two otherwise identical rows apart.
        let tree = "- Window \"W\"\n  - [0] List [actions=[scroll]]\n    - [1] ListItem \"a\" [actions=[select]]\n    - [2] ListItem \"b\" [actions=[select]]\n";
        let (nodes, _) = parse_markdown_tree(tree, "s1");
        let identities: Vec<&str> = nodes.iter().filter_map(|n| n.identity.as_deref()).collect();
        let mut sorted = identities.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            identities.len(),
            "every node needs a distinct identity: {identities:?}"
        );
        assert_eq!(nodes[1].identity.as_deref(), Some("list#0/list-item#0"));
        assert_eq!(nodes[2].identity.as_deref(), Some("list#0/list-item#1"));
    }
    #[test]
    fn parses_roles_labels_and_actions() {
        let (nodes, rows) = parse_markdown_tree(SAMPLE, "s1");
        assert_eq!(rows.len(), 4);
        let button = nodes
            .iter()
            .find(|n| n.label.as_deref() == Some("WPF-BUTTON"))
            .unwrap();
        // The driver's `Button` is stored under this crate's spelling. The
        // parser canonicalises every role, so the tree a caller reads back is
        // already in the vocabulary policy and the answer validator branch on.
        assert_eq!(button.role, "button");
        assert_eq!(button.uid, "s1:5");
        assert!(button.actions.contains(&ActionKind::Click));
        assert!(button.enabled);

        let edit = nodes.iter().find(|n| n.role == "edit").unwrap();
        assert_eq!(edit.uid, "s1:6");
        assert!(edit.actions.contains(&ActionKind::SetValue));
        assert!(edit.actions.contains(&ActionKind::TypeText));
    }

    #[test]
    fn driver_roles_are_translated_into_this_crates_vocabulary() {
        // `answer.ts` asks whether a role is semantically selectable and
        // accepts only `combo-box` / `list` / `list-item`. A raw `ComboBox`
        // reaching the validator is refused before the backend is called, so
        // this mapping is load-bearing rather than cosmetic.
        let line =
            "- [11] ComboBox \"Select:\" [value=\"--choose--\" actions=[expand,set_value]]\n\
                    - [13] ListItem \"Electron-1\" [actions=[invoke,select]]\n\
                    - [14] TreeItem \"root\" [actions=[expand]]\n\
                    - [15] Widget \"unknown role\" [actions=[invoke]]\n";
        let (nodes, _) = parse_markdown_tree(line, "s");
        let roles: Vec<&str> = nodes.iter().map(|n| n.role.as_str()).collect();
        assert_eq!(roles, vec!["combo-box", "list-item", "tree-item", "Widget"]);
    }

    #[test]
    fn a_selectable_row_also_accepts_a_click() {
        // The driver reports every list row as `actions=[select]`. Without
        // Click alongside it, `click` on an option row is refused as "does not
        // offer that action" — and a WPF combo box, which answers
        // `tool_invocation_failed` to set_value and `permission_denied` to
        // expand, would then be unselectable by any action at all.
        let line = "- [11] ListItem \"Beta\" [actions=[select]]\n";
        let (nodes, _) = parse_markdown_tree(line, "s");
        assert_eq!(nodes.len(), 1);
        assert!(nodes[0].actions.contains(&ActionKind::Select));
        assert!(
            nodes[0].actions.contains(&ActionKind::Click),
            "a selectable row must also answer a click"
        );
        assert!(nodes[0].enabled);
    }

    #[test]
    fn a_row_that_only_carries_text_is_read_only() {
        // The reverse guard: `actions=[text]` marks a text-bearing element, not
        // a writable one.
        //
        // Measured on a live Chromium composer tree: a read-only message row
        // reports `actions=[text]`, and the driver refuses `set_value` on it
        // with "does not implement ValuePattern". The real composer Edit
        // reports `actions=[set_value,text]` and accepts the write. Mapping
        // `text` to a write action therefore made every read-only label in the
        // window look like an input field.
        let line = "- [4] Text \"clicks=0\" [actions=[text]]\n";
        let (nodes, _) = parse_markdown_tree(line, "s");
        assert_eq!(nodes.len(), 1);
        assert!(!nodes[0].actions.contains(&ActionKind::Select));
        assert!(!nodes[0].actions.contains(&ActionKind::Click));
        assert!(!nodes[0].actions.contains(&ActionKind::TypeText));
        assert!(!nodes[0].actions.contains(&ActionKind::SetValue));
        assert!(
            !nodes[0].has_value,
            "a readable row holds no value the caller can write into"
        );
    }

    #[test]
    fn macos_modifier_spellings_become_control() {
        // The prompt's own example chord is `cmd+a`. The driver accepts `cmd`
        // without complaint and then sends a bare `a` — measured on a live WPF
        // target — so the mapping has to happen here or the keystroke is silently
        // wrong.
        for spelling in ["cmd", "command", "meta", "super", "control", "Ctrl"] {
            assert_eq!(
                normalise_key(spelling),
                "ctrl",
                "{spelling} must map to ctrl on Windows"
            );
        }
        assert_eq!(normalise_key("option"), "alt");
        assert_eq!(normalise_key("windows"), "win");
    }

    #[test]
    fn driver_key_names_pass_through_unchanged() {
        // Everything the driver documents is already what the model is told to
        // write; touching it would be a second, quieter bug.
        for key in ["return", "tab", "escape", "up", "pageup", "f5", "a", "7"] {
            assert_eq!(normalise_key(key), key, "{key} must not be rewritten");
        }
        assert_eq!(normalise_key("esc"), "escape");
        assert_eq!(normalise_key("enter"), "return");
    }

    #[test]
    fn a_chord_is_split_the_way_the_driver_expects() {
        // `cmd+a` must become the hotkey argument list ["ctrl", "a"], modifiers
        // first and one key last.
        let chord = "cmd+a";
        let parts: Vec<&str> = chord
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(normalise_key)
            .collect();
        assert_eq!(parts, vec!["ctrl", "a"]);
        assert_eq!(
            parts.len(),
            2,
            "a chord must be a full hotkey argument list"
        );
        // A bare key is one press_key, not a one-element hotkey (the driver
        // requires minItems 2 for hotkey).
        let single: Vec<&str> = "tab".split('+').map(normalise_key).collect();
        assert_eq!(single.len(), 1);
    }

    #[test]
    fn a_scroll_delta_becomes_a_tick_count_the_driver_accepts() {
        // `scroll.dx/dy` are UIA increments and the driver's `amount` is a
        // 1..=50 tick count, so the delta carries across — clamped, never zero.
        fn amount(dx: f64, dy: f64) -> (String, i64) {
            let (direction, magnitude) = if dy < 0.0 {
                ("up", -dy)
            } else if dy > 0.0 {
                ("down", dy)
            } else if dx < 0.0 {
                ("left", -dx)
            } else {
                ("right", dx)
            };
            (
                direction.to_string(),
                (magnitude.round() as i64).clamp(1, SCROLL_MAX_AMOUNT),
            )
        }
        assert_eq!(amount(0.0, 3.0), ("down".into(), 3));
        assert_eq!(amount(0.0, -2.0), ("up".into(), 2));
        assert_eq!(amount(-1.0, 0.0), ("left".into(), 1));
        assert_eq!(amount(4.0, 0.0), ("right".into(), 4));
        // The driver's minimum is 1: a fractional or zero delta must not become
        // `amount: 0`, which it rejects outright.
        assert_eq!(amount(0.0, 0.0).1, 1);
        assert_eq!(amount(0.0, 0.4).1, 1);
        // And its ceiling is 50; above that it silently clamps anyway.
        assert_eq!(amount(0.0, 900.0).1, SCROLL_MAX_AMOUNT);
    }

    #[test]
    fn parent_skips_untagged_container_lines() {
        let (nodes, _) = parse_markdown_tree(SAMPLE, "s1");
        // `Text "WPF-BUTTON"` has no row, so it is dropped; the Button above it
        // still owns the depth slot, which keeps parent indices pointing at real
        // nodes rather than at offsets into a filtered list.
        let button_index = nodes.iter().position(|n| n.uid == "s1:5").unwrap();
        assert!(
            nodes[button_index].parent.is_none()
                || nodes[button_index].parent.unwrap() < button_index
        );
    }

    #[test]
    fn a_label_with_escaped_quotes_round_trips() {
        let line = r#"- [3] Button "say \"hi\"" [actions=[invoke]]"#;
        let (nodes, _) = parse_markdown_tree(line, "s");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].label.as_deref(), Some(r#"say "hi""#));
    }

    #[test]
    fn rows_without_a_prefix_are_ignored() {
        let (nodes, rows) =
            parse_markdown_tree("- Window \"No rows here\"\n- Text \"plain\"\n", "s");
        assert!(nodes.is_empty());
        assert!(rows.is_empty());
    }

    #[test]
    fn an_empty_chromium_field_still_counts_as_holding_a_value() {
        // Chromium omits `value=` for an empty input but still lists
        // `set_value`. If `has_value` keyed on the literal alone, every text
        // field would look unwritable before the first character was typed —
        // and `set_value` would be refused by the answer validator.
        let line =
            "- [9] Edit \"Text input:\" [id=txt help=\"type here\" actions=[set_value,text]]";
        let (nodes, _) = parse_markdown_tree(line, "s");
        assert_eq!(nodes.len(), 1);
        assert!(
            nodes[0].has_value,
            "a field advertising set_value holds a value even with no value= in the tree"
        );
        assert!(nodes[0].actions.contains(&ActionKind::SetValue));
    }

    #[test]
    fn unknown_action_words_do_not_widen_the_set() {
        let line = "- [1] Pane [actions=[mystery,invoke]]";
        let (nodes, _) = parse_markdown_tree(line, "s");
        assert_eq!(nodes[0].actions, vec![ActionKind::Click]);
    }

    #[test]
    fn the_driver_walk_budget_is_not_capped_by_the_model_node_budget() {
        // The model only ever sees MAX_NODES rows, but the driver walk is
        // truncated at its own budget and the cut removes the tail of the
        // tree -- which is where the composer and the action buttons live.
        // Asking the driver for no more than the model's budget can therefore
        // drop the very control the caller is about to use.
        assert!(
            DRIVER_WALK_NODES as usize > crate::computer::MAX_NODES,
            "the driver walk budget must exceed the model node budget"
        );
        assert!(
            clamp_walk_elements(50) >= DRIVER_WALK_NODES,
            "a small caller budget must not lower the driver walk budget"
        );
        assert!(
            clamp_walk_elements(5000) <= 5000,
            "the driver walk budget must respect the driver's own ceiling"
        );
    }

    #[test]
    fn the_popup_script_asks_the_driver_for_the_full_walk_budget() {
        let script = popup_script(42, 100, "\"s:1\"", "\"Option A\"");
        assert!(
            script.contains(&format!("max_elements: {DRIVER_WALK_NODES}")),
            "the popup script must not read a truncated tree: {script}"
        );
    }

    #[test]
    fn the_driver_walk_budget_covers_a_long_chromium_thread() {
        // Measured: a Chromium chat window with a long thread has a 432-node
        // tree, and a budget of 500 stopped the walk inside the message list
        // with the composer absent. The budget has to clear that.
        assert!(
            DRIVER_WALK_NODES >= 700,
            "the driver walk budget must cover a long thread's composer"
        );
        assert!(
            DRIVER_WALK_NODES >= 700,
            "the driver walk budget must cover a long thread's composer"
        );
    }

    #[test]
    fn the_structured_tree_keeps_a_row_whose_value_holds_a_newline() {
        // The reason the host reads the structured tree instead of the
        // markdown rendering: a markdown row prints a value verbatim, and a
        // value that ends in a newline splits the row in half, so the quoted
        // label of that row never closes and the row is dropped entirely.
        //
        // A Chromium composer holds exactly such a value -- its placeholder
        // ends in a newline -- so on markdown the composer was simply not in
        // the tree, and the run could not find the field it had to type into.
        let elements = json!([
            {
                "role": "Document",
                "element_index": 0,
                "actions": ["set_value", "text", "scroll"],
                "label": "回复消息确认",
                "value": "app://-/index.html"
            },
            {
                "role": "Edit",
                "element_index": 418,
                "parent_index": 0,
                "actions": ["set_value", "text"],
                "label": "和 Codex 一起工作",
                "value": "和 Codex 一起工作\n"
            }
        ]);
        let (nodes, rows, _roles) = parse_elements_tree(&elements, "s00000001");
        assert_eq!(nodes.len(), 2, "a multi-line value must not drop its row");
        assert_eq!(rows.len(), 2);
        let edit = nodes
            .iter()
            .find(|node| node.role == "edit")
            .expect("the composer must be in the tree");
        assert_eq!(edit.uid, "s00000001:418");
        assert!(edit.actions.contains(&ActionKind::SetValue));
        assert!(edit.has_value);
    }

    #[test]
    fn the_structured_tree_keeps_a_read_only_row_out_of_the_write_set() {
        // A read-only message row carries the driver's `text` action, and so
        // does the real composer. The difference is `set_value`, which only a
        // real field advertises.
        //
        // Measured: the driver refuses `set_value` on the read-only row with
        // "does not implement ValuePattern", and accepts it on the composer.
        let elements = json!([
            {
                "role": "Text",
                "element_index": 381,
                "parent_index": 0,
                "actions": ["text"],
                "label": "19:44"
            },
            {
                "role": "Edit",
                "element_index": 418,
                "parent_index": 0,
                "actions": ["set_value", "text"],
                "label": "和 Codex 一起工作",
                "value": "和 Codex 一起工作\n"
            }
        ]);
        let (nodes, _, _roles) = parse_elements_tree(&elements, "s1");
        let text = nodes
            .iter()
            .find(|node| node.role == "text")
            .expect("the read-only row must be in the tree");
        assert!(
            !text.actions.contains(&ActionKind::SetValue),
            "a read-only row must not offer a write"
        );
        assert!(
            !text.actions.contains(&ActionKind::TypeText),
            "a read-only row must not look like an input field"
        );
        assert!(!text.has_value, "a read-only row holds no writable value");
        assert!(
            text.actions.is_empty(),
            "a read-only row offers no dispatchable action: {:?}",
            text.actions
        );
    }

    #[test]
    fn a_field_that_carries_both_set_value_and_text_takes_typed_text() {
        // A real field can be written as a whole and typed into character by
        // character, so both actions belong to it.
        let elements = json!([
            {
                "role": "Edit",
                "element_index": 418,
                "actions": ["set_value", "text"],
                "label": "和 Codex 一起工作",
                "value": "和 Codex 一起工作\n"
            }
        ]);
        let (nodes, _, _roles) = parse_elements_tree(&elements, "s1");
        assert!(nodes[0].actions.contains(&ActionKind::SetValue));
        assert!(nodes[0].actions.contains(&ActionKind::TypeText));
    }

    #[test]
    fn a_structured_node_keeps_its_parent_and_its_identity_path() {
        let elements = json!([
            {
                "role": "Document",
                "element_index": 0,
                "actions": ["set_value", "text", "scroll"],
                "label": "回复消息确认"
            },
            {
                "role": "Group",
                "element_index": 1,
                "parent_index": 0,
                "actions": ["invoke"]
            },
            {
                "role": "Edit",
                "element_index": 418,
                "parent_index": 1,
                "actions": ["set_value", "text"],
                "label": "和 Codex 一起工作",
                "value": "和 Codex 一起工作\n"
            }
        ]);
        let (nodes, _, _roles) = parse_elements_tree(&elements, "s1");
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].parent, None);
        assert_eq!(nodes[1].parent, Some(0));
        assert_eq!(nodes[2].parent, Some(1));
        assert_eq!(
            nodes[2].identity.as_deref(),
            Some("document#0/pane#0/edit#0")
        );
    }

    #[test]
    fn a_written_field_is_confirmed_by_its_read_back() {
        // The tree the caller reads never publishes a field's content, so a
        // write cannot be confirmed from it. The driver does publish the
        // field's current value, and the comparison happens inside the
        // backend -- only the verdict crosses the boundary.
        assert!(write_confirmed("hello", "hello", None));
        // A text field's value often carries a trailing newline the platform
        // adds, so an exact comparison would report a landed write as a lost
        // one.
        assert!(write_confirmed("hello\n", "hello", None));
    }

    #[test]
    fn a_write_is_confirmed_across_the_platform_line_ending() {
        // Measured on a Windows text field: "\n" came back as "\r",
        // "\r\n" as "\r", and "a\r\nb" as "a\rb". That is the
        // platform's own line-ending convention, so a write that contained a
        // line ending still landed.
        assert!(write_confirmed("hello\r", "hello\n", None));
        assert!(write_confirmed("hello\r", "hello\r\n", None));
        assert!(write_confirmed("a\rb", "a\r\nb", None));
        assert!(write_confirmed("hello\r", "hello", None));
    }

    #[test]
    fn a_write_is_not_confirmed_when_the_field_holds_something_else() {
        assert!(!write_confirmed("goodbye", "hello", None));
        // An empty write is not a confirmed write.
        assert!(!write_confirmed("", "", None));
    }

    #[test]
    fn a_typed_field_is_confirmed_when_it_ends_with_what_was_typed() {
        // `type_text` types characters into the focused control, so the field
        // ends with what was written rather than holding exactly it.
        assert!(write_confirmed("first second", "second", None));
        assert!(write_confirmed("first second\n", "second", None));
        // A field that holds the text somewhere in the middle did not receive
        // it as a typed suffix.
        assert!(!write_confirmed("first second", "first", None));
    }

    #[test]
    fn a_typed_write_into_a_field_that_already_held_the_text_is_not_confirmed() {
        // The suffix check alone would report a write that was dropped as a
        // write that landed: the field already ended with the text, so it
        // looks the same before and after. The value from before the write is
        // what tells them apart.
        assert!(!write_confirmed(
            "prefix second",
            "second",
            Some("prefix second")
        ));
        // The same field, and the text really was typed this time.
        assert!(write_confirmed("prefix second", "second", Some("prefix")));
    }

    #[test]
    fn only_the_drivers_own_escalation_refusal_reaches_the_foreground_retry() {
        // Measured on a live Chromium composer: `type_text` on the window
        // answers with a structured `background_unavailable` refusal that
        // names the escalation. Retrying the same action unchanged fails the
        // same way, so the retry has to carry `delivery_mode: "foreground"`.
        //
        // Every other refusal has to propagate untouched: the bridge only
        // overrides the driver's own default when the driver asked for it.
        assert!(escalates_to_foreground(
            "type_text refused [background_unavailable]: Background delivery is not available \
             for target window class 'Chrome_WidgetWin_1' on this event kind (text_input). \
             Retry this action with delivery_mode:\"foreground\""
        ));
        assert!(!escalates_to_foreground(
            "set_value refused [tool_invocation_failed]: element [381] does not implement \
             ValuePattern or RangeValuePattern"
        ));
        assert!(!escalates_to_foreground(
            "cua-driver timed out: get_window_state"
        ));
    }

    #[test]
    fn only_a_scan_that_ran_out_of_time_is_worth_another_attempt() {
        // Measured on a live Notepad editor: the driver refuses a chord whose
        // accelerator it cannot find, and it says so two ways. The settled
        // answer came back in ~50ms on a fresh driver process. The timeout
        // wording came back in ~4ms on the same chord after the connection
        // had enumerated the desktop's windows -- a scan that exceeded
        // 4000ms cannot answer in 4ms, so that wording is the settled
        // refusal wearing the wrong words, and it arrives only after an
        // enumeration.
        //
        // So the timeout wording is worth another attempt only while the
        // connection has not enumerated. Afterwards it is final, and
        // repeating it would spend the action's budget to arrive at the same
        // refusal.
        const TIMEOUT_WORDING: &str =
            "hotkey refused [tool_invocation_failed]: hotkey (UIA path): UIA accelerator scan \
             exceeded 4000ms; a UIA provider in the target app is likely unresponsive";

        assert!(chord_retry_is_worth_it(TIMEOUT_WORDING, false));
        assert!(!chord_retry_is_worth_it(TIMEOUT_WORDING, true));

        // The settled answer is final either way: the target exposes no
        // accelerator, and repeating the chord only spends the action's time.
        assert!(!chord_retry_is_worth_it(
            "hotkey refused [tool_invocation_failed]: hotkey on a modern XAML / UWP target \
             could not find a UIA AcceleratorKey or `(Ctrl+X)`-style name hint matching `ctrl+s` \
             (scanned 42 element(s)).",
            false
        ));
        assert!(!chord_retry_is_worth_it(
            "hotkey refused [tool_invocation_failed]: hotkey on a modern XAML / UWP target \
             could not find a UIA AcceleratorKey or `(Ctrl+X)`-style name hint matching `ctrl+s` \
             (scanned 42 element(s)).",
            true
        ));

        // Every other refusal is final too.
        assert!(!chord_retry_is_worth_it(
            "set_value refused [tool_invocation_failed]: element [381] does not implement \
             ValuePattern or RangeValuePattern",
            false
        ));
        assert!(!chord_retry_is_worth_it(
            "cua-driver timed out: get_window_state",
            false
        ));
    }

    #[test]
    fn an_enumerated_connection_restores_the_advice_the_timeout_wording_replaced() {
        // The timeout wording names a cause that did not happen -- a provider
        // that is "likely unresponsive" -- and carries no advice at all. The
        // settled wording it stands in for names the real cause and says what
        // to do about it: open the menu, click the item.
        //
        // The advice is the part that lets the caller recover, so the refusal
        // the caller is told has to carry it.
        const TIMEOUT_WORDING: &str =
            "hotkey refused [tool_invocation_failed]: hotkey (UIA path): UIA accelerator scan \
             exceeded 4000ms; a UIA provider in the target app is likely unresponsive";

        let restored = chord_refusal_message(TIMEOUT_WORDING, true);
        assert!(
            restored.contains("click` the matching element directly")
                || restored.contains("click the matching element directly"),
            "the advice has to survive: {restored}"
        );
        assert!(
            restored.contains("closed menu"),
            "the real cause has to be named: {restored}"
        );

        // Before an enumeration the timeout is a timeout, and it is reported
        // as the driver worded it.
        let untouched = chord_refusal_message(TIMEOUT_WORDING, false);
        assert!(untouched.contains("accelerator scan exceeded 4000ms"));
        assert!(!untouched.contains("closed menu"));

        // A refusal that is not the timeout wording is passed through as it
        // is: the bridge only rewrites the one diagnostic it has measured to
        // be wrong.
        const SETTLED: &str =
            "hotkey refused [tool_invocation_failed]: hotkey on a modern XAML / UWP target \
             could not find a UIA AcceleratorKey matching `ctrl+s` (scanned 42 element(s)).";
        assert_eq!(chord_refusal_message(SETTLED, true), SETTLED);
        assert_eq!(chord_refusal_message(SETTLED, false), SETTLED);
    }
}
