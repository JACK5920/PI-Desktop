use std::collections::hash_map::DefaultHasher;
use std::ffi::c_void;
use std::hash::{Hash, Hasher};
use std::thread;
use std::time::{Duration, Instant};

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
    IUIAutomationSelectionItemPattern, IUIAutomationSelectionPattern, IUIAutomationTogglePattern,
    IUIAutomationValuePattern, ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement,
    ScrollAmount_NoAmount, TreeScope_Subtree, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
    UIA_ScrollPatternId, UIA_SelectionItemPatternId, UIA_SelectionPatternId, UIA_TogglePatternId,
    UIA_ValuePatternId,
};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetDlgCtrlID, GetForegroundWindow, GetParent,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsChild, IsWindowVisible,
    PostMessageW, SendMessageW, SetForegroundWindow, CB_FINDSTRINGEXACT, CB_GETCURSEL,
    CB_GETLBTEXT, CB_SHOWDROPDOWN, GA_ROOT, LB_FINDSTRINGEXACT, LB_GETCOUNT, LB_GETCURSEL,
    LB_GETTEXT, LB_SETCURSEL, WM_COMMAND, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP,
};

use super::{Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef};
use crate::computer::{
    Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Point, Rect,
};

const MAX_TREE_NODES: usize = 400;
const UIA_TIMEOUT_MS: u32 = 2_000;
const MOD_CONTROL: u8 = 0x02;
const MOD_SHIFT: u8 = 0x01;
const MOD_ALT: u8 = 0x04;

#[derive(Debug, Clone, PartialEq, Eq)]
struct KeyChord {
    modifiers: u8,
    virtual_key: u16,
    literal: Option<Vec<u16>>,
}

pub struct WindowsDesktop;

impl WindowsDesktop {
    pub fn new() -> Self {
        Self
    }

