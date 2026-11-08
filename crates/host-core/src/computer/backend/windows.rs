use std::collections::hash_map::DefaultHasher;
use std::ffi::c_void;
use std::hash::{Hash, Hasher};

use windows::core::{Interface, BOOL, BSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationElementArray,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    ScrollAmount, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement, ScrollAmount_SmallIncrement,
    TreeScope_Subtree, UIA_ExpandCollapsePatternId, UIA_InvokePatternId, UIA_ScrollPatternId,
    UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsChild, IsWindowVisible,
    PostMessageW, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_RBUTTONDOWN, WM_RBUTTONUP,
};

use super::{Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef};
use crate::computer::{Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Rect};

const MAX_TREE_NODES: usize = 400;
const UIA_TIMEOUT_MS: u32 = 2_000;
const MOD_CONTROL: u8 = 0x02;
const MOD_SHIFT: u8 = 0x01;
const MOD_ALT: u8 = 0x04;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyChord {
    modifiers: u8,
    virtual_key: u16,
}

pub struct WindowsDesktop;

impl WindowsDesktop {
    pub fn new() -> Self {
        Self
    }

    fn enumerate(&self) -> Result<Vec<RawTarget>, DesktopError> {
        let mut targets = Vec::new();
        let context = &mut targets as *mut Vec<RawTarget>;
        // SAFETY: the callback is synchronous; `context` points to the live
        // vector for the duration of EnumWindows and is not retained by Win32.
        unsafe { EnumWindows(Some(collect_window), LPARAM(context as isize)) }
            .map_err(|_| DesktopError::Failed("window enumeration failed".into()))?;
        Ok(targets)
    }

