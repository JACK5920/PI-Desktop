//! The macOS computer-use backend: accessibility inspection and actions over
//! `AXUIElement`, window enumeration over `CGWindowList`, and key input posted
//! to the granted application's process.
//!
//! The C surface it is built on — the `extern "C"` declarations, the type
//! aliases, and the owning `CFString`/`CFType` wrappers — is in [`ffi`]; this
//! module is the behaviour: which windows exist, what their accessibility trees
//! say, and what a granted action is allowed to touch.
//!
//! The pointer is never warped. Element actions go through `AXUIElementPerformAction`
//! and values through `AXUIElementSetAttributeValue`, so the user keeps their
//! mouse while the agent works. Keys are posted with `CGEventPostToPid`, which
//! delivers to the granted process rather than to whatever has focus.

#![allow(non_snake_case)]

mod ffi;
mod pointer;
mod text;

use super::macos_text::{is_editable_text_role, is_secure_text_role};
use ffi::*;
use pointer::*;

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::{
    Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Point, Rect, MAX_LABEL_CHARS,
};

pub struct MacDesktop;

fn should_offer_set_value(has_value: bool, settable: bool, enabled: bool) -> bool {
    has_value && settable && enabled
}

fn value_matches(expected: &str, actual: Option<&str>) -> bool {
    actual == Some(expected)
}

impl MacDesktop {
    pub fn new() -> Self {
        Self
    }