    fn enumerate(&self) -> Result<Vec<RawTarget>, DesktopError> {
        let _dpi_context = PerMonitorDpiContext::enter()?;
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
        let platform_role_id = unsafe { element.CurrentControlType() }
            .map(|value| value.0)
            .unwrap_or(0);
        // Some providers expose native Win32 controls as generic Panes. When
        // that happens, recover only well-known roles from the control's own
        // native class and patterns; never infer from a label or a parent.
        let target_control_hwnd = self.target_element_hwnd(element, target);
        let class_name = target_control_hwnd.map(window_class_name);
        let toggle_pattern = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        }
        .is_ok();
        let role_id =
            semantic_control_type(platform_role_id, class_name.as_deref(), toggle_pattern);
        let role = control_type_name(role_id).to_string();
        let name = unsafe { element.CurrentName() }
            .ok()
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty());
        let belongs_to_target = target_control_hwnd.is_some();
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
                actions.push(ActionKind::Click);
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
                || (belongs_to_target
                    && (is_combo_box_element(&element) || is_list_box_element(&element)))
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
            if rect.is_some() {
                // These operations have a window-scoped message fallback when
                // the provider does not expose an equivalent UIA pattern.
                actions.extend([
                    ActionKind::Click,
                    ActionKind::DoubleClick,
                    ActionKind::RightClick,
                    ActionKind::Hover,
                    ActionKind::Drag,
                ]);
            }
            if rect.is_some() && matches!(role_id, 50003 | 50004 | 50030) {
                actions.push(ActionKind::TypeText);
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
        let directly_owned = element_belongs_to_target(
            hwnd.0 as usize,
            pid,
            target.window as usize,
            target.pid as u32,
            is_descendant,
        );
        // UIA providers for an expanded ComboBox may report its dropdown
        // popup HWND instead of the combo's child HWND. Because this element
        // came from the bound window's UIA subtree, allow that specific
        // control type when the popup is still owned by the same process.
        // Do not grant the same exception to arbitrary controls/windows.
        let combo_popup = unsafe { element.CurrentControlType() }
            .is_ok_and(|control_type| control_type.0 == 50003)
            && pid == target.pid as u32;
        (directly_owned || combo_popup).then_some(hwnd)
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

    fn resolve_target(&self, target_id: &str) -> Result<Option<RawTarget>, DesktopError> {
        let _dpi_context = PerMonitorDpiContext::enter()?;
        let mut parts = target_id.splitn(3, ':');
        let (Some(pid_text), Some(hwnd_text), Some(expected_app_key)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Ok(None);
        };
        let (Ok(pid), Ok(hwnd_value)) = (pid_text.parse::<u32>(), hwnd_text.parse::<usize>())
        else {
            return Ok(None);
        };
        if pid == 0
            || hwnd_value == 0
            || format!("{pid}:{hwnd_value}:{expected_app_key}") != target_id
        {
            return Ok(None);
        }
        let hwnd = hwnd_from_u64(hwnd_value as u64);
        if !is_window_visible(hwnd) || unsafe { GetAncestor(hwnd, GA_ROOT) }.0 != hwnd.0 {
            return Ok(None);
        }
        let mut actual_pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut actual_pid)) };
        if actual_pid != pid {
            return Ok(None);
        }
        Ok(raw_target_for_window(hwnd).filter(|target| target.target.app_key == expected_app_key))
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let _dpi_context = PerMonitorDpiContext::enter()?;
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
        let _dpi_context = PerMonitorDpiContext::enter()?;
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
        let Ok(_dpi_context) = PerMonitorDpiContext::enter() else {
            return true;
        };
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
        let _dpi_context = PerMonitorDpiContext::enter()?;
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
                let expected = value;
                let value = BSTR::from(value);
                // SAFETY: UIA owns the target provider and copies the BSTR for
                // this synchronous ValuePattern call.
                unsafe { pattern.SetValue(&value) }.map_err(map_uia_error)?;
                let actual = unsafe { pattern.CurrentValue() }.map_err(map_uia_error)?;
                if actual.to_string() != expected {
                    return Err(DesktopError::Failed(
                        "the target did not retain the requested value".into(),
                    ));
                }
            }
            ActionKind::TypeText => {
                let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
                unsafe { element.SetFocus() }.map_err(map_uia_error)?;
                send_unicode_text(hwnd_from_u64(target.window), target.pid as u32, text)?;
                return Ok(Dispatched::SystemInput);
            }
            ActionKind::Click | ActionKind::DoubleClick | ActionKind::RightClick => {
                if kind == ActionKind::Click {
                    if let Ok(pattern) = unsafe {
                        element
                            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    } {
                        // SAFETY: the Invoke pattern is returned by the same
                        // element whose owner was verified above.
                        unsafe { pattern.Invoke() }.map_err(map_uia_error)?;
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
                unsafe { element.SetFocus() }.map_err(map_uia_error)?;
                for chord in keys {
                    let chord = parse_key_chord(chord).ok_or(DesktopError::NotActionable)?;
                    send_key_chord(hwnd_from_u64(target.window), target.pid as u32, chord)?;
                }
                return Ok(Dispatched::SystemInput);
            }
            ActionKind::Hover => {
                let bounds = self.measure(target)?.bounds;
                let point = action.point.unwrap_or_else(|| {
                    let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
                    rect.map(|rect| Point {
                        x: (rect.left + (rect.right - rect.left) / 2) as f64 - bounds.x,
                        y: (rect.top + (rect.bottom - rect.top) / 2) as f64 - bounds.y,
                    })
                    .unwrap_or(Point { x: 0.0, y: 0.0 })
                });
                post_mouse_move(hwnd, bounds, point, false)?;
                return Ok(Dispatched::WindowEvent);
            }
            ActionKind::Drag => {
                let from = action.point.ok_or(DesktopError::NotActionable)?;
                let to = action.to.ok_or(DesktopError::NotActionable)?;
                let bounds = self.measure(target)?.bounds;
                post_drag(hwnd, bounds, from, to)?;
                return Ok(Dispatched::WindowEvent);
            }
            ActionKind::Scroll => {
                let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
                let pattern = unsafe {
                    element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                }
                .map_err(|_| DesktopError::NotActionable)?;
                let horizontal_steps = scroll_steps(scroll.dx)?;
                let vertical_steps = scroll_steps(scroll.dy)?;
                for _ in 0..horizontal_steps {
                    let horizontal = if scroll.dx > 0.0 {
                        ScrollAmount_LargeIncrement
                    } else {
                        ScrollAmount_LargeDecrement
                    };
                    unsafe { pattern.Scroll(horizontal, ScrollAmount_NoAmount) }
                        .map_err(map_uia_error)?;
                }
                for _ in 0..vertical_steps {
                    let vertical = if scroll.dy > 0.0 {
                        ScrollAmount_LargeIncrement
                    } else {
                        ScrollAmount_LargeDecrement
                    };
                    unsafe { pattern.Scroll(ScrollAmount_NoAmount, vertical) }
                        .map_err(map_uia_error)?;
                }
            }
            ActionKind::Select => {
                let option = action
                    .option
                    .as_deref()
                    .ok_or(DesktopError::NotActionable)?;
                let option_matches = |candidate: &IUIAutomationElement| {
                    unsafe { candidate.CurrentName() }
                        .map(|name| name.iter().copied().eq(option.encode_utf16()))
                        .unwrap_or(false)
                };
                let mut candidates = vec![element.clone()];
                let condition =
                    unsafe { automation.CreateTrueCondition() }.map_err(map_uia_error)?;
                let descendants = unsafe { element.FindAll(TreeScope_Subtree, &condition) }
                    .map_err(map_uia_error)?;
                let count = unsafe { descendants.Length() }
                    .map_err(map_uia_error)?
                    .max(0) as usize;
                candidates.extend(
                    (0..count.min(MAX_TREE_NODES))
                        .filter_map(|index| unsafe { descendants.GetElement(index as i32) }.ok()),
                );
                let mut selected = false;
                let is_combo_box = is_combo_box_element(&element);
                let is_list_box = is_list_box_element(&element);
                if is_combo_box {
                    unsafe { element.SetFocus() }.map_err(map_uia_error)?;
                    selected = select_combo_option(hwnd, target.pid as u32, option)?;
                    if !selected {
                        selected = select_combo_option_by_keyboard(
                            hwnd_from_u64(target.window),
                            hwnd,
                            target.pid as u32,
                            option,
                            &element,
                        )?;
                    }
                }
                if !selected && is_list_box {
                    unsafe { element.SetFocus() }.map_err(map_uia_error)?;
                    selected = select_list_box_option(
                        hwnd_from_u64(target.window),
                        hwnd,
                        target.pid as u32,
                        option,
                    )?;
                }
                for candidate in candidates.into_iter().filter(|_| !selected) {
                    if option_matches(&candidate) {
                        if let Ok(pattern) = unsafe {
                            candidate.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                                UIA_SelectionItemPatternId,
                            )
                        } {
                            let belongs_to_target = self
                                .validate_element_owner(&candidate, target, allow_sensitive_input)
                                .is_ok();
                            // A standard ComboBox's expanded list can be a
                            // transient popup HWND that is not a child of the
                            // owning window. It is still safe to select an
                            // option obtained from this ComboBox's UIA subtree
                            // when the provider confirms it belongs to the
                            // exact target process. Do not generalize this to
                            // arbitrary elements found elsewhere in the app.
                            let belongs_to_combo_popup = unsafe { element.CurrentControlType() }
                                .is_ok_and(|control_type| control_type.0 == 50003)
                                && self_element_hwnd(&candidate)
                                    .is_some_and(|(_, pid)| pid == target.pid as u32)
                                && (allow_sensitive_input
                                    || unsafe { candidate.CurrentIsPassword() }
                                        .map(|value| !value.as_bool())
                                        .unwrap_or(false));
                            if !belongs_to_target && !belongs_to_combo_popup {
                                continue;
                            }
                            let deadline = Instant::now() + Duration::from_millis(500);
                            if !unsafe { pattern.CurrentIsSelected() }
                                .map_err(map_uia_error)?
                                .as_bool()
                            {
                                if let Some((option_hwnd, option_pid)) =
                                    self_element_hwnd(&candidate)
                                {
                                    if option_pid == target.pid as u32 {
                                        // Clicking the actual option popup
                                        // follows the native user interaction
                                        // path and lets frameworks update their
                                        // managed state (UIA Select alone may
                                        // only update the native selection).
                                        self.click_targeted(
                                            &candidate,
                                            option_hwnd,
                                            target,
                                            ActionKind::Click,
                                        )?;
                                    }
                                }
                            }
                            while !unsafe { pattern.CurrentIsSelected() }
                                .map_err(map_uia_error)?
                                .as_bool()
                                && Instant::now() < deadline
                            {
                                thread::sleep(Duration::from_millis(20));
                            }
                            if !unsafe { pattern.CurrentIsSelected() }
                                .map_err(map_uia_error)?
                                .as_bool()
                            {
                                unsafe { pattern.Select() }.map_err(map_uia_error)?;
                            }
                            if unsafe { pattern.CurrentIsSelected() }
                                .map_err(map_uia_error)?
                                .as_bool()
                            {
                                selected = true;
                                break;
                            }
                        }
                    }
                }
                if !selected && is_combo_box {
                    // Standard combo-box dropdown items are often exposed in
                    // a transient popup HWND rather than as descendants of the
                    // bound window. Use native keyboard type-ahead on the exact
                    // focused ComboBox instead of searching another control.
                    unsafe { element.SetFocus() }.map_err(map_uia_error)?;
                    let top = hwnd_from_u64(target.window);
                    send_unicode_text(top, target.pid as u32, option)?;
                    let enter = parse_key_chord("enter").ok_or(DesktopError::NotActionable)?;
                    send_key_chord(top, target.pid as u32, enter)?;
                    let selected_by_pattern = unsafe {
                        element.GetCurrentPatternAs::<IUIAutomationSelectionPattern>(
                            UIA_SelectionPatternId,
                        )
                    }
                    .ok()
                    .and_then(|pattern| unsafe { pattern.GetCurrentSelection() }.ok())
                    .is_some_and(|selection| {
                        let count = unsafe { selection.Length() }.unwrap_or(0).max(0) as usize;
                        (0..count.min(MAX_TREE_NODES)).any(|index| {
                            unsafe { selection.GetElement(index as i32) }
                                .ok()
                                .is_some_and(|item| option_matches(&item))
                        })
                    });
                    let selected_by_value = unsafe {
                        element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    }
                    .ok()
                    .and_then(|pattern| unsafe { pattern.CurrentValue() }.ok())
                    .is_some_and(|value| value.to_string() == option);
                    if !selected_by_pattern && !selected_by_value {
                        return Err(DesktopError::Failed(
                            "the requested combo-box option was not selected".into(),
                        ));
                    }
                    selected = true;
                }
                if !selected {
                    return Err(DesktopError::NotActionable);
                }
            }
        }
        Ok(Dispatched::AccessibilityAction)
    }
}

