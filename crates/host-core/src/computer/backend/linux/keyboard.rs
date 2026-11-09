use std::collections::HashMap;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, Window, KEY_PRESS_EVENT, KEY_RELEASE_EVENT};
use x11rb::protocol::xtest::ConnectionExt as XTestConnectionExt;
use x11rb::rust_connection::RustConnection;

use crate::computer::DesktopError;

use super::{is_descendant_window, x11_error};

const XK_BACKSPACE: u32 = 0xff08;
const XK_TAB: u32 = 0xff09;
const XK_RETURN: u32 = 0xff0d;
const XK_ESCAPE: u32 = 0xff1b;
const XK_HOME: u32 = 0xff50;
const XK_LEFT: u32 = 0xff51;
const XK_UP: u32 = 0xff52;
const XK_RIGHT: u32 = 0xff53;
const XK_DOWN: u32 = 0xff54;
const XK_PAGE_UP: u32 = 0xff55;
const XK_PAGE_DOWN: u32 = 0xff56;
const XK_END: u32 = 0xff57;
const XK_DELETE: u32 = 0xffff;
const XK_SHIFT_L: u32 = 0xffe1;
const XK_CONTROL_L: u32 = 0xffe3;
const XK_ALT_L: u32 = 0xffe9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyChord {
    key: u32,
    control: bool,
    shift: bool,
    alt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyStroke {
    keycode: u8,
    shift: bool,
}

pub(super) fn press_keys(
    connection: &RustConnection,
    target: Window,
    chords: &[String],
) -> Result<(), DesktopError> {
    let focused = connection
        .get_input_focus()
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?
        .focus;
    if focused == 0 || !is_descendant_window(connection, focused, target) {
        return Err(DesktopError::NotActionable);
    }
    let root = connection
        .setup()
        .roots
        .iter()
        .find(|screen| is_descendant_window(connection, target, screen.root))
        .map(|screen| screen.root)
        .ok_or(DesktopError::NotActionable)?;
    let keymap = keyboard_mapping(connection)?;

    let mut strokes = Vec::with_capacity(chords.len());
    for chord in chords {
        let parsed = parse_key_chord(chord).ok_or(DesktopError::NotActionable)?;
        let key = lookup_key(&keymap, parsed.key)?;
        let control = if parsed.control {
            Some(lookup_key(&keymap, XK_CONTROL_L)?.keycode)
        } else {
            None
        };
        let shift = if parsed.shift || key.shift {
            Some(lookup_key(&keymap, XK_SHIFT_L)?.keycode)
        } else {
            None
        };
        let alt = if parsed.alt {
            Some(lookup_key(&keymap, XK_ALT_L)?.keycode)
        } else {
            None
        };
        strokes.push((key.keycode, control, shift, alt));
    }

    for (key, control, shift, alt) in strokes {
        let mut pressed = Vec::with_capacity(4);
        let modifiers = [control, alt, shift].into_iter().flatten();
        for modifier in modifiers {
            send_key(connection, root, modifier, true)?;
            pressed.push(modifier);
        }
        let result = send_key(connection, root, key, true)
            .and_then(|()| send_key(connection, root, key, false));
        if result.is_err() {
            for modifier in pressed.into_iter().rev() {
                let _ = send_key(connection, root, modifier, false);
            }
            return result;
        }
        for modifier in pressed.into_iter().rev() {
            send_key(connection, root, modifier, false)?;
        }
    }
    Ok(())
}

fn parse_key_chord(input: &str) -> Option<KeyChord> {
    let parts = input.split('+').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let mut control = false;
    let mut shift = false;
    let mut alt = false;
    for modifier in &parts[..parts.len() - 1] {
        let flag = match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => &mut control,
            "shift" => &mut shift,
            "alt" => &mut alt,
            _ => return None,
        };
        if *flag {
            return None;
        }
        *flag = true;
    }
    let key = keysym(parts.last()?)?;
    Some(KeyChord {
        key,
        control,
        shift,
        alt,
    })
}

fn keysym(name: &str) -> Option<u32> {
    if name.chars().count() == 1 {
        let character = name.chars().next()?;
        return (character.is_ascii() && !character.is_control()).then_some(u32::from(character));
    }
    let lower = name.to_ascii_lowercase();
    Some(match lower.as_str() {
        "enter" | "return" => XK_RETURN,
        "tab" => XK_TAB,
        "esc" | "escape" => XK_ESCAPE,
        "space" => u32::from(b' '),
        "backspace" => XK_BACKSPACE,
        "delete" | "del" => XK_DELETE,
        "home" => XK_HOME,
        "end" => XK_END,
        "pageup" => XK_PAGE_UP,
        "pagedown" => XK_PAGE_DOWN,
        "up" => XK_UP,
        "down" => XK_DOWN,
        "left" => XK_LEFT,
        "right" => XK_RIGHT,
        _ if lower.starts_with('f') => {
            let number = lower[1..].parse::<u32>().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            0xffbd + number
        }
        _ => return None,
    })
}

fn keyboard_mapping(connection: &RustConnection) -> Result<HashMap<u32, KeyStroke>, DesktopError> {
    let setup = connection.setup();
    let count = setup.max_keycode - setup.min_keycode + 1;
    let mapping = connection
        .get_keyboard_mapping(setup.min_keycode, count)
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?;
    let mut keymap = HashMap::new();
    for (index, keysyms) in mapping
        .keysyms
        .chunks(usize::from(mapping.keysyms_per_keycode))
        .enumerate()
    {
        let keycode =
            setup.min_keycode + u8::try_from(index).map_err(|_| DesktopError::NotActionable)?;
        for (level, keysym) in keysyms.iter().enumerate() {
            if *keysym != 0 && level <= 1 {
                keymap.entry(*keysym).or_insert(KeyStroke {
                    keycode,
                    shift: level == 1,
                });
            }
        }
    }
    Ok(keymap)
}

fn lookup_key(keymap: &HashMap<u32, KeyStroke>, wanted: u32) -> Result<KeyStroke, DesktopError> {
    keymap
        .get(&wanted)
        .copied()
        .ok_or(DesktopError::NotActionable)
}

fn send_key(
    connection: &RustConnection,
    root: Window,
    keycode: u8,
    pressed: bool,
) -> Result<(), DesktopError> {
    let event_type = if pressed {
        KEY_PRESS_EVENT
    } else {
        KEY_RELEASE_EVENT
    };
    connection
        .xtest_fake_input(event_type, keycode, 0, root, 0, 0, 0)
        .map_err(x11_error)?
        .check()
        .map_err(x11_error)?;
    connection.flush().map_err(x11_error)
}

#[cfg(test)]
mod tests;