    fn trusted(&self) -> bool {
        // SAFETY: the call takes no arguments and only reads TCC state.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    /// Ask TCC to show its Accessibility prompt without granting trust ourselves.
    fn prompt_for_trust(&self) -> Result<bool, DesktopError> {
        // SAFETY: both keys and values are immutable framework constants. The
        // dictionary borrows them and is released after the synchronous call;
        // the prompt itself is asynchronous and does not change the return value.
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                std::ptr::null(),
                std::ptr::null(),
            );
            if options.is_null() {
                return Err(DesktopError::Failed(
                    "could not create Accessibility prompt options".into(),
                ));
            }
            let options = CfOwned(options);
            Ok(AXIsProcessTrustedWithOptions(options.as_ref()) != 0)
        }
    }

    /// The AX element for one window, re-resolved from the application each
    /// time: holding an `AXUIElementRef` across calls would mean acting on a
    /// window that may already be gone.
    fn window_element(&self, target: &TargetRef) -> Result<CfOwned, DesktopError> {
        if !self.trusted() {
            return Err(DesktopError::PermissionMissing);
        }
        // SAFETY: the pid is validated by the caller's grant; a dead pid
        // yields an element whose attribute reads fail, which we map below.
        let app = unsafe { AXUIElementCreateApplication(target.pid) };
        if app.is_null() {
            return Err(DesktopError::TargetGone);
        }
        let app = CfOwned(app);
        let windows = attribute(app.as_ref(), "AXWindows").ok_or(DesktopError::TargetGone)?;
        // SAFETY: type-checked; entries are borrowed from an array we keep.
        let found = unsafe {
            if CFGetTypeID(windows.as_ref()) != CFArrayGetTypeID() {
                return Err(DesktopError::TargetGone);
            }
            let count = CFArrayGetCount(windows.as_ref());
            let mut found: Option<CFTypeRef> = None;
            for index in 0..count {
                let window = CFArrayGetValueAtIndex(windows.as_ref(), index);
                if window.is_null() {
                    continue;
                }
                // `AXWindowNumber` is not public API on every release, so the
                // window is matched on geometry and title, the two things
                // `CGWindowList` also gave us. A mismatch is a refusal, not a
                // guess at which window the user meant.
                if self.window_matches(window, target) {
                    found = Some(window);
                    break;
                }
            }
            found
        };
        let window = found.ok_or(DesktopError::TargetGone)?;
        // Retain before the window array drops, so the caller holds a
        // reference that outlives the enumeration it came from.
        // SAFETY: `window` is a live entry of an array we still own here.
        let retained = unsafe { CFRetain(window) };
        drop(windows);
        Ok(CfOwned(retained))
    }

    fn window_matches(&self, window: AXUIElementRef, target: &TargetRef) -> bool {
        // The window id is the join key when the system exposes it: it is the
        // same number `CGWindowList` gave us, so a match is an identity and a
        // mismatch is definitive rather than a reason to guess by shape.
        if let Some(id) = ax_window_id(window) {
            return u64::from(id) == target.window;
        }
        // Fallback for a system without `_AXUIElementGetWindow`: geometry, the
        // other thing both sides report. It is unreliable when the window
        // server and accessibility disagree about a window's frame — Stage
        // Manager reports a thumbnail to `CGWindowList` while accessibility
        // reports the real frame — so an off-stage window is refused here
        // rather than confused with another one.
        let Some(position) = attribute_point(window, "AXPosition") else {
            return false;
        };
        let Some(size) = attribute_size(window, "AXSize") else {
            return false;
        };
        let bounds = Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        };
        self.cg_bounds(target)
            .map(|cg| cg.matches(&bounds))
            .unwrap_or(false)
    }

    /// The window's frame as accessibility reports it, which is the frame every
    /// element position is relative to. `None` when the window cannot be
    /// opened — including before the Accessibility grant exists.
    fn ax_bounds(&self, target: &TargetRef) -> Option<Rect> {
        let window = self.window_element(target).ok()?;
        let position = attribute_point(window.as_ref(), "AXPosition")?;
        let size = attribute_size(window.as_ref(), "AXSize")?;
        Some(Rect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }

    /// Window geometry straight from `CGWindowList`, which does not need the
    /// Accessibility grant and is therefore also the pre-permission answer.
    fn cg_bounds(&self, target: &TargetRef) -> Option<Rect> {
        self.enumerate()
            .ok()?
            .into_iter()
            .find(|item| item.target.window == target.window && item.target.pid == target.pid)
            .map(|item| item.bounds)
    }

    fn enumerate(&self) -> Result<Vec<RawTarget>, DesktopError> {
        // SAFETY: the returned array is owned by us and released by `CfOwned`.
        let array = unsafe { CGWindowListCopyWindowInfo(WINDOW_LIST_OPTIONS, kCGNullWindowID) };
        if array.is_null() {
            return Err(DesktopError::Failed("window list unavailable".into()));
        }
        let owned = CfOwned(array);
        let mut targets = Vec::new();
        // SAFETY: the array is owned and holds CFDictionary entries.
        unsafe {
            let count = CFArrayGetCount(owned.as_ref());
            for index in 0..count {
                let dict = CFArrayGetValueAtIndex(owned.as_ref(), index);
                if dict.is_null() {
                    continue;
                }
                // Layer 0 is the normal application layer: menu bar extras,
                // the Dock, and overlays sit above it and are not targets a
                // user would mean when they say "this window".
                let layer = dict_value(dict, "kCGWindowLayer")
                    .and_then(cf_number_i64)
                    .unwrap_or(0);
                if layer != 0 {
                    continue;
                }
                let Some(pid) = dict_value(dict, "kCGWindowOwnerPID").and_then(cf_number_i64)
                else {
                    continue;
                };
                let Some(window) = dict_value(dict, "kCGWindowNumber").and_then(cf_number_i64)
                else {
                    continue;
                };
                let app_name = dict_value(dict, "kCGWindowOwnerName")
                    .and_then(cf_string_value)
                    .unwrap_or_default();
                let title = dict_value(dict, "kCGWindowName")
                    .and_then(cf_string_value)
                    .unwrap_or_default();
                let bounds_dict = dict_value(dict, "kCGWindowBounds").unwrap_or(std::ptr::null());
                let read = |key: &str| {
                    dict_value(bounds_dict, key)
                        .and_then(cf_number_f64)
                        .unwrap_or(0.0)
                };
                let bounds = Rect {
                    x: read("X"),
                    y: read("Y"),
                    width: read("Width"),
                    height: read("Height"),
                };
                // A zero-area window is not something a user can point at.
                if bounds.width < 1.0 || bounds.height < 1.0 {
                    continue;
                }
                targets.push(RawTarget {
                    target: TargetRef {
                        target_id: format!("{pid}:{window}"),
                        pid: pid as i32,
                        window: window as u64,
                        // macOS does not publish the bundle id here; the owner
                        // name is what the platform can prove, and `measure`
                        // compares it to catch a reused window handle.
                        app_key: app_name.to_ascii_lowercase(),
                    },
                    app_name,
                    title,
                    bounds,
                    elevated: false,
                });
            }
        }
        Ok(targets)
    }

    fn walk(
        &self,
        element: AXUIElementRef,
        path: &mut Vec<usize>,
        parent: Option<usize>,
        nodes: &mut Vec<Node>,
        max_nodes: usize,
    ) -> bool {
        if nodes.len() >= max_nodes {
            return true;
        }
        let role = attribute_string(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
        let subrole = attribute_string(element, "AXSubrole");
        let is_secure_text = is_secure_text_role(&role, subrole.as_deref());
        let label = attribute_string(element, "AXTitle")
            .or_else(|| attribute_string(element, "AXDescription"))
            .or_else(|| attribute_string(element, "AXLabel"))
            .map(|value| value.chars().take(MAX_LABEL_CHARS).collect::<String>())
            .filter(|value| !value.trim().is_empty());
        let has_value = attribute(element, "AXValue").is_some();
        let can_set_value =
            has_value && !is_secure_text && attribute_is_settable(element, "AXValue");
        let enabled = attribute_bool(element, "AXEnabled").unwrap_or(true);
        let focused = attribute_bool(element, "AXFocused").unwrap_or(false);
        let bounds = match (
            attribute_point(element, "AXPosition"),
            attribute_size(element, "AXSize"),
        ) {
            (Some(position), Some(size)) => Some(Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }),
            _ => None,
        };
        let names = action_names(element);
        let mut actions = supported_actions(&names);
        // A settable value is how text gets entered without typing into
        // whatever happens to have focus.
        if should_offer_set_value(has_value, can_set_value, enabled) {
            actions.push(ActionKind::SetValue);
        }
        if enabled
            && is_editable_text_role(&role)
            && should_offer_set_value(has_value, can_set_value, enabled)
        {
            actions.push(ActionKind::TypeText);
        }
        if enabled {
            actions.push(ActionKind::PressKeys);
            if bounds.is_some() {
                actions.extend([ActionKind::Hover, ActionKind::Drag]);
            }
        }
        let index = nodes.len();
        nodes.push(Node {
            uid: make_uid(path, &role, label.as_deref()),
            role,
            label,
            has_value,
            enabled,
            focused,
            bounds,
            parent,
            actions,
        });
        for (child_index, child) in children(element).into_iter().enumerate() {
            path.push(child_index);
            let truncated = self.walk(child.as_ref(), path, Some(index), nodes, max_nodes);
            path.pop();
            if truncated {
                return true;
            }
        }
        false
    }

    /// Re-walk a `uid` path and verify the identity digest still matches.
    fn resolve(
        &self,
        window: AXUIElementRef,
        uid: &str,
    ) -> Result<(CfOwned, Option<Rect>), DesktopError> {
        let (path, digest) = parse_uid(uid).ok_or(DesktopError::ElementNotFound)?;
        // SAFETY: the window reference is owned by the caller for this call.
        let mut current = CfOwned(unsafe { CFRetain(window) });
        for index in &path {
            let mut kids = children(current.as_ref());
            if *index >= kids.len() {
                return Err(DesktopError::ElementNotFound);
            }
            current = kids.swap_remove(*index);
        }
        let element = current.as_ref();
        let role = attribute_string(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
        let label = attribute_string(element, "AXTitle")
            .or_else(|| attribute_string(element, "AXDescription"))
            .or_else(|| attribute_string(element, "AXLabel"))
            .map(|value| value.chars().take(MAX_LABEL_CHARS).collect::<String>())
            .filter(|value| !value.trim().is_empty());
        if identity_digest(&role, label.as_deref()) != digest {
            // The position still exists but holds something else now.
            return Err(DesktopError::ElementNotFound);
        }
        let bounds = match (
            attribute_point(element, "AXPosition"),
            attribute_size(element, "AXSize"),
        ) {
            (Some(position), Some(size)) => Some(Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }),
            _ => None,
        };
        Ok((current, bounds))
    }

    fn perform_ax_action(&self, element: CFTypeRef, name: &str) -> Result<(), DesktopError> {
        let action =
            CfString::new(name).ok_or_else(|| DesktopError::Failed("action name".into()))?;
        // SAFETY: the element came from a verified walk in this same call.
        let status = unsafe { AXUIElementPerformAction(element, action.as_ref()) };
        if status == kAXErrorSuccess {
            Ok(())
        } else {
            Err(DesktopError::NotActionable)
        }
    }

    fn set_value(&self, element: CFTypeRef, text: &str) -> Result<(), DesktopError> {
        let attr =
            CfString::new("AXValue").ok_or_else(|| DesktopError::Failed("attribute".into()))?;
        let value = CfString::new(text).ok_or_else(|| DesktopError::Failed("value".into()))?;
        // SAFETY: both strings outlive the call; AX copies the value.
        let status =
            unsafe { AXUIElementSetAttributeValue(element, attr.as_ref(), value.as_ref()) };
        if status != kAXErrorSuccess {
            return Err(DesktopError::NotActionable);
        }
        let actual = attribute_string(element as AXUIElementRef, "AXValue");
        if !value_matches(text, actual.as_deref()) {
            return Err(DesktopError::Failed(
                "the target did not retain the requested value".into(),
            ));
        }
        Ok(())
    }

    /// Post one key chord to the granted process. The event never enters the
    /// HID tap, so it cannot land in another application if focus moves. Since
    /// process-directed events can still reach a second window in that process,
    /// verify the exact granted window is focused before every chord.
    fn press_keys(&self, target: &TargetRef, chords: &[String]) -> Result<(), DesktopError> {
        for chord in chords {
            let (flags, key) = parse_chord(chord).ok_or(DesktopError::NotActionable)?;
            if !self.focused_window_is_target(target)? {
                return Err(DesktopError::NotActionable);
            }
            for down in [1u8, 0u8] {
                // SAFETY: a null source is documented as "use a private
                // source"; the event is released before the next iteration.
                let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), key, down) };
                if event.is_null() {
                    return Err(DesktopError::Failed("key event".into()));
                }
                // SAFETY: the event is ours until it is released.
                unsafe {
                    CGEventSetFlags(event, flags);
                    CGEventPostToPid(target.pid, event);
                    CFRelease(event);
                }
            }
        }
        Ok(())
    }

    fn focused_window_is_target(&self, target: &TargetRef) -> Result<bool, DesktopError> {
        // SAFETY: the PID comes from the already validated Host target grant.
        let app = unsafe { AXUIElementCreateApplication(target.pid) };
        if app.is_null() {
            return Err(DesktopError::TargetGone);
        }
        let app = CfOwned(app);
        let focused =
            attribute(app.as_ref(), "AXFocusedWindow").ok_or(DesktopError::NotActionable)?;
        if let Some(matches) = window_id_matches(ax_window_id(focused.as_ref()), target.window) {
            return Ok(matches);
        }
        // Older systems may not expose the private AX window-id join key.
        // Reuse the same strict geometry/title fallback as target resolution.
        Ok(self.window_matches(focused.as_ref(), target))
    }

    fn perform_pointer_action(
        &self,
        target: &TargetRef,
        element_bounds: Option<Rect>,
        action: &Action,
    ) -> Result<(), DesktopError> {
        let window = self.measure(target)?.bounds;
        match action.kind.ok_or(DesktopError::NotActionable)? {
            ActionKind::Hover => {
                let point = match action.point {
                    Some(point) => window_relative_point(window, point)?,
                    None => {
                        let element = element_bounds.ok_or(DesktopError::NotActionable)?;
                        Point {
                            x: element.x + element.width / 2.0,
                            y: element.y + element.height / 2.0,
                        }
                    }
                };
                let hit_stack = read_window_hit_stack()?;
                if !contains_screen_point(window, point)
                    || !frontmost_window_is_target_at(&hit_stack, target, point)
                {
                    return Err(DesktopError::NotActionable);
                }
                post_mouse_event(target.pid, kCGEventMouseMoved, point)?;
            }
            ActionKind::Drag => {
                let from = window_relative_point(
                    window,
                    action.point.ok_or(DesktopError::NotActionable)?,
                )?;
                let to =
                    window_relative_point(window, action.to.ok_or(DesktopError::NotActionable)?)?;
                let path = sampled_drag_path(from, to).ok_or(DesktopError::NotActionable)?;
                let hit_stack = read_window_hit_stack()?;
                if !super::pointer_drag_points_stay_in_target(window, from, &path, |point| {
                    frontmost_window_is_target_at(&hit_stack, target, point)
                }) {
                    return Err(DesktopError::NotActionable);
                }
                post_mouse_event(target.pid, kCGEventLeftMouseDown, from)?;
                let move_result = path.iter().try_for_each(|point| {
                    post_mouse_event(target.pid, kCGEventLeftMouseDragged, *point)
                });
                // Always try to release after mouse-down, even if an injected
                // move event fails part-way through the drag.
                let release_result = post_mouse_event(target.pid, kCGEventLeftMouseUp, to);
                move_result?;
                release_result?;
            }
            _ => return Err(DesktopError::NotActionable),
        }
        Ok(())
    }
}