/// Keep native Window/UIA coordinates in physical screen pixels even when the
/// Host executable itself has no DPI manifest. The previous worker-thread
/// context is restored before returning to unrelated Host work.
struct PerMonitorDpiContext(DPI_AWARENESS_CONTEXT);

impl PerMonitorDpiContext {
    fn enter() -> Result<Self, DesktopError> {
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if !previous.is_invalid() {
            return Ok(Self(previous));
        }

        // Windows 10 1607 supports per-monitor v1 even where v2 is absent.
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE) };
        if !previous.is_invalid() {
            return Ok(Self(previous));
        }
        Err(DesktopError::Failed(
            "could not establish per-monitor DPI awareness for Computer Use".into(),
        ))
    }
}

impl Drop for PerMonitorDpiContext {
    fn drop(&mut self) {
        // SAFETY: the saved context was returned by SetThreadDpiAwarenessContext
        // on this same thread and remains valid for restoring its prior state.
        unsafe { SetThreadDpiAwarenessContext(self.0) };
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
    if let Some(target) = raw_target_for_window(hwnd) {
        targets.push(target);
    }
    BOOL(1)
}

fn raw_target_for_window(hwnd: HWND) -> Option<RawTarget> {
    if !is_window_visible(hwnd) {
        return None;
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect).ok()? };
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    let app_key = process_app_key(pid)?;
    let elevated = match (
        process_integrity_level(unsafe { GetCurrentProcess() }),
        process_integrity_level_for_pid(pid),
    ) {
        (Some(host), Some(target)) => target_integrity_is_higher(host, target),
        _ => true,
    };
    Some(RawTarget {
        target: TargetRef {
            // Bind an old id to the observed executable too, so recycled
            // PID/HWND values cannot silently target a different app.
            target_id: format!("{}:{}:{}", pid, hwnd.0 as usize, app_key),
            pid: pid as i32,
            window: hwnd.0 as usize as u64,
            app_key: app_key.clone(),
        },
        app_name: app_key,
        title: window_title(hwnd),
        bounds: Rect {
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right - rect.left) as f64,
            height: (rect.bottom - rect.top) as f64,
        },
        elevated,
    })
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
    let key_text = parts[parts.len() - 1];
    let key = virtual_key(key_text).or_else(|| {
        if modifiers & (MOD_CONTROL | MOD_ALT) == 0
            && key_text.chars().count() == 1
            && !key_text.chars().next()?.is_control()
        {
            Some(0)
        } else {
            None
        }
    })?;
    let literal = if modifiers & (MOD_CONTROL | MOD_ALT) == 0 {
        let mut chars = key_text.chars();
        match (chars.next(), chars.next()) {
            (Some(character), None) if !character.is_control() => {
                let character = if modifiers & MOD_SHIFT != 0 {
                    character.to_ascii_uppercase()
                } else {
                    character
                };
                Some(character.encode_utf16(&mut [0; 2]).to_vec())
            }
            _ => None,
        }
    } else {
        None
    };
    Some(KeyChord {
        modifiers,
        virtual_key: key,
        literal,
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

fn send_key_chord(
    target_window: HWND,
    target_pid: u32,
    chord: KeyChord,
) -> Result<(), DesktopError> {
    let modifiers = [
        (MOD_CONTROL, 0x11u16),
        (MOD_SHIFT, 0x10u16),
        (MOD_ALT, 0x12u16),
    ];
    let mut inputs = Vec::new();
    if let Some(units) = chord.literal {
        for unit in units {
            inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE));
            inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
    } else {
        for (flag, key) in modifiers {
            if chord.modifiers & flag != 0 {
                inputs.push(keyboard_input(key, 0, KEYBD_EVENT_FLAGS(0)));
            }
        }
        inputs.push(keyboard_input(chord.virtual_key, 0, KEYBD_EVENT_FLAGS(0)));
        inputs.push(keyboard_input(chord.virtual_key, 0, KEYEVENTF_KEYUP));
        for (flag, key) in modifiers.into_iter().rev() {
            if chord.modifiers & flag != 0 {
                inputs.push(keyboard_input(key, 0, KEYEVENTF_KEYUP));
            }
        }
    }
    send_keyboard_inputs(target_window, target_pid, &inputs)
}

fn send_unicode_text(target_window: HWND, target_pid: u32, text: &str) -> Result<(), DesktopError> {
    let mut inputs = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    send_keyboard_inputs(target_window, target_pid, &inputs)
}

fn keyboard_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_keyboard_inputs(
    target_window: HWND,
    target_pid: u32,
    inputs: &[INPUT],
) -> Result<(), DesktopError> {
    ensure_target_foreground(target_window, target_pid)?;
    if inputs.is_empty() {
        return Ok(());
    }
    // SAFETY: the target window was just activated and its owning PID was
    // verified. SendInput has no HWND parameter; activation plus an immediate
    // foreground-owner re-check prevents typing into an unrelated app.
    ensure_target_foreground(target_window, target_pid)?;
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } as usize;
    if sent != inputs.len() {
        return Err(DesktopError::Failed(
            "Windows accepted only part of the keyboard input".into(),
        ));
    }
    Ok(())
}