    fn automation(&self) -> Result<(ComApartment, IUIAutomation), DesktopError> {
        let apartment = ComApartment::initialize()?;
        // SAFETY: CUIAutomation8 is an in-process COM class; CoCreateInstance
        // returns an owned interface whose lifetime is bound to this call.
        let automation: IUIAutomation = unsafe {
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| DesktopError::Unsupported)?
        };
        // IUIAutomation2 exposes provider connection/transaction timeouts.
        // If the OS lacks that interface, fail closed rather than leave Host
        // calls unbounded.
        let automation2: IUIAutomation2 =
            automation.cast().map_err(|_| DesktopError::Unsupported)?;
        unsafe {
            automation2
                .SetConnectionTimeout(UIA_TIMEOUT_MS)
                .map_err(map_uia_error)?;
            automation2
                .SetTransactionTimeout(UIA_TIMEOUT_MS)
                .map_err(map_uia_error)?;
        }
        Ok((apartment, automation))
    }

    fn bound_window(&self, target: &TargetRef) -> Result<HWND, DesktopError> {
        let hwnd = hwnd_from_u64(target.window);
        if hwnd.0.is_null() || !is_window_visible(hwnd) {
            return Err(DesktopError::TargetGone);
        }
        let mut pid = 0u32;
        // SAFETY: `hwnd` is a handle minted by this backend's enumeration.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid as i32 != target.pid || process_app_key(pid).as_deref() != Some(&target.app_key) {
            return Err(DesktopError::TargetGone);
        }
        let host_integrity = process_integrity_level(unsafe { GetCurrentProcess() })
            .ok_or(DesktopError::Elevated)?;
        let target_integrity =
            process_integrity_level_for_pid(pid).ok_or(DesktopError::Elevated)?;
        if target_integrity_is_higher(host_integrity, target_integrity) {
            return Err(DesktopError::Elevated);
        }
        Ok(hwnd)
    }

    fn root_element(
        &self,
        automation: &IUIAutomation,
        target: &TargetRef,
    ) -> Result<IUIAutomationElement, DesktopError> {
        let hwnd = self.bound_window(target)?;
        // SAFETY: UIA validates the live HWND and returns an owned COM proxy.
        unsafe { automation.ElementFromHandle(hwnd) }.map_err(map_uia_error)
    }

    fn elements(
        &self,
        automation: &IUIAutomation,
        target: &TargetRef,
    ) -> Result<(Rect, IUIAutomationElementArray), DesktopError> {
        let measured = self.measure(target)?;
        let root = self.root_element(automation, target)?;
        // SAFETY: the condition is created by this UIA client and is valid for
        // the synchronous descendant query.
        let condition = unsafe { automation.CreateTrueCondition() }.map_err(map_uia_error)?;
        // SAFETY: result is an owned UIA array; the fixed cap is applied below
        // before elements are transferred to transcript/model context.
        let array =
            unsafe { root.FindAll(TreeScope_Subtree, &condition) }.map_err(map_uia_error)?;
        Ok((measured.bounds, array))
    }

    fn node_for(
        &self,
        element: &IUIAutomationElement,
        index: usize,
        target: &TargetRef,
        target_bounds: Rect,
        allow_sensitive_input: bool,
    ) -> Result<Node, DesktopError> {
        // UIA may stop responding when an app exits mid-query. Each property
        // is individually fallible; absent identity/geometry yields a stable
        // but non-actionable node rather than guessed data.
        let role_id = unsafe { element.CurrentControlType() }
            .map(|value| value.0)
            .unwrap_or(0);
        let role = control_type_name(role_id).to_string();
        let name = unsafe { element.CurrentName() }
            .ok()
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty());
        let belongs_to_target = self.target_element_hwnd(element, target).is_some();
        let password = unsafe { element.CurrentIsPassword() }
            .map(|value| value.as_bool())
            .unwrap_or(true);
        let rect = unsafe { element.CurrentBoundingRectangle() }
            .ok()
            .map(|value| relative_rect(value, target_bounds))
            .filter(|_| belongs_to_target);
        let enabled = unsafe { element.CurrentIsEnabled() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let focused = unsafe { element.CurrentHasKeyboardFocus() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        let has_value =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
                .is_ok();
        let mut actions = Vec::new();
        if node_is_exposable(belongs_to_target, password, allow_sensitive_input) {
            if unsafe {
                element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            }
            .is_ok()
            {
                actions.extend([ActionKind::Click, ActionKind::DoubleClick]);
            }
            if unsafe {
                element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            }
            .is_ok()
            {
                actions.push(ActionKind::Click);
            }
            if unsafe {
                element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
            }
            .is_ok()
            {
                actions.push(ActionKind::Select);
            }
            if unsafe {
                element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )
            }
            .is_ok()
            {
                actions.push(ActionKind::Click);
            }
            if unsafe {
                element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
            }
            .is_ok()
            {
                actions.push(ActionKind::Scroll);
            }
            if has_value {
                actions.push(ActionKind::SetValue);
            }
            // The final ownership/password check is repeated at dispatch time.
            actions.push(ActionKind::PressKeys);
        }
        let fingerprint = node_fingerprint(index, role_id, name.as_deref(), rect);
        Ok(Node {
            uid: fingerprint,
            role,
            label: if (password && !allow_sensitive_input) || !belongs_to_target {
                None
            } else {
                name
            },
            has_value: belongs_to_target && (has_value || password),
            enabled: enabled && belongs_to_target,
            focused: focused && belongs_to_target,
            bounds: rect,
            parent: None,
            actions,
        })
    }

    fn find_element(
        &self,
        automation: &IUIAutomation,
        target: &TargetRef,
        uid: &str,
        allow_sensitive_input: bool,
    ) -> Result<IUIAutomationElement, DesktopError> {
        let (bounds, array) = self.elements(automation, target)?;
        let count = unsafe { array.Length() }.map_err(map_uia_error)?.max(0) as usize;
        let count = count.min(MAX_TREE_NODES);
        for index in 0..count {
            let element = unsafe { array.GetElement(index as i32) }.map_err(map_uia_error)?;
            if self
                .node_for(&element, index, target, bounds, allow_sensitive_input)?
                .uid
                == uid
            {
                return Ok(element);
            }
        }
        Err(DesktopError::ElementNotFound)
    }

    fn target_element_for_action(
        &self,
        automation: &IUIAutomation,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
        allow_sensitive_input: bool,
    ) -> Result<IUIAutomationElement, DesktopError> {
        if let Some(uid) = uid {
            return self.find_element(automation, target, uid, allow_sensitive_input);
        }
        let point = action.point.ok_or(DesktopError::NotActionable)?;
        let bounds = self.measure(target)?.bounds;
        let point = POINT {
            x: (bounds.x + point.x).round() as i32,
            y: (bounds.y + point.y).round() as i32,
        };
        // SAFETY: coordinates have already been range-checked against the
        // current bound window by policy::act; UIA resolves the current element.
        let element = unsafe { automation.ElementFromPoint(point) }.map_err(map_uia_error)?;
        self.validate_element_owner(&element, target, allow_sensitive_input)?;
        Ok(element)
    }

    fn validate_element_owner(
        &self,
        element: &IUIAutomationElement,
        target: &TargetRef,
        allow_sensitive_input: bool,
    ) -> Result<HWND, DesktopError> {
        let hwnd = self
            .target_element_hwnd(element, target)
            .ok_or(DesktopError::ElementNotFound)?;
        if !allow_sensitive_input
            && unsafe { element.CurrentIsPassword() }
                .map(|value| value.as_bool())
                .unwrap_or(true)
        {
            return Err(DesktopError::SecureInputRefused);
        }
        Ok(hwnd)
    }

    fn target_element_hwnd(
        &self,
        element: &IUIAutomationElement,
        target: &TargetRef,
    ) -> Option<HWND> {
        let (hwnd, pid) = self_element_hwnd(element)?;
        let target_hwnd = hwnd_from_u64(target.window);
        let is_descendant = unsafe { IsChild(target_hwnd, hwnd) }.as_bool();
        element_belongs_to_target(
            hwnd.0 as usize,
            pid,
            target.window as usize,
            target.pid as u32,
            is_descendant,
        )
        .then_some(hwnd)
    }

    fn click_targeted(
        &self,
        element: &IUIAutomationElement,
        hwnd: HWND,
        target: &TargetRef,
        kind: ActionKind,
    ) -> Result<(), DesktopError> {
        let bounds = unsafe { element.CurrentBoundingRectangle() }.map_err(map_uia_error)?;
        let mut point = POINT {
            x: bounds.left + (bounds.right - bounds.left) / 2,
            y: bounds.top + (bounds.bottom - bounds.top) / 2,
        };
        let mut owner = 0u32;
        // SAFETY: both native window handles are already bound to the validated
        // target; point conversion stays local to that HWND.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
        if owner != target.pid as u32 {
            return Err(DesktopError::ElementNotFound);
        }
        if !unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
            return Err(DesktopError::TargetGone);
        }
        let packed = make_lparam(point.x, point.y);
        // SAFETY: messages are posted to the element's HWND, after owner PID
        // validation; no global cursor or input queue is used.
        unsafe {
            match kind {
                ActionKind::RightClick => {
                    PostMessageW(Some(hwnd), WM_RBUTTONDOWN, WPARAM(2), packed)
                        .map_err(map_uia_error)?;
                    PostMessageW(Some(hwnd), WM_RBUTTONUP, WPARAM(0), packed)
                        .map_err(map_uia_error)?;
                }
                ActionKind::DoubleClick => {
                    PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), packed)
                        .map_err(map_uia_error)?;
                    PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), packed)
                        .map_err(map_uia_error)?;
                    PostMessageW(Some(hwnd), WM_LBUTTONDBLCLK, WPARAM(1), packed)
                        .map_err(map_uia_error)?;
                    PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), packed)
                        .map_err(map_uia_error)?;
                }
                _ => {
                    PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), packed)
                        .map_err(map_uia_error)?;
                    PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), packed)
                        .map_err(map_uia_error)?;
                }
            }
        }
        Ok(())
    }
}