fn window_id_matches(actual: Option<u32>, expected: u64) -> Option<bool> {
    actual.map(|actual| u64::from(actual) == expected)
}

/// Modifier bits as `CGEventFlags`.
const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_OPTION: u64 = 0x0008_0000;
const FLAG_COMMAND: u64 = 0x0010_0000;

/// Map a chord like `cmd+a` onto flags and a virtual key code.
///
/// The accepted set is deliberately small: a key the table does not name is a
/// refusal, so a model cannot reach an arbitrary system shortcut by spelling.
fn parse_chord(chord: &str) -> Option<(u64, u16)> {
    let mut flags = 0u64;
    let mut key: Option<u16> = None;
    for part in chord.split('+') {
        let token = part.trim().to_ascii_lowercase();
        match token.as_str() {
            "" => return None,
            "cmd" | "command" | "meta" => flags |= FLAG_COMMAND,
            "shift" => flags |= FLAG_SHIFT,
            "alt" | "option" | "opt" => flags |= FLAG_OPTION,
            "ctrl" | "control" => flags |= FLAG_CONTROL,
            other => {
                if key.is_some() {
                    return None;
                }
                key = virtual_key(other);
                key?;
            }
        }
    }
    key.map(|value| (flags, value))
}

fn virtual_key(name: &str) -> Option<u16> {
    let code = match name {
        "a" => 0,
        "b" => 11,
        "c" => 8,
        "d" => 2,
        "e" => 14,
        "f" => 3,
        "g" => 5,
        "h" => 4,
        "i" => 34,
        "j" => 38,
        "k" => 40,
        "l" => 37,
        "m" => 46,
        "n" => 45,
        "o" => 31,
        "p" => 35,
        "q" => 12,
        "r" => 15,
        "s" => 1,
        "t" => 17,
        "u" => 32,
        "v" => 9,
        "w" => 13,
        "x" => 7,
        "y" => 16,
        "z" => 6,
        "0" => 29,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "5" => 23,
        "6" => 22,
        "7" => 26,
        "8" => 28,
        "9" => 25,
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        _ => return None,
    };
    Some(code)
}