fn ensure_target_foreground(target_window: HWND, target_pid: u32) -> Result<(), DesktopError> {
    let foreground = unsafe { GetForegroundWindow() };
    let mut foreground_pid = 0u32;
    if !foreground.0.is_null() {
        unsafe { GetWindowThreadProcessId(foreground, Some(&mut foreground_pid)) };
    }
    if foreground_pid != target_pid {
        let _ = unsafe { SetForegroundWindow(target_window) };
        let foreground = unsafe { GetForegroundWindow() };
        foreground_pid = 0;
        if !foreground.0.is_null() {
            unsafe { GetWindowThreadProcessId(foreground, Some(&mut foreground_pid)) };
        }
    }
    if foreground_pid != target_pid {
        return Err(DesktopError::Failed(
            "the target window could not be safely brought to the foreground".into(),
        ));
    }
    Ok(())
}

fn client_lparam(hwnd: HWND, window_bounds: Rect, point: Point) -> Result<LPARAM, DesktopError> {
    let mut screen = POINT {
        x: (window_bounds.x + point.x).round() as i32,
        y: (window_bounds.y + point.y).round() as i32,
    };
    if !unsafe { ScreenToClient(hwnd, &mut screen) }.as_bool() {
        return Err(DesktopError::TargetGone);
    }
    Ok(make_lparam(screen.x, screen.y))
}