impl Desktop for WindowsDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: "win32".into(),
            backend: "windows-uia".into(),
            fidelity: Fidelity::Partial,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.enumerate()
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let hwnd = self.bound_window(target)?;
        let mut rect = RECT::default();
        // SAFETY: `hwnd` has just been revalidated against the enumerated PID
        // and executable identity.
        unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(map_uia_error)?;
        let title = window_title(hwnd);
        let app_key = process_app_key(target.pid as u32).ok_or(DesktopError::TargetGone)?;
        Ok(Measured {
            bounds: Rect {
                x: rect.left as f64,
                y: rect.top as f64,
                width: (rect.right - rect.left).max(0) as f64,
                height: (rect.bottom - rect.top).max(0) as f64,
            },
            app_key,
            title,
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        self.inspect_with_sensitive_input(target, max_nodes, false)
    }

    fn inspect_with_sensitive_input(
        &self,
        target: &TargetRef,
        max_nodes: usize,
        allow_sensitive_input: bool,
    ) -> Result<RawInspection, DesktopError> {
        if !allow_sensitive_input && self.secure_input_active() {
            return Err(DesktopError::SecureInputRefused);
        }
        let (_apartment, automation) = self.automation()?;
        let (bounds, array) = self.elements(&automation, target)?;
        let count = unsafe { array.Length() }.map_err(map_uia_error)?.max(0) as usize;
        let limit = max_nodes.min(MAX_TREE_NODES);
        let mut nodes = Vec::with_capacity(count.min(limit));
        for index in 0..count.min(limit) {
            let element = unsafe { array.GetElement(index as i32) }.map_err(map_uia_error)?;
            nodes.push(self.node_for(&element, index, target, bounds, allow_sensitive_input)?);
        }
        Ok(RawInspection {
            nodes,
            truncated: count > limit,
            fidelity: Fidelity::Partial,
        })
    }

    fn secure_input_active(&self) -> bool {
        if secure_desktop_is_active(input_desktop_name().as_deref()) {
            return true;
        }
        let Ok((_apartment, automation)) = self.automation() else {
            return true;
        };
        // A focused password element is a hard refusal. If Windows or UIA
        // cannot answer, fail closed rather than type into an unknown field.
        let Ok(focused) = (unsafe { automation.GetFocusedElement() }) else {
            return true;
        };
        unsafe { focused.CurrentIsPassword() }
            .map(|value| value.as_bool())
            .unwrap_or(true)
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        self.perform_with_sensitive_input(target, uid, action, false)
    }

    fn perform_with_sensitive_input(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
        allow_sensitive_input: bool,
    ) -> Result<Dispatched, DesktopError> {
        if !allow_sensitive_input && self.secure_input_active() {
            return Err(DesktopError::SecureInputRefused);
        }
        let (_apartment, automation) = self.automation()?;
        let element = self.target_element_for_action(
            &automation,
            target,
            uid,
            action,
            allow_sensitive_input,
        )?;
        let hwnd = self.validate_element_owner(&element, target, allow_sensitive_input)?;
        let kind = action.kind.ok_or(DesktopError::NotActionable)?;
        match kind {
            ActionKind::SetValue => {
                let value = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                let pattern = unsafe {
                    element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                }
                .map_err(|_| DesktopError::NotActionable)?;
                let value = BSTR::from(value);
                // SAFETY: UIA owns the target provider and copies the BSTR for
                // this synchronous ValuePattern call.
                unsafe { pattern.SetValue(&value) }.map_err(map_uia_error)?;
            }
            ActionKind::Click | ActionKind::DoubleClick | ActionKind::RightClick => {
                if kind != ActionKind::RightClick {
                    if let Ok(pattern) = unsafe {
                        element
                            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    } {
                        // SAFETY: the Invoke pattern is returned by the same
                        // element whose owner was verified above.
                        unsafe { pattern.Invoke() }.map_err(map_uia_error)?;
                        if kind == ActionKind::DoubleClick {
                            unsafe { pattern.Invoke() }.map_err(map_uia_error)?;
                        }
                        return Ok(Dispatched::AccessibilityAction);
                    }
                    if let Ok(pattern) = unsafe {
                        element
                            .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    } {
                        unsafe { pattern.Toggle() }.map_err(map_uia_error)?;
                        return Ok(Dispatched::AccessibilityAction);
                    }
                }
                self.click_targeted(&element, hwnd, target, kind)?;
                return Ok(Dispatched::WindowEvent);
            }
            ActionKind::PressKeys => {
                let keys = action.keys.as_ref().ok_or(DesktopError::NotActionable)?;
                // Focus only the target UIA element; never use SendInput or
                // mutate the system cursor. Messages are sent to its own HWND.
                unsafe { element.SetFocus() }.map_err(map_uia_error)?;
                for chord in keys {
                    let chord = parse_key_chord(chord).ok_or(DesktopError::NotActionable)?;
                    post_key_chord(hwnd, chord)?;
                }
                return Ok(Dispatched::WindowEvent);
            }
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                let pattern = unsafe {
                    element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                }
                .map_err(|_| DesktopError::NotActionable)?;
                let horizontal = scroll_amount(scroll.dx);
                let vertical = scroll_amount(scroll.dy);
                unsafe { pattern.Scroll(horizontal, vertical) }.map_err(map_uia_error)?;
            }
            ActionKind::Select => {
                let option = action
                    .option
                    .as_deref()
                    .ok_or(DesktopError::NotActionable)?;
                let (_, array) = self.elements(&automation, target)?;
                let count = unsafe { array.Length() }.map_err(map_uia_error)?.max(0) as usize;
                let mut selected = false;
                for index in 0..count.min(MAX_TREE_NODES) {
                    let candidate =
                        unsafe { array.GetElement(index as i32) }.map_err(map_uia_error)?;
                    if unsafe { candidate.CurrentName() }
                        .map(|name| name.iter().copied().eq(option.encode_utf16()))
                        .unwrap_or(false)
                    {
                        if let Ok(pattern) = unsafe {
                            candidate.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                                UIA_SelectionItemPatternId,
                            )
                        } {
                            self.validate_element_owner(&candidate, target, allow_sensitive_input)?;
                            unsafe { pattern.Select() }.map_err(map_uia_error)?;
                            selected = true;
                            break;
                        }
                    }
                }
                if !selected {
                    return Err(DesktopError::NotActionable);
                }
            }
        }
        Ok(Dispatched::AccessibilityAction)
    }
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> Result<Self, DesktopError> {
        // SAFETY: every backend operation initializes COM on its current
        // worker thread and releases exactly one successful initialization.
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            return Err(DesktopError::Failed(
                "COM apartment initialization failed".into(),
            ));
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: paired with the successful CoInitializeEx above.
        unsafe { CoUninitialize() };
    }
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: EnumWindows passes the pointer created by enumerate() and calls
    // this callback synchronously before enumerate() returns.
    let targets = unsafe { &mut *(lparam.0 as *mut Vec<RawTarget>) };
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return BOOL(1);
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err()
        || rect.right <= rect.left
        || rect.bottom <= rect.top
    {
        return BOOL(1);
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return BOOL(1);
    }
    let Some(app_key) = process_app_key(pid) else {
        return BOOL(1);
    };
    let app_name = app_key.clone();
    let elevated = match (
        process_integrity_level(unsafe { GetCurrentProcess() }),
        process_integrity_level_for_pid(pid),
    ) {
        (Some(host), Some(target)) => target_integrity_is_higher(host, target),
        _ => true,
    };
    targets.push(RawTarget {
        target: TargetRef {
            target_id: format!("{}:{}", pid, hwnd.0 as usize),
            pid: pid as i32,
            window: hwnd.0 as usize as u64,
            app_key,
        },
        app_name,
        title: window_title(hwnd),
        bounds: Rect {
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right - rect.left) as f64,
            height: (rect.bottom - rect.top) as f64,
        },
        elevated,
    });
    BOOL(1)
}

