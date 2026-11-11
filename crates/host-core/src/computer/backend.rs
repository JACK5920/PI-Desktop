//! The platform contract for computer use, plus the fallback that exists on
//! every target so an unimplemented platform is a refusal rather than a
//! compile error or a silent no-op (ADR 0349 §11).
//!
//! A backend may only *attempt* work. It never decides whether a request is
//! allowed: policy has already admitted the request by the time a backend sees
//! it, and the grant's own re-measurement happens above this layer.

use serde::{Deserialize, Serialize};
use std::sync::Arc;


use super::{Action, Capabilities, Fidelity, Node, PermissionState, Rect};

#[cfg(target_os = "windows")]
pub mod cua;
#[cfg(all(target_os = "windows", test))]
mod cua_live;
#[cfg(target_os = "windows")]
pub mod cua_mcp;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;
/// and a caller cannot construct one: it only comes back from `list_targets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRef {
    /// Opaque, host-minted. Encodes the platform handle so a later call cannot
    /// smuggle a different window in under a known id.
    pub target_id: String,
    pub pid: i32,
    /// Platform window handle: CGWindowID, HWND, or X11 window id.
    pub window: u64,
    /// Bundle id, executable name, or WM class — whatever the platform proves.
    pub app_key: String,
}

#[derive(Debug, Clone)]
pub struct RawTarget {
    pub target: TargetRef,
    pub app_name: String,
    pub title: String,
    pub bounds: Rect,
    /// Set when the platform itself knows the window cannot be driven, e.g. a
    /// higher-integrity owner on Windows.
    pub elevated: bool,
}

/// What a re-measurement found. `None` means the window is gone, which is a
/// scope violation rather than an element error.
#[derive(Debug, Clone)]
pub struct Measured {
    pub bounds: Rect,
    pub app_key: String,
    /// Live window title. Read by the backends that refresh a grant label; a
    /// title change alone never bumps the revision, because a document rename
    /// is not a different window.
    #[allow(dead_code)]
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Dispatched {
    /// The platform's own accessibility action ran. No pointer was involved.
    AccessibilityAction,
    /// A window-targeted event was posted. Still no global pointer warp.
    WindowEvent,
    /// OS keyboard input was synthesized after verifying the target is the
    /// foreground process. The UI still needs to be observed for confirmation.
    SystemInput,
}

/// Variants a given platform may never produce — `Elevated` is Windows-only,
/// `Unsupported` comes from the fallback — are kept so the contract is the
/// same everywhere and a port does not have to widen the enum.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopError {
    /// No backend on this platform, or no input path in this session type.
    Unsupported,
    PermissionMissing,
    SecureInputRefused,
    TargetGone,
    Elevated,
    ElementNotFound,
    NotActionable,
    Timeout,
    Failed(String),
}

pub struct RawInspection {
    pub nodes: Vec<Node>,
    /// Whether the backend itself cut the tree.
    pub truncated: bool,
    /// How many nodes the backend walked before the host's own budget was
    /// applied. The host cuts the tree to its node budget, and the caller has
    /// to be told when that happened -- otherwise it reads a list it
    /// believes is complete and concludes that an element the window plainly
    /// shows does not exist.
    pub total_nodes: usize,
    pub fidelity: Fidelity,
}