fn select_combo_option(hwnd: HWND, target_pid: u32, option: &str) -> Result<bool, DesktopError> {
    if !is_combo_box_class(&window_class_name(hwnd)) {
        return Ok(false);
    }
    let mut owner_pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner_pid)) };
    if owner_pid != target_pid {
        return Err(DesktopError::ElementNotFound);
    }
    let mut option_wide = option.encode_utf16().collect::<Vec<_>>();
    option_wide.push(0);
    let index = unsafe {
        SendMessageW(
            hwnd,
            CB_FINDSTRINGEXACT,
            Some(WPARAM(usize::MAX)),
            Some(LPARAM(option_wide.as_ptr() as isize)),
        )
    }
    .0;
    if index < 0 || index > 1_000 {
        return Ok(false);
    }
    let current = unsafe { SendMessageW(hwnd, CB_GETCURSEL, Some(WPARAM(0)), None) }.0;
    if current < 0 || current > 1_000 {
        return Ok(false);
    }
    // Use real keyboard selection rather than CB_SETCURSEL: setting the
    // native index directly can leave framework-owned state/events stale.
    unsafe { SendMessageW(hwnd, CB_SHOWDROPDOWN, Some(WPARAM(1)), None) };
    let key = if current < index { "down" } else { "up" };
    for _ in 0..current.abs_diff(index) {
        send_key_chord(
            hwnd_from_u64(hwnd.0 as u64),
            target_pid,
            parse_key_chord(key).unwrap(),
        )?;
        thread::sleep(Duration::from_millis(25));
    }
    send_key_chord(
        hwnd_from_u64(hwnd.0 as u64),
        target_pid,
        parse_key_chord("enter").ok_or(DesktopError::NotActionable)?,
    )?;
    let selected_index = unsafe { SendMessageW(hwnd, CB_GETCURSEL, Some(WPARAM(0)), None) }.0;
    if selected_index != index {
        return Ok(false);
    }
    let mut selected = vec![0u16; option.encode_utf16().count().saturating_add(2)];
    let copied = unsafe {
        SendMessageW(
            hwnd,
            CB_GETLBTEXT,
            Some(WPARAM(index as usize)),
            Some(LPARAM(selected.as_mut_ptr() as isize)),
        )
    }
    .0;
    Ok(copied >= 0 && String::from_utf16_lossy(&selected[..copied as usize]) == option)
}