fn process_app_key(pid: u32) -> Option<String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    let mut buffer = [0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is writable UTF-16 storage, and `process` was opened
    // only for query access.
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    let _ = unsafe { CloseHandle(process) };
    result.ok()?;
    let path = String::from_utf16(&buffer[..length as usize]).ok()?;
    let name = std::path::Path::new(&path)
        .file_name()?
        .to_string_lossy()
        .to_string();
    Some(name.to_ascii_lowercase())
}

fn process_integrity_level_for_pid(pid: u32) -> Option<u32> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    let integrity = process_integrity_level(process);
    let _ = unsafe { CloseHandle(process) };
    integrity
}

fn process_integrity_level(process: HANDLE) -> Option<u32> {
    let mut token = HANDLE::default();
    // SAFETY: OpenProcessToken writes one owned handle on success.
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let mut required = 0u32;
    // SAFETY: a null output buffer is the documented size-query form.
    let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut required) };
    if required < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 || required > 64 * 1024 {
        let _ = unsafe { CloseHandle(token) };
        return None;
    }
    let words = (required as usize).div_ceil(std::mem::size_of::<u64>());
    let mut buffer = vec![0u64; words];
    // SAFETY: the aligned allocation is at least the size requested by the OS,
    // and the token API initializes exactly `required` bytes.
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            required,
            &mut required,
        )
    };
    let integrity = if result.is_ok() {
        // SAFETY: GetTokenInformation populated a TOKEN_MANDATORY_LABEL at the
        // start of the aligned buffer on success.
        let label = unsafe { &*(buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()) };
        let count = unsafe { GetSidSubAuthorityCount(label.Label.Sid) };
        if count.is_null() || unsafe { *count } == 0 {
            None
        } else {
            let rid = unsafe { GetSidSubAuthority(label.Label.Sid, (*count as u32) - 1) };
            (!rid.is_null()).then(|| unsafe { *rid })
        }
    } else {
        None
    };
    let _ = unsafe { CloseHandle(token) };
    integrity
}