pub trait Desktop: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    /// Ask the OS to grant the permission this backend needs, and report what
    /// it says now.
    ///
    /// This is the one backend call a user can trigger directly, and it only
    /// ever *asks*: macOS shows its own dialog, and the grant decision stays in
    /// System Settings. A platform with no permission model refuses, so the
    /// caller can tell "not grantable here" from "asked and still not allowed".
    fn request_permission(&self) -> Result<PermissionState, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    /// Every window the platform can enumerate, unfiltered. Policy removes and
    /// annotates entries; a backend never hides one, because a target the user
    /// can see but the picker silently dropped is indistinguishable from a bug.
    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError>;

    /// Resolve a previously issued target id against the live OS handle when
    /// an enumeration snapshot temporarily omits it. Backends must validate
    /// the handle and owner identity; unsupported implementations return
    /// `None` and retain the enumeration-only behavior.
    fn resolve_target(&self, _target_id: &str) -> Result<Option<RawTarget>, DesktopError> {
        Ok(None)
    }

    /// Re-read the live geometry and identity of one target.
    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError>;

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError>;

    /// Inspect with an explicit user policy for secure input surfaces.
    fn inspect_with_sensitive_input(
        &self,
        target: &TargetRef,
        max_nodes: usize,
        _allow_sensitive_input: bool,
    ) -> Result<RawInspection, DesktopError> {
        self.inspect(target, max_nodes)
    }

    /// Whether the OS reports a secure input state right now. A backend that
    /// cannot tell must answer `true`: refusing is the safe default, since the
    /// alternative is typing into a password field.
    fn secure_input_active(&self) -> bool;

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError>;

    /// Dispatch with an explicit user policy for secure input surfaces.
    fn perform_with_sensitive_input(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
        _allow_sensitive_input: bool,
    ) -> Result<Dispatched, DesktopError> {
        self.perform(target, uid, action)
    }

    /// Read the target back and report whether it now holds `expected`.
    ///
    /// A write's result is the content of a field, and the accessibility tree
    /// never publishes a field's content -- the element list says only that
    /// the field holds a value. So the caller that asked for the write cannot
    /// confirm it from the tree, and a model that has to confirm it from the
    /// tree either guesses or keeps retrying.
    ///
    /// The backend can answer it, because the driver reports the field's
    /// current value in its structured tree. This asks the backend to compare
    /// that value against what was written and report the verdict.
    ///
    /// `None` means the backend cannot tell, which is not a failure: the
    /// caller then reports the write as dispatched and unconfirmed.
    fn confirm_write(
        &self,
        _target: &TargetRef,
        _uid: Option<&str>,
        _expected: &str,
    ) -> Option<bool> {
        None
    }

    /// Process ids that belong to this application, so policy can refuse our
    /// own windows without trusting a name comparison.
    ///
    /// host-core has no windows of its own — the windows to refuse belong to
    /// the Electron process that spawned it. The parent pid is therefore part
    /// of the answer, and it is discovered here rather than supplied by a
    /// request, so no caller can shrink this set.
    fn self_pids(&self) -> Vec<i32> {
        #[allow(unused_mut)]
        let mut pids = vec![std::process::id() as i32];
        #[cfg(unix)]
        {
            // SAFETY: `getppid` takes no arguments and cannot fail.
            let parent = unsafe { libc::getppid() };
            if parent > 1 {
                pids.push(parent);
            }
        }
        pids
    }
}

/// The backend every platform has: it exists so that an unimplemented platform
/// answers with a code instead of panicking or pretending to work. On a
/// platform whose backend is built, nothing constructs it outside the tests.
#[allow(dead_code)]
pub struct UnsupportedDesktop {
    platform: &'static str,
    reason: &'static str,
}

impl UnsupportedDesktop {
    #[allow(dead_code)]
    pub fn new(platform: &'static str, reason: &'static str) -> Self {
        Self { platform, reason }
    }
}

impl Desktop for UnsupportedDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: self.platform.to_string(),
            backend: "unsupported".into(),
            fidelity: Fidelity::None,
            accessibility: PermissionState::Unsupported,
            capture: PermissionState::Unsupported,
            session_type: None,
            input_unsupported_reason: Some(self.reason.to_string()),
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    fn measure(&self, _target: &TargetRef) -> Result<Measured, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    fn inspect(
        &self,
        _target: &TargetRef,
        _max_nodes: usize,
    ) -> Result<RawInspection, DesktopError> {
        Err(DesktopError::Unsupported)
    }

    fn secure_input_active(&self) -> bool {
        true
    }

    fn perform(
        &self,
        _target: &TargetRef,
        _uid: Option<&str>,
        _action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        Err(DesktopError::Unsupported)
    }
}

