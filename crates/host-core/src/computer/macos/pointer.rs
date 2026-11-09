//! Target-bound macOS pointer event construction and hit-testing helpers.

use super::super::backend::{DesktopError, TargetRef};
use super::super::{Point, Rect};
use super::ffi::*;
use super::{cf_number_f64, cf_number_i64, dict_value, CfOwned};

#[derive(Clone, Copy)]
pub(super) struct WindowHitRegion {
    pub(super) pid: i64,
    pub(super) window: u64,
    pub(super) bounds: Rect,
    pub(super) alpha: f64,
}

pub(super) fn read_window_hit_stack() -> Result<Vec<WindowHitRegion>, DesktopError> {
    // SAFETY: the returned window list is owned below and is ordered
    // front-to-back by WindowServer.
    let list = unsafe { CGWindowListCopyWindowInfo(WINDOW_LIST_OPTIONS, kCGNullWindowID) };
    if list.is_null() {
        return Err(DesktopError::Failed("window list unavailable".into()));
    }
    let list = CfOwned(list);
    let mut stack = Vec::new();
    // SAFETY: the owned CFArray contains window-info dictionaries.
    unsafe {
        for index in 0..CFArrayGetCount(list.as_ref()) {
            let dict = CFArrayGetValueAtIndex(list.as_ref(), index);
            if dict.is_null() {
                continue;
            }
            // This backend targets normal application windows only; menus,
            // Dock surfaces, and our click-through overlays are separate
            // layers and are not the granted window's pointer receiver.
            let layer = dict_value(dict, "kCGWindowLayer")
                .and_then(cf_number_i64)
                .unwrap_or(0);
            if layer != 0 {
                continue;
            }
            let alpha = dict_value(dict, "kCGWindowAlpha")
                .and_then(cf_number_f64)
                .unwrap_or(1.0);
            if alpha <= 0.01 {
                continue;
            }
            let bounds_dict =
                dict_value(dict, "kCGWindowBounds").ok_or(DesktopError::NotActionable)?;
            let read = |key: &str| {
                dict_value(bounds_dict, key)
                    .and_then(cf_number_f64)
                    .ok_or(DesktopError::NotActionable)
            };
            let window = dict_value(dict, "kCGWindowNumber")
                .and_then(cf_number_i64)
                .ok_or(DesktopError::NotActionable)?;
            let pid = dict_value(dict, "kCGWindowOwnerPID")
                .and_then(cf_number_i64)
                .ok_or(DesktopError::NotActionable)?;
            if window < 0 {
                return Err(DesktopError::NotActionable);
            }
            stack.push(WindowHitRegion {
                pid,
                window: window as u64,
                bounds: Rect {
                    x: read("X")?,
                    y: read("Y")?,
                    width: read("Width")?,
                    height: read("Height")?,
                },
                alpha,
            });
        }
    }
    Ok(stack)
}

pub(super) fn frontmost_window_is_target_at(
    stack: &[WindowHitRegion],
    target: &TargetRef,
    point: Point,
) -> bool {
    stack
        .iter()
        .find(|window| window.alpha > 0.01 && contains_screen_point(window.bounds, point))
        .is_some_and(|window| window.pid == i64::from(target.pid) && window.window == target.window)
}

pub(super) fn window_relative_point(window: Rect, point: Point) -> Result<Point, DesktopError> {
    if !point.x.is_finite() || !point.y.is_finite() || !window.contains(point.x, point.y) {
        return Err(DesktopError::NotActionable);
    }
    Ok(Point {
        x: window.x + point.x,
        y: window.y + point.y,
    })
}

pub(super) fn contains_screen_point(bounds: Rect, point: Point) -> bool {
    point.x.is_finite()
        && point.y.is_finite()
        && bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
        && bounds.width > 0.0
        && bounds.height > 0.0
        && point.x >= bounds.x
        && point.y >= bounds.y
        && point.x < bounds.x + bounds.width
        && point.y < bounds.y + bounds.height
}

pub(super) fn sampled_drag_path(from: Point, to: Point) -> Option<Vec<Point>> {
    const MAX_SEGMENT: f64 = 24.0;
    const MAX_SEGMENTS: usize = 2_048;
    if ![from.x, from.y, to.x, to.y].into_iter().all(f64::is_finite) {
        return None;
    }
    let distance = (to.x - from.x).hypot(to.y - from.y);
    let segments = (distance / MAX_SEGMENT).ceil().max(1.0) as usize;
    if segments > MAX_SEGMENTS {
        return None;
    }
    Some(
        (1..=segments)
            .map(|step| {
                let ratio = step as f64 / segments as f64;
                Point {
                    x: from.x + (to.x - from.x) * ratio,
                    y: from.y + (to.y - from.y) * ratio,
                }
            })
            .collect(),
    )
}

pub(super) fn post_mouse_event(
    pid: i32,
    event_type: u32,
    point: Point,
) -> Result<(), DesktopError> {
    // SAFETY: the event is created for this concrete screen coordinate and
    // dropped immediately after posting to the validated target process.
    let event = unsafe {
        CGEventCreateMouseEvent(
            std::ptr::null(),
            event_type,
            CGPoint {
                x: point.x,
                y: point.y,
            },
            kCGMouseButtonLeft,
        )
    };
    if event.is_null() {
        return Err(DesktopError::Failed("mouse event".into()));
    }
    let event = CfOwned(event);
    // SAFETY: the event remains owned until the call returns.
    unsafe { CGEventPostToPid(pid, event.as_ref()) };
    Ok(())
}