fn target_integrity_is_higher(host: u32, target: u32) -> bool {
    target > host
}

fn node_is_exposable(belongs_to_target: bool, password: bool, allow_sensitive_input: bool) -> bool {
    belongs_to_target && (!password || allow_sensitive_input)
}

fn window_title(hwnd: HWND) -> String {
    let mut title = [0u16; 2_048];
    // SAFETY: `title` is writable UTF-16 storage and `hwnd` came from the
    // current window enumeration or a just-validated target.
    let length = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
    String::from_utf16_lossy(&title[..length.min(title.len())])
}

fn is_window_visible(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd) }.as_bool()
}

fn hwnd_from_u64(value: u64) -> HWND {
    HWND(value as usize as *mut c_void)
}

fn self_element_hwnd(element: &IUIAutomationElement) -> Option<(HWND, u32)> {
    let hwnd = unsafe { element.CurrentNativeWindowHandle() }.ok()?;
    if hwnd.0.is_null() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    Some((hwnd, pid))
}

fn element_belongs_to_target(
    hwnd: usize,
    pid: u32,
    target_hwnd: usize,
    target_pid: u32,
    is_descendant: bool,
) -> bool {
    hwnd != 0 && pid != 0 && pid == target_pid && (hwnd == target_hwnd || is_descendant)
}