/// Which backend this build should try first.
///
/// `CUA_DRIVER_BACKEND=1` opts into the cua-driver backend. It is opt-in rather
/// than the default because it shells out to a third-party binary: a machine
/// without one must not silently lose computer use, and a regression in the
/// bridge must be reversible without a rebuild.
/// Read the switch from the user environment, falling back to the registry.
///
/// `std::env::var` sees the process's environment block, which Windows snapshots
/// at process start. A user who sets the variable after PI-Desktop is already
/// running would otherwise have to log out for a toggle to take effect — so the
/// registry is consulted too, and that one is live.
fn cua_backend_requested() -> bool {
    fn accepted(value: &str) -> bool {
        matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on")
    }

    if let Ok(value) = std::env::var("CUA_DRIVER_BACKEND") {
        if accepted(&value) {
            return true;
        }
    }

    #[cfg(windows)]
    if let Some(value) = read_user_env("CUA_DRIVER_BACKEND") {
        return accepted(&value);
    }

    false
}

/// `HKCU\Environment\<name>`, which is where `setx` and the System Properties
/// dialog both write a user variable.
#[cfg(windows)]
fn read_user_env(name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    let subkey: Vec<u16> = "Environment".encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buffer = [0u16; 256];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    // The size is in bytes and includes the terminating NUL.
    let len = (size as usize / 2).saturating_sub(1).min(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..len]))
}

/// A `Box<dyn Desktop>` façade over a shared instance.
///
/// `active()` must hand out `Box<dyn Desktop>`, but the backend underneath is
/// cached for the process lifetime so one driver and one snapshot cache are
/// reused across RPC requests. This type is the cheap adapter between the two.
struct ArcDesktop(Arc<dyn Desktop>);

impl Desktop for ArcDesktop {
    fn capabilities(&self) -> Capabilities {
        self.0.capabilities()
    }
    fn request_permission(&self) -> Result<PermissionState, DesktopError> {
        self.0.request_permission()
    }
    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.0.list_targets()
    }
    fn resolve_target(&self, target_id: &str) -> Result<Option<RawTarget>, DesktopError> {
        self.0.resolve_target(target_id)
    }
    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        self.0.measure(target)
    }
    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        self.0.inspect(target, max_nodes)
    }
    fn inspect_with_sensitive_input(
        &self,
        target: &TargetRef,
        max_nodes: usize,
        allow: bool,
    ) -> Result<RawInspection, DesktopError> {
        self.0.inspect_with_sensitive_input(target, max_nodes, allow)
    }
    fn secure_input_active(&self) -> bool {
        self.0.secure_input_active()
    }
    fn confirm_write(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        expected: &str,
    ) -> Option<bool> {
        // The adapter has to forward this one. Without it the wrapper answers
        // the trait's default -- "the backend cannot tell" -- while the
        // backend underneath can, and a confirmed write is reported as an
        // unconfirmed one.
        self.0.confirm_write(target, uid, expected)
    }
    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        self.0.perform(target, uid, action)
    }
    fn perform_with_sensitive_input(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
        allow: bool,
    ) -> Result<Dispatched, DesktopError> {
        self.0.perform_with_sensitive_input(target, uid, action, allow)
    }
    fn self_pids(&self) -> Vec<i32> {
        self.0.self_pids()
    }
}