/// WinForms may expose a ListBox as a generic Pane and omit UIA selection
/// patterns. Resolve the exact option through the target-owned ListBox HWND,
/// navigate with real keyboard input, then verify both the selected index and
/// text. No text is typed into the target and no other control is searched.
fn select_list_box_option(
    target_window: HWND,
    list_hwnd: HWND,
    target_pid: u32,
    option: &str,
) -> Result<bool, DesktopError> {
    let class_name = window_class_name(list_hwnd);
    if !is_list_box_class(&class_name) {
        return Ok(false);
    }
    let mut owner_pid = 0u32;
    unsafe { GetWindowThreadProcessId(list_hwnd, Some(&mut owner_pid)) };
    if owner_pid != target_pid {
        return Err(DesktopError::ElementNotFound);
    }
    let mut option_wide = option.encode_utf16().collect::<Vec<_>>();
    option_wide.push(0);
    let index = unsafe {
        SendMessageW(
            list_hwnd,
            LB_FINDSTRINGEXACT,
            Some(WPARAM(usize::MAX)),
            Some(LPARAM(option_wide.as_ptr() as isize)),
        )
    }
    .0;
    let count = unsafe { SendMessageW(list_hwnd, LB_GETCOUNT, Some(WPARAM(0)), None) }.0;
    if index < 0 || count <= 0 || index >= count || index > 1_000 {
        return Ok(false);
    }
    let parent = unsafe { GetParent(list_hwnd) }.map_err(map_uia_error)?;
    if parent.0.is_null() {
        return Err(DesktopError::ElementNotFound);
    }
    let mut parent_pid = 0u32;
    unsafe { GetWindowThreadProcessId(parent, Some(&mut parent_pid)) };
    if parent_pid != target_pid {
        return Err(DesktopError::ElementNotFound);
    }
    // LB_SETCURSEL changes exactly this ListBox's selected item. A native
    // list box does not notify its owner for that message, so relay the
    // documented LBN_SELCHANGE notification through the verified parent to
    // keep framework-owned SelectionChanged state in sync.
    let result =
        unsafe { SendMessageW(list_hwnd, LB_SETCURSEL, Some(WPARAM(index as usize)), None) }.0;
    if result < 0 {
        return Ok(false);
    }
    let control_id = unsafe { GetDlgCtrlID(list_hwnd) };
    if control_id >= 0 {
        let wparam = (1usize << 16) | control_id as u16 as usize;
        let _ = unsafe {
            SendMessageW(
                parent,
                WM_COMMAND,
                Some(WPARAM(wparam)),
                Some(LPARAM(list_hwnd.0 as isize)),
            )
        };
    }
    if list_box_value_matches(list_hwnd, index, option) {
        return Ok(true);
    }

    let current = unsafe { SendMessageW(list_hwnd, LB_GETCURSEL, Some(WPARAM(0)), None) }.0;
    if current != index {
        let first = parse_key_chord("home").ok_or(DesktopError::NotActionable)?;
        send_key_chord(target_window, target_pid, first)?;
        let direction = if index >= 0 { "down" } else { "up" };
        for _ in 0..index {
            send_key_chord(
                target_window,
                target_pid,
                parse_key_chord(direction).ok_or(DesktopError::NotActionable)?,
            )?;
        }
    }
    let selected_index = unsafe { SendMessageW(list_hwnd, LB_GETCURSEL, Some(WPARAM(0)), None) }.0;
    if selected_index != index {
        return Ok(false);
    }
    Ok(list_box_value_matches(list_hwnd, index, option))
}

fn list_box_value_matches(list_hwnd: HWND, index: isize, option: &str) -> bool {
    let mut selected = vec![0u16; option.encode_utf16().count().saturating_add(2)];
    let copied = unsafe {
        SendMessageW(
            list_hwnd,
            LB_GETTEXT,
            Some(WPARAM(index as usize)),
            Some(LPARAM(selected.as_mut_ptr() as isize)),
        )
    }
    .0;
    copied >= 0 && String::from_utf16_lossy(&selected[..copied as usize]) == option
}

/// WinForms and some other frameworks expose their combo HWND as a generic
/// `Pane` with no UIA patterns. Use foreground-verified keyboard type-ahead as
/// the semantic fallback, then read the selected native item back. Typing into
/// a closed unrelated control is never treated as success.
fn select_combo_option_by_keyboard(
    target_window: HWND,
    combo_hwnd: HWND,
    target_pid: u32,
    option: &str,
    element: &IUIAutomationElement,
) -> Result<bool, DesktopError> {
    let open = parse_key_chord("alt+down").ok_or(DesktopError::NotActionable)?;
    send_key_chord(target_window, target_pid, open)?;
    thread::sleep(Duration::from_millis(100));
    send_unicode_text(target_window, target_pid, option)?;
    let enter = parse_key_chord("enter").ok_or(DesktopError::NotActionable)?;
    send_key_chord(target_window, target_pid, enter)?;
    thread::sleep(Duration::from_millis(100));

    let selected_index = unsafe { SendMessageW(combo_hwnd, CB_GETCURSEL, Some(WPARAM(0)), None) }.0;
    if selected_index < 0 || selected_index > 1_000 {
        return Ok(false);
    }
    let mut selected = vec![0u16; option.encode_utf16().count().saturating_add(2)];
    let copied = unsafe {
        SendMessageW(
            combo_hwnd,
            CB_GETLBTEXT,
            Some(WPARAM(selected_index as usize)),
            Some(LPARAM(selected.as_mut_ptr() as isize)),
        )
    }
    .0;
    let native_value_matches =
        copied >= 0 && String::from_utf16_lossy(&selected[..copied as usize]) == option;
    if native_value_matches {
        return Ok(true);
    }
    let value_matches =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .ok()
            .and_then(|pattern| unsafe { pattern.CurrentValue() }.ok())
            .is_some_and(|value| value.to_string() == option);
    if value_matches {
        return Ok(true);
    }
    let selection_matches = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionPattern>(UIA_SelectionPatternId)
    }
    .ok()
    .and_then(|pattern| unsafe { pattern.GetCurrentSelection() }.ok())
    .is_some_and(|selection| {
        let count = unsafe { selection.Length() }.unwrap_or(0).max(0) as usize;
        (0..count.min(MAX_TREE_NODES)).any(|index| {
            unsafe { selection.GetElement(index as i32) }
                .ok()
                .and_then(|item| unsafe { item.CurrentName() }.ok())
                .is_some_and(|name| name.to_string() == option)
        })
    });
    Ok(selection_matches)
}