fn input_desktop_name() -> Option<String> {
    let desktop =
        unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS).ok()? };
    let mut name = [0u16; 256];
    // SAFETY: a live desktop handle and writable buffer are supplied. The
    // returned name is copied before closing the handle.
    let result = unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast::<c_void>()),
            std::mem::size_of_val(&name) as u32,
            None,
        )
    };
    let _ = unsafe { CloseDesktop(desktop) };
    result.ok()?;
    let length = name
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(name.len());
    Some(String::from_utf16_lossy(&name[..length]))
}

fn secure_desktop_is_active(name: Option<&str>) -> bool {
    !name.is_some_and(|value| value.eq_ignore_ascii_case("Default"))
}

fn parse_key_chord(input: &str) -> Option<KeyChord> {
    let parts = input.split('+').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let mut modifiers = 0u8;
    for modifier in &parts[..parts.len() - 1] {
        let bit = match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => MOD_CONTROL,
            "shift" => MOD_SHIFT,
            "alt" => MOD_ALT,
            // Deliberately reject Win/Cmd system shortcuts.
            _ => return None,
        };
        if modifiers & bit != 0 {
            return None;
        }
        modifiers |= bit;
    }
    let key = virtual_key(parts[parts.len() - 1])?;
    Some(KeyChord {
        modifiers,
        virtual_key: key,
    })
}

