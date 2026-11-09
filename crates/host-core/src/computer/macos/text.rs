//! Target-bound Unicode text input for the macOS Computer Use backend.

use super::super::backend::{DesktopError, TargetRef};
use super::super::macos_text::unicode_text_chunks;
use super::ffi::*;

pub(super) fn type_text(
    target: &TargetRef,
    element: CFTypeRef,
    text: &str,
    focused_window_is_target: impl Fn() -> Result<bool, DesktopError>,
) -> Result<(), DesktopError> {
    let role = attribute_string(element as AXUIElementRef, "AXRole");
    let subrole = attribute_string(element as AXUIElementRef, "AXSubrole");
    if is_secure_text_role(role.as_deref().unwrap_or_default(), subrole.as_deref()) {
        return Err(DesktopError::SecureInputRefused);
    }
    if !role.as_deref().is_some_and(is_editable_text_role)
        || !attribute_bool(element as AXUIElementRef, "AXEnabled").unwrap_or(true)
        || !attribute_is_settable(element as AXUIElementRef, "AXValue")
    {
        return Err(DesktopError::NotActionable);
    }
    // Do not let resolving a previously observed node activate a different
    // application or window. The caller must still be on the granted target
    // before we ask Accessibility to focus the text control.
    if !focused_window_is_target()? {
        return Err(DesktopError::NotActionable);
    }
    let focused = CfString::new("AXFocused").ok_or(DesktopError::NotActionable)?;
    // SAFETY: `kCFBooleanTrue` is an immortal CoreFoundation constant; the
    // resolved AX element and attribute string remain valid for the call.
    if unsafe {
        AXUIElementSetAttributeValue(element as AXUIElementRef, focused.as_ref(), kCFBooleanTrue)
    } != kAXErrorSuccess
        || !attribute_bool(element as AXUIElementRef, "AXFocused").unwrap_or(false)
    {
        return Err(DesktopError::NotActionable);
    }
    if !focused_window_is_target()? {
        return Err(DesktopError::NotActionable);
    }

    for chunk in unicode_text_chunks(text) {
        if !focused_window_is_target()? {
            return Err(DesktopError::NotActionable);
        }
        // SAFETY: a null source selects a private event source. The Unicode
        // slice stays alive through setting/posting both target-process events.
        let key_down = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, 1) };
        if key_down.is_null() {
            return Err(DesktopError::Failed("unicode key event".into()));
        }
        let key_up = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, 0) };
        if key_up.is_null() {
            unsafe { CFRelease(key_down) };
            return Err(DesktopError::Failed("unicode key release".into()));
        }
        unsafe {
            CGEventKeyboardSetUnicodeString(
                key_down,
                chunk.len() as std::ffi::c_ulong,
                chunk.as_ptr(),
            );
            CGEventPostToPid(target.pid, key_down);
            CGEventPostToPid(target.pid, key_up);
            CFRelease(key_down);
            CFRelease(key_up);
        }
    }
    Ok(())
}