fn is_combo_box_element(element: &IUIAutomationElement) -> bool {
    unsafe { element.CurrentControlType() }.is_ok_and(|control_type| control_type.0 == 50003)
        || self_element_hwnd(element)
            .is_some_and(|(hwnd, _)| is_combo_box_class(&window_class_name(hwnd)))
}

fn is_list_box_element(element: &IUIAutomationElement) -> bool {
    unsafe { element.CurrentControlType() }.is_ok_and(|control_type| control_type.0 == 50008)
        || self_element_hwnd(element)
            .is_some_and(|(hwnd, _)| is_list_box_class(&window_class_name(hwnd)))
}

fn semantic_control_type(
    platform_role_id: i32,
    class_name: Option<&str>,
    has_toggle_pattern: bool,
) -> i32 {
    if platform_role_id != 50033 {
        return platform_role_id;
    }
    let Some(class_name) = class_name else {
        return platform_role_id;
    };
    let class_name = class_name.to_ascii_lowercase();
    if is_combo_box_class(&class_name) {
        50003
    } else if is_list_box_class(&class_name) {
        50008
    } else if is_edit_class(&class_name) {
        50004
    } else if is_static_class(&class_name) {
        50020
    } else if is_button_class(&class_name) && has_toggle_pattern {
        50002
    } else if is_button_class(&class_name) {
        50000
    } else {
        platform_role_id
    }
}

fn is_combo_box_class(class_name: &str) -> bool {
    class_name.to_ascii_lowercase().contains("combobox")
}

fn is_list_box_class(class_name: &str) -> bool {
    class_name.eq_ignore_ascii_case("listbox")
        || class_name.to_ascii_lowercase().contains(".listbox.")
}

fn is_edit_class(class_name: &str) -> bool {
    class_name == "edit" || class_name.contains(".edit.")
}

fn is_static_class(class_name: &str) -> bool {
    class_name == "static" || class_name.contains(".static.")
}

fn is_button_class(class_name: &str) -> bool {
    class_name == "button" || class_name.contains(".button.")
}

fn window_class_name(hwnd: HWND) -> String {
    let mut class_name = [0u16; 128];
    let class_length = unsafe { GetClassNameW(hwnd, &mut class_name) }.max(0) as usize;
    String::from_utf16_lossy(&class_name[..class_length.min(class_name.len())])
}

fn post_mouse_move(
    hwnd: HWND,
    window_bounds: Rect,
    point: Point,
    button_down: bool,
) -> Result<(), DesktopError> {
    let packed = client_lparam(hwnd, window_bounds, point)?;
    let flags = if button_down { WPARAM(1) } else { WPARAM(0) };
    unsafe { PostMessageW(Some(hwnd), WM_MOUSEMOVE, flags, packed) }.map_err(map_uia_error)
}

fn post_drag(hwnd: HWND, window_bounds: Rect, from: Point, to: Point) -> Result<(), DesktopError> {
    let start = client_lparam(hwnd, window_bounds, from)?;
    unsafe { PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), start) }.map_err(map_uia_error)?;
    const INTERMEDIATE_STEPS: i32 = 8;
    let movement = (|| {
        for step in 1..=INTERMEDIATE_STEPS {
            let ratio = step as f64 / INTERMEDIATE_STEPS as f64;
            let point = Point {
                x: from.x + (to.x - from.x) * ratio,
                y: from.y + (to.y - from.y) * ratio,
            };
            post_mouse_move(hwnd, window_bounds, point, true)?;
        }
        Ok::<(), DesktopError>(())
    })();
    // Always attempt to release after a successful button-down, even when an
    // intermediate message fails, so the target is not left in a drag state.
    let release = client_lparam(hwnd, window_bounds, to).and_then(|end| unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), end).map_err(map_uia_error)
    });
    movement?;
    release
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
        50001 => "calendar",
        50002 => "checkbox",
        50003 => "combo-box",
        50004 => "edit",
        50005 => "hyperlink",
        50006 => "image",
        50007 => "list-item",
        50008 => "list",
        50009 => "menu",
        50010 => "menu-bar",
        50011 => "menu-item",
        50012 => "progress-bar",
        50013 => "radio-button",
        50014 => "scroll-bar",
        50015 => "slider",
        50016 => "spinner",
        50017 => "status-bar",
        50018 => "tab",
        50019 => "tab-item",
        50020 => "text",
        50021 => "tool-bar",
        50022 => "tool-tip",
        50023 => "tree",
        50024 => "tree-item",
        50025 => "custom",
        50026 => "group",
        50027 => "thumb",
        50028 => "data-grid",
        50029 => "data-item",
        50030 => "document",
        50031 => "split-button",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "header-item",
        50036 => "table",
        50037 => "title-bar",
        50038 => "separator",
        50039 => "semantic-zoom",
        50040 => "app-bar",
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