fn virtual_key(key: &str) -> Option<u16> {
    let key = key.to_ascii_lowercase();
    if key.len() == 1 {
        let byte = key.as_bytes()[0];
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            return Some(byte.to_ascii_uppercase() as u16);
        }
    }
    Some(match key.as_str() {
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        _ if key.starts_with('f') => {
            let n = key[1..].parse::<u16>().ok()?;
            if !(1..=12).contains(&n) {
                return None;
            }
            0x6F + n
        }
        _ => return None,
    })
}

fn post_key_chord(hwnd: HWND, chord: KeyChord) -> Result<(), DesktopError> {
    let modifiers = [
        (MOD_CONTROL, 0x11u16),
        (MOD_SHIFT, 0x10u16),
        (MOD_ALT, 0x12u16),
    ];
    // SAFETY: this HWND was just validated against the target's process and
    // remains the sole recipient; no global keyboard API is used.
    unsafe {
        for (flag, key) in modifiers {
            if chord.modifiers & flag != 0 {
                PostMessageW(Some(hwnd), WM_KEYDOWN, WPARAM(key as usize), LPARAM(1))
                    .map_err(map_uia_error)?;
            }
        }
        PostMessageW(
            Some(hwnd),
            WM_KEYDOWN,
            WPARAM(chord.virtual_key as usize),
            LPARAM(1),
        )
        .map_err(map_uia_error)?;
        PostMessageW(
            Some(hwnd),
            WM_KEYUP,
            WPARAM(chord.virtual_key as usize),
            LPARAM(1isize << 30 | 1isize << 31),
        )
        .map_err(map_uia_error)?;
        for (flag, key) in modifiers.into_iter().rev() {
            if chord.modifiers & flag != 0 {
                PostMessageW(
                    Some(hwnd),
                    WM_KEYUP,
                    WPARAM(key as usize),
                    LPARAM(1isize << 30 | 1isize << 31),
                )
                .map_err(map_uia_error)?;
            }
        }
    }
    Ok(())
}

fn node_fingerprint(index: usize, role: i32, name: Option<&str>, bounds: Option<Rect>) -> String {
    let mut hasher = DefaultHasher::new();
    index.hash(&mut hasher);
    role.hash(&mut hasher);
    name.unwrap_or_default().hash(&mut hasher);
    bounds
        .map(|rect| [rect.x, rect.y, rect.width, rect.height].map(f64::to_bits))
        .hash(&mut hasher);
    format!("w:{index:x}:{:016x}", hasher.finish())
}