impl Desktop for MacDesktop {
    fn capabilities(&self) -> Capabilities {
        let accessibility = if self.trusted() {
            PermissionState::Granted
        } else {
            // macOS does not distinguish "never asked" from "refused" here;
            // reporting `not-requested` keeps the doctor view honest, because
            // the next request is what produces the prompt or the refusal.
            PermissionState::NotRequested
        };
        Capabilities {
            platform: "darwin".into(),
            backend: "macos-ax".into(),
            fidelity: Fidelity::Full,
            accessibility,
            // The capture path is Chromium's in main, so the host reports what
            // it knows: the window list works without a capture grant.
            capture: PermissionState::NotRequested,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn request_permission(&self) -> Result<PermissionState, DesktopError> {
        if self.trusted() {
            return Ok(PermissionState::Granted);
        }
        Ok(if self.prompt_for_trust()? {
            PermissionState::Granted
        } else {
            PermissionState::NotRequested
        })
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.enumerate()
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let found = self
            .enumerate()?
            .into_iter()
            .find(|item| item.target.window == target.window && item.target.pid == target.pid)
            .ok_or(DesktopError::TargetGone)?;
        // Identity comes from the window server, geometry from accessibility.
        // The two disagree whenever the window server is showing something
        // other than the window itself — Stage Manager reports a thumbnail —
        // and every coordinate this grant will produce (element bounds, the
        // clamp, the drawn cursor, the capture crop) is in accessibility's
        // frame, so that is the frame the grant must carry.
        let bounds = self.ax_bounds(target).unwrap_or(found.bounds);
        Ok(Measured {
            bounds,
            app_key: found.target.app_key,
            title: found.title,
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        let window = self.window_element(target)?;
        let mut nodes = Vec::new();
        let mut path = Vec::new();
        let truncated = self.walk(window.as_ref(), &mut path, None, &mut nodes, max_nodes);
        Ok(RawInspection {
            nodes,
            truncated,
            fidelity: Fidelity::Full,
        })
    }

    fn secure_input_active(&self) -> bool {
        // SAFETY: the call takes no arguments and only reads global state.
        unsafe { IsSecureEventInputEnabled() != 0 }
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;
        if kind == ActionKind::PressKeys {
            let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
            // Confirm the selected window still exists before sending any keys.
            self.window_element(target)?;
            self.press_keys(target, keys)?;
            return Ok(Dispatched::WindowEvent);
        }
        let window = self.window_element(target)?;
        let uid = uid.ok_or(DesktopError::ElementNotFound)?;
        let (resolved, _bounds) = self.resolve(window.as_ref(), uid)?;
        let element = resolved.as_ref();
        match kind {
            ActionKind::Click | ActionKind::DoubleClick => {
                self.perform_ax_action(element, "AXPress")?;
                if kind == ActionKind::DoubleClick {
                    self.perform_ax_action(element, "AXPress")?;
                }
            }
            ActionKind::RightClick => self.perform_ax_action(element, "AXShowMenu")?,
            ActionKind::Select => self.perform_ax_action(element, "AXPick")?,
            ActionKind::SetValue => {
                let role =
                    attribute_string(element as AXUIElementRef, "AXRole").unwrap_or_default();
                let subrole = attribute_string(element as AXUIElementRef, "AXSubrole");
                if is_secure_text_role(&role, subrole.as_deref()) {
                    return Err(DesktopError::SecureInputRefused);
                }
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                self.set_value(element, text)?;
            }
            ActionKind::TypeText => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                text::type_text(target, element, text, || {
                    self.focused_window_is_target(target)
                })?;
                return Ok(Dispatched::WindowEvent);
            }
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                let name = if scroll.dy >= 0.0 {
                    "AXIncrement"
                } else {
                    "AXDecrement"
                };
                self.perform_ax_action(element, name)?;
            }
            ActionKind::Hover | ActionKind::Drag => {
                self.perform_pointer_action(target, _bounds, action)?;
                return Ok(Dispatched::WindowEvent);
            }
            ActionKind::PressKeys => unreachable!("handled above"),
        }
        Ok(Dispatched::AccessibilityAction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uid_round_trips_its_path_and_identity() {
        let uid = make_uid(&[0, 3, 2], "AXButton", Some("Save"));
        let (path, digest) = parse_uid(&uid).expect("parse");
        assert_eq!(path, vec![0, 3, 2]);
        assert_eq!(digest, identity_digest("AXButton", Some("Save")));
    }

    #[test]
    fn a_uid_whose_element_changed_identity_does_not_verify() {
        let uid = make_uid(&[1], "AXButton", Some("Save"));
        let (_, digest) = parse_uid(&uid).expect("parse");
        assert_ne!(digest, identity_digest("AXButton", Some("Delete")));
        assert_ne!(digest, identity_digest("AXTextField", Some("Save")));
    }

    #[test]
    fn malformed_uids_are_refused() {
        for uid in ["", "abc", "1.2", "1.x#ff", "1.2#zz", "-1#ff", "1.2#"] {
            assert!(parse_uid(uid).is_none(), "accepted {uid}");
        }
    }

    #[test]
    fn the_scope_root_has_an_empty_path() {
        // The inspection emits the window itself as a node, so its uid is a
        // digest with no path. Acting on it is allowed and simply does
        // whatever the window offers, which is usually nothing.
        let uid = make_uid(&[], "AXWindow", Some("Document"));
        let (path, _) = parse_uid(&uid).expect("root uid");
        assert!(path.is_empty());
    }

    #[test]
    fn chords_accept_known_keys_and_refuse_everything_else() {
        assert_eq!(parse_chord("cmd+a"), Some((FLAG_COMMAND, 0)));
        assert_eq!(parse_chord("Shift+Tab"), Some((FLAG_SHIFT, 48)));
        assert_eq!(parse_chord("escape"), Some((0, 53)));
        for chord in ["", "cmd", "cmd+", "cmd+a+b", "f13", "eject", "power"] {
            assert!(parse_chord(chord).is_none(), "accepted {chord}");
        }
    }

    #[test]
    fn process_directed_keys_require_the_exact_granted_window_identity() {
        assert_eq!(window_id_matches(Some(42), 42), Some(true));
        assert_eq!(window_id_matches(Some(43), 42), Some(false));
        assert_eq!(window_id_matches(None, 42), None);
    }

    #[test]
    fn pointer_actions_require_the_target_to_be_the_frontmost_window() {
        let target = TargetRef {
            target_id: "10:42".into(),
            pid: 10,
            window: 42,
            app_key: "fixture".into(),
        };
        let point = Point { x: 140.0, y: 85.0 };
        let target_window = WindowHitRegion {
            pid: 10,
            window: 42,
            bounds: Rect {
                x: 100.0,
                y: 50.0,
                width: 300.0,
                height: 200.0,
            },
            alpha: 1.0,
        };
        assert!(frontmost_window_is_target_at(
            &[target_window],
            &target,
            point
        ));

        let covering_window = WindowHitRegion {
            pid: 11,
            window: 77,
            bounds: Rect {
                x: 120.0,
                y: 60.0,
                width: 80.0,
                height: 80.0,
            },
            alpha: 1.0,
        };
        assert!(!frontmost_window_is_target_at(
            &[covering_window, target_window],
            &target,
            point
        ));
        assert!(frontmost_window_is_target_at(
            &[covering_window, target_window],
            &target,
            Point { x: 250.0, y: 120.0 }
        ));

        let window = target_window.bounds;
        let from = Point { x: 140.0, y: 85.0 };
        let clear_path = [Point { x: 250.0, y: 120.0 }];
        assert!(
            !super::super::pointer_drag_points_stay_in_target(window, from, &clear_path, |point| {
                frontmost_window_is_target_at(&[covering_window, target_window], &target, point)
            }),
            "the drag origin must also be target-bound before mouse-down"
        );
        assert!(super::super::pointer_drag_points_stay_in_target(
            window,
            Point { x: 250.0, y: 120.0 },
            &[Point { x: 280.0, y: 180.0 }],
            |point| frontmost_window_is_target_at(
                &[covering_window, target_window],
                &target,
                point
            ),
        ));
    }

    #[test]
    fn pointer_coordinates_are_window_relative_and_reject_out_of_bounds() {
        let window = Rect {
            x: -400.0,
            y: 50.0,
            width: 300.0,
            height: 200.0,
        };
        assert_eq!(
            window_relative_point(window, Point { x: 12.0, y: 34.0 }).unwrap(),
            Point { x: -388.0, y: 84.0 }
        );
        assert!(window_relative_point(window, Point { x: 301.0, y: 10.0 }).is_err());
        assert!(window_relative_point(
            window,
            Point {
                x: f64::NAN,
                y: 10.0
            }
        )
        .is_err());
    }

    #[test]
    fn drag_path_is_bounded_and_reaches_the_requested_destination() {
        let from = Point { x: -10.0, y: 0.0 };
        let to = Point { x: 110.0, y: 80.0 };
        let path = sampled_drag_path(from, to).expect("bounded path");
        assert!(path.len() > 1);
        assert!(path.last().is_some_and(|point| *point == to));
        assert!(path
            .windows(2)
            .all(|pair| { (pair[1].x - pair[0].x).hypot(pair[1].y - pair[0].y) <= 24.01 }));
        assert!(sampled_drag_path(
            Point { x: 0.0, y: 0.0 },
            Point {
                x: 100_000.0,
                y: 0.0
            }
        )
        .is_none());
    }

    #[test]
    fn ax_actions_map_to_our_kinds() {
        let names = vec!["AXPress".to_string(), "AXShowMenu".to_string()];
        let actions = supported_actions(&names);
        assert!(actions.contains(&ActionKind::Click));
        assert!(actions.contains(&ActionKind::RightClick));
        assert!(
            !actions.contains(&ActionKind::SetValue),
            "value comes from AXValue, not an action"
        );
    }

    #[test]
    fn set_value_is_advertised_only_for_enabled_settable_ax_values() {
        assert!(should_offer_set_value(true, true, true));
        assert!(!should_offer_set_value(true, false, true));
        assert!(!should_offer_set_value(false, true, true));
        assert!(!should_offer_set_value(true, true, false));
    }

    #[test]
    fn set_value_reports_success_only_after_matching_ax_readback() {
        assert!(value_matches("hello", Some("hello")));
        assert!(!value_matches("hello", Some("other")));
        assert!(!value_matches("hello", None));
    }
}