fn scroll_steps(value: f64) -> Result<u32, DesktopError> {
    if !value.is_finite() || value.abs() > 100.0 {
        return Err(DesktopError::NotActionable);
    }
    Ok(value.abs().ceil() as u32)
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
    use windows::Win32::UI::HiDpi::{
        AreDpiAwarenessContextsEqual, GetAwarenessFromDpiAwarenessContext,
        GetThreadDpiAwarenessContext, DPI_AWARENESS_PER_MONITOR_AWARE,
    };

    #[test]
    fn computer_operations_use_per_monitor_dpi_and_restore_the_worker_context() {
        let original = unsafe { GetThreadDpiAwarenessContext() };
        {
            let _context = PerMonitorDpiContext::enter()
                .expect("Windows should support per-monitor DPI awareness");
            let current = unsafe { GetThreadDpiAwarenessContext() };
            assert_eq!(
                unsafe { GetAwarenessFromDpiAwarenessContext(current) },
                DPI_AWARENESS_PER_MONITOR_AWARE
            );
        }
        let restored = unsafe { GetThreadDpiAwarenessContext() };
        assert!(unsafe { AreDpiAwarenessContextsEqual(original, restored) }.as_bool());
    }

    #[test]
    fn parses_only_window_scoped_key_chords() {
        assert_eq!(
            parse_key_chord("ctrl+shift+a"),
            Some(KeyChord {
                modifiers: MOD_CONTROL | MOD_SHIFT,
                virtual_key: 0x41,
                literal: None,
            })
        );
        assert_eq!(
            parse_key_chord("A").unwrap().literal,
            Some(vec![b'A' as u16])
        );
        assert_eq!(
            parse_key_chord("!").unwrap().literal,
            Some(vec![b'!' as u16])
        );
        assert_eq!(
            parse_key_chord("shift+a").unwrap().literal,
            Some(vec![b'A' as u16])
        );
        assert_eq!(parse_key_chord("字").unwrap().literal, Some(vec![0x5B57]));
        assert_eq!(parse_key_chord("win+r"), None);
        assert_eq!(parse_key_chord("ctrl+alt+shift+a"), None);
    }

    #[test]
    fn scroll_delta_keeps_magnitude_and_rejects_unbounded_values() {
        assert_eq!(scroll_steps(5.0), Ok(5));
        assert_eq!(scroll_steps(-2.2), Ok(3));
        assert_eq!(scroll_steps(0.0), Ok(0));
        assert_eq!(scroll_steps(101.0), Err(DesktopError::NotActionable));
        assert_eq!(scroll_steps(f64::NAN), Err(DesktopError::NotActionable));
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

    #[test]
    fn uia_control_roles_use_the_documented_control_type_ids() {
        assert_eq!(control_type_name(50000), "button");
        assert_eq!(control_type_name(50002), "checkbox");
        assert_eq!(control_type_name(50003), "combo-box");
        assert_eq!(control_type_name(50004), "edit");
        assert_eq!(control_type_name(50033), "pane");
        assert_eq!(control_type_name(50040), "app-bar");
    }

    #[test]
    fn combo_class_detection_covers_framework_subclasses_even_when_uia_role_is_pane() {
        assert!(is_combo_box_class("COMBOBOX"));
        assert!(is_combo_box_class(
            "WindowsForms10.COMBOBOX.app.0.2bf8098_r8_ad1"
        ));
        assert!(!is_combo_box_class(
            "WindowsForms10.EDIT.app.0.2bf8098_r8_ad1"
        ));
    }

    #[test]
    fn pane_roles_are_recovered_only_from_known_native_control_classes() {
        assert_eq!(
            semantic_control_type(50033, Some("WindowsForms10.BUTTON.app"), false),
            50000
        );
        assert_eq!(
            semantic_control_type(50033, Some("WindowsForms10.BUTTON.app"), true),
            50002
        );
        assert_eq!(
            semantic_control_type(50033, Some("WindowsForms10.EDIT.app"), false),
            50004
        );
        assert_eq!(
            semantic_control_type(50033, Some("WindowsForms10.STATIC.app"), false),
            50020
        );
        assert_eq!(
            semantic_control_type(50033, Some("WindowsForms10.COMBOBOX.app"), false),
            50003
        );
        assert_eq!(
            semantic_control_type(50033, Some("WindowsForms10.LISTBOX.app"), false),
            50008
        );
        assert_eq!(
            semantic_control_type(50033, Some("CustomCanvas"), false),
            50033
        );
        assert_eq!(
            semantic_control_type(50004, Some("WindowsForms10.BUTTON.app"), false),
            50004
        );
        assert_eq!(semantic_control_type(50033, None, false), 50033);
    }

    #[test]
    fn list_box_class_detection_covers_framework_subclasses() {
        assert!(is_list_box_class("LISTBOX"));
        assert!(is_list_box_class(
            "WindowsForms10.LISTBOX.app.0.34f5582_r7_ad1"
        ));
        assert!(!is_list_box_class(
            "WindowsForms10.COMBOBOX.app.0.34f5582_r7_ad1"
        ));
    }
}