fn control_type_name(value: i32) -> &'static str {
    match value {
        50000 => "button",
        50002 => "calendar",
        50003 => "checkbox",
        50004 => "combo-box",
        50005 => "edit",
        50006 => "hyperlink",
        50007 => "image",
        50008 => "list-item",
        50009 => "list",
        50010 => "menu",
        50011 => "menu-bar",
        50012 => "menu-item",
        50013 => "progress-bar",
        50014 => "radio-button",
        50015 => "scroll-bar",
        50016 => "slider",
        50017 => "spinner",
        50018 => "status-bar",
        50019 => "tab",
        50020 => "tab-item",
        50021 => "text",
        50022 => "tool-bar",
        50023 => "tool-tip",
        50024 => "tree",
        50025 => "tree-item",
        50026 => "custom",
        50027 => "group",
        50028 => "thumb",
        50029 => "data-grid",
        50030 => "data-item",
        50031 => "document",
        50032 => "split-button",
        50033 => "window",
        50034 => "pane",
        50035 => "header",
        50036 => "header-item",
        50037 => "table",
        50038 => "title-bar",
        50039 => "separator",
        _ => "unknown",
    }
}

fn relative_rect(value: RECT, target: Rect) -> Rect {
    Rect {
        x: (value.left as f64 - target.x).max(0.0),
        y: (value.top as f64 - target.y).max(0.0),
        width: (value.right - value.left).max(0) as f64,
        height: (value.bottom - value.top).max(0) as f64,
    }
}

fn scroll_amount(value: f64) -> ScrollAmount {
    if value > 0.0 {
        ScrollAmount_SmallIncrement
    } else if value < 0.0 {
        ScrollAmount_SmallDecrement
    } else {
        ScrollAmount_NoAmount
    }
}

fn make_lparam(x: i32, y: i32) -> LPARAM {
    LPARAM(((y as u32 as u64) << 16 | (x as u16 as u64)) as isize)
}

fn map_uia_error(_error: impl std::fmt::Debug) -> DesktopError {
    DesktopError::Failed("Windows UI Automation operation failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_window_scoped_key_chords() {
        assert_eq!(
            parse_key_chord("ctrl+shift+a"),
            Some(KeyChord {
                modifiers: MOD_CONTROL | MOD_SHIFT,
                virtual_key: 0x41,
            })
        );
        assert_eq!(parse_key_chord("win+r"), None);
        assert_eq!(parse_key_chord("ctrl+alt+shift+a"), None);
    }

    #[test]
    fn element_hwnd_must_still_belong_to_bound_process() {
        assert!(element_belongs_to_target(100, 42, 100, 42, false));
        assert!(element_belongs_to_target(101, 42, 100, 42, true));
        assert!(!element_belongs_to_target(101, 42, 100, 42, false));
        assert!(!element_belongs_to_target(100, 43, 100, 42, true));
        assert!(!element_belongs_to_target(0, 42, 100, 42, true));
    }

    #[test]
    fn unknown_secure_desktop_state_fails_closed() {
        assert!(secure_desktop_is_active(None));
        assert!(secure_desktop_is_active(Some("Winlogon")));
        assert!(!secure_desktop_is_active(Some("Default")));
    }

    #[test]
    fn uia_factory_supports_bounded_calls_on_windows() {
        let (_apartment, automation) = WindowsDesktop
            .automation()
            .expect("CUIAutomation8 should provide IUIAutomation2");
        let timeout = automation
            .cast::<IUIAutomation2>()
            .expect("IUIAutomation2 is required to bound provider calls");
        unsafe {
            timeout
                .SetConnectionTimeout(UIA_TIMEOUT_MS)
                .expect("set UIA connection timeout");
            timeout
                .SetTransactionTimeout(UIA_TIMEOUT_MS)
                .expect("set UIA transaction timeout");
        }
    }

    #[test]
    fn only_a_strictly_higher_integrity_target_is_refused() {
        assert!(!target_integrity_is_higher(0x2000, 0x2000));
        assert!(!target_integrity_is_higher(0x3000, 0x2000));
        assert!(target_integrity_is_higher(0x2000, 0x3000));
    }

    #[test]
    fn only_non_password_nodes_owned_by_the_bound_window_are_exposed() {
        assert!(node_is_exposable(true, false, false));
        assert!(!node_is_exposable(false, false, true));
        assert!(!node_is_exposable(true, true, false));
        assert!(node_is_exposable(true, true, true));
        assert!(!node_is_exposable(false, true, true));
    }
}
