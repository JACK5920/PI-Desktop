use x11rb::protocol::xproto::{ConnectionExt, MapState, Window};
use x11rb::rust_connection::RustConnection;

use crate::computer::DesktopError;

use super::{is_descendant_window, x11_error, MAX_X11_WINDOWS};

pub(super) fn ensure_target_hit(
    connection: &RustConnection,
    root: Window,
    target: u64,
    x: i16,
    y: i16,
) -> Result<(), DesktopError> {
    let target = u32::try_from(target).map_err(|_| DesktopError::TargetGone)?;
    if !is_descendant_window(connection, target, root) {
        return Err(DesktopError::TargetGone);
    }
    let mut visited = 0;
    let recipient = topmost_window_at(connection, root, x, y, 0, &mut visited)?;
    if is_descendant_window(connection, recipient, target) {
        Ok(())
    } else {
        Err(DesktopError::NotActionable)
    }
}

fn topmost_window_at(
    connection: &RustConnection,
    parent: Window,
    x: i16,
    y: i16,
    depth: usize,
    visited: &mut usize,
) -> Result<Window, DesktopError> {
    const MAX_WINDOW_DEPTH: usize = 64;
    if depth >= MAX_WINDOW_DEPTH || *visited >= MAX_X11_WINDOWS {
        return Err(DesktopError::NotActionable);
    }
    let children = connection
        .query_tree(parent)
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?
        .children;

    // QueryTree lists siblings bottom-to-top. The first mapped child containing
    // the point when walked backwards is therefore the actual input recipient.
    for child in children.into_iter().rev() {
        *visited += 1;
        if *visited > MAX_X11_WINDOWS {
            return Err(DesktopError::NotActionable);
        }
        let attributes = connection
            .get_window_attributes(child)
            .map_err(x11_error)?
            .reply()
            .map_err(x11_error)?;
        if attributes.map_state != MapState::VIEWABLE {
            continue;
        }
        let geometry = connection
            .get_geometry(child)
            .map_err(x11_error)?
            .reply()
            .map_err(x11_error)?;
        let translated = connection
            .translate_coordinates(parent, child, x, y)
            .map_err(x11_error)?
            .reply()
            .map_err(x11_error)?;
        let border = i32::from(geometry.border_width);
        let dst_x = i32::from(translated.dst_x);
        let dst_y = i32::from(translated.dst_y);
        if !translated.same_screen
            || dst_x < -border
            || dst_y < -border
            || dst_x >= i32::from(geometry.width) + border
            || dst_y >= i32::from(geometry.height) + border
        {
            continue;
        }
        return topmost_window_at(
            connection,
            child,
            translated.dst_x,
            translated.dst_y,
            depth + 1,
            visited,
        );
    }
    Ok(parent)
}