/// The pid that spawned `pid`, through the platform's own process table.
///
/// `std::process::id()` answers "who am I"; nothing in std answers "who started
/// me" on Windows, and the crate deliberately avoids pulling in a process-tree
/// dependency for one call.
#[cfg(target_os = "windows")]
pub(crate) fn parent_pid(pid: u32) -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == pid {
                    parent = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        parent
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn parent_pid(_pid: u32) -> Option<u32> {
    None
}

/// Every pid that belongs to this application's own process tree: the host
/// itself plus the ancestors that spawned it.
///
/// The trait's default implementation adds a parent only on unix, so on Windows
/// it answers "this process alone". That is not enough: the windows that must
/// never be targeted belong to the Electron parent that spawned host-core, and
/// `electron.exe` is not a name the static self-key list can match. Walking the
/// chain is what makes "never target our own UI" hold for a backend that reports
/// the executable rather than the application.
///
/// The walk is bounded, so a cycle or a runaway parent cannot make it loop.
pub(crate) fn self_pid_chain(depth: usize) -> Vec<i32> {
    let mut pids = vec![std::process::id() as i32];
    let mut current = std::process::id();
    for _ in 0..depth {
        let Some(parent) = parent_pid(current) else {
            break;
        };
        if parent == 0 || parent == current {
            break;
        }
        pids.push(parent as i32);
        current = parent;
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// The backend for this build. Each platform arm is compiled only on its own
/// target, so an unported platform cannot fail to build.
pub fn active() -> Box<dyn Desktop> {
    #[cfg(target_os = "macos")]
    {
        Box::new(super::macos::MacDesktop::new())
    }
    #[cfg(target_os = "windows")]
    {
        // `active()` runs on every RPC request, so the backend is cached:
        // constructing a fresh one here would spawn a new cua-driver per call
        // and throw away the snapshot cache an element uid depends on.
        static SHARED: std::sync::OnceLock<Arc<dyn Desktop>> = std::sync::OnceLock::new();
        let shared = SHARED.get_or_init(|| {
            let requested = cua_backend_requested();
            tracing::info!(target: "computer", requested, "choosing the computer-use backend");
            if requested {
                match cua::CuaDesktop::new() {
                    Ok(backend) => {
                        tracing::info!(target: "computer", "cua-driver backend active");
                        return Arc::new(backend) as Arc<dyn Desktop>;
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "computer",
                            %error,
                            "cua-driver backend unavailable; using the native backend"
                        );
                    }
                }
            }
            Arc::new(windows::WindowsDesktop::new())
        });
        Box::new(ArcDesktop(Arc::clone(shared)))
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(linux::LinuxDesktop::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Box::new(UnsupportedDesktop::new(
            "other",
            "no backend for this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_documented_affirmatives_enable_the_bridge() {
        // A typo must not silently switch the backend under the user.
        for value in ["1", "true", "on", "TRUE", " On ", "1\n"] {
            assert!(
                matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on"),
                "{value:?} should be accepted"
            );
        }
        for value in ["0", "false", "off", "", "yes", "enable"] {
            assert!(
                !matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on"),
                "{value:?} must not enable the bridge"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_registry_fallback_sees_what_the_process_block_may_miss() {
        // The registry is read live, so a value written after this process
        // started is still visible — which is the whole reason the fallback
        // exists. Read a variable every Windows account has and prove the
        // lookup path works; then prove a missing one yields None.
        assert!(
            read_user_env("PATH").is_some() || read_user_env("TEMP").is_some(),
            "at least one well-known user variable resolves through HKCU\\Environment"
        );
        assert_eq!(
            read_user_env("PI_DESKTOP_NO_SUCH_VARIABLE_ZZZ"),
            None,
            "an absent value must be None, not an empty string"
        );
    }

    #[cfg(windows)]
    #[cfg(windows)]
    #[test]
    fn the_switch_reflects_the_registry_when_the_process_block_is_empty() {
        // The process environment block is a snapshot from process start; the
        // registry is live. Whichever a machine has, `cua_backend_requested`
        // must agree with it rather than with the snapshot alone.
        let from_process = std::env::var("CUA_DRIVER_BACKEND").ok();
        let from_registry = read_user_env("CUA_DRIVER_BACKEND");
        let expected = [from_process.as_deref(), from_registry.as_deref()]
            .into_iter()
            .flatten()
            .any(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on"));
        eprintln!(
            "process={:?} registry={:?} -> requested={}",
            from_process, from_registry, cua_backend_requested()
        );
        assert_eq!(cua_backend_requested(), expected);
    }
}
