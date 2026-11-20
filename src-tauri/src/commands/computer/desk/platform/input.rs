//! Input events on `enigo` (MIT), shared by all three systems.
//!
//! The `Enigo` handle stays on the thread that created it: it holds raw
//! handles and, with `release_keys_when_dropped`, lets go of every held key
//! when that thread ends.

use super::super::adapter::{InputOp, MouseButton};
use super::super::keys::{KeyName, Modifier};
use super::super::types::{PlatformError, PlatformResult};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, NewConError, Settings};
use std::cell::RefCell;

thread_local! {
    static ENIGO: RefCell<Option<Enigo>> = const { RefCell::new(None) };
}

fn connect() -> PlatformResult<Enigo> {
    let settings = Settings {
        // LU says in its own words what is missing; no system prompt.
        open_prompt_to_get_permissions: false,
        release_keys_when_dropped: true,
        ..Settings::default()
    };
    Enigo::new(&settings).map_err(|error| match error {
        NewConError::NoPermission => PlatformError::needs(
            super::super::types::Permission::Accessibility,
            "LU needs the Accessibility permission to control the mouse and keyboard. Grant it in System Settings under Privacy and Security, Accessibility, then try again.",
        ),
        _ => PlatformError::unavailable("LU could not connect to the input system of this desktop."),
    })
}

/// Run `work` with this thread's input handle, creating it on first use.
pub fn with_enigo<R>(work: impl FnOnce(&mut Enigo) -> PlatformResult<R>) -> PlatformResult<R> {
    ENIGO.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(connect()?);
        }
        work(slot.as_mut().expect("just created"))
    })
}

/// Can this thread simulate input at all?
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn ready() -> PlatformResult<()> {
    with_enigo(|_| Ok(()))
}

fn failed(what: &str) -> PlatformError {
    PlatformError::failed(format!("The system did not accept the simulated {what}."))
}

fn button(button: MouseButton) -> Button {
    match button {
        MouseButton::Left => Button::Left,
        MouseButton::Right => Button::Right,
    }
}

fn modifier(modifier: Modifier) -> Key {
    match modifier {
        Modifier::Control => Key::Control,
        Modifier::Shift => Key::Shift,
        Modifier::Alt => Key::Alt,
        Modifier::Meta => Key::Meta,
    }
}

fn key(name: KeyName) -> PlatformResult<Key> {
    Ok(match name {
        KeyName::Enter => Key::Return,
        KeyName::Tab => Key::Tab,
        KeyName::Escape => Key::Escape,
        KeyName::Backspace => Key::Backspace,
        KeyName::Delete => Key::Delete,
        KeyName::Space => Key::Space,
        KeyName::Up => Key::UpArrow,
        KeyName::Down => Key::DownArrow,
        KeyName::Left => Key::LeftArrow,
        KeyName::Right => Key::RightArrow,
        KeyName::Home => Key::Home,
        KeyName::End => Key::End,
        KeyName::PageUp => Key::PageUp,
        KeyName::PageDown => Key::PageDown,
        KeyName::F(n) => match n {
            1 => Key::F1,
            2 => Key::F2,
            3 => Key::F3,
            4 => Key::F4,
            5 => Key::F5,
            6 => Key::F6,
            7 => Key::F7,
            8 => Key::F8,
            9 => Key::F9,
            10 => Key::F10,
            11 => Key::F11,
            12 => Key::F12,
            13 => Key::F13,
            14 => Key::F14,
            15 => Key::F15,
            16 => Key::F16,
            17 => Key::F17,
            18 => Key::F18,
            19 => Key::F19,
            20 => Key::F20,
            _ => return Err(PlatformError::failed("That function key does not exist.")),
        },
        KeyName::Char(c) => Key::Unicode(c),
    })
}

/// Send one event. A pointer move uses the coordinates as they are, which is
/// right on macOS (points) and X11 (pixels of the root window). Windows moves
/// the pointer itself, because `enigo` maps an absolute move onto the primary
/// monitor only.
pub fn apply(enigo: &mut Enigo, op: &InputOp) -> PlatformResult<()> {
    match op {
        InputOp::Move { x, y } => enigo.move_mouse(*x, *y, Coordinate::Abs).map_err(|_| failed("pointer move")),
        InputOp::Button { button: b, down } => enigo
            .button(button(*b), if *down { Direction::Press } else { Direction::Release })
            .map_err(|_| failed("mouse button")),
        InputOp::Scroll { dx, dy } => {
            if *dy != 0 {
                enigo.scroll(*dy, Axis::Vertical).map_err(|_| failed("scroll"))?;
            }
            if *dx != 0 {
                enigo.scroll(*dx, Axis::Horizontal).map_err(|_| failed("scroll"))?;
            }
            Ok(())
        }
        InputOp::Text(text) => enigo.text(text).map_err(|_| failed("text")),
        InputOp::Modifier { modifier: m, down } => enigo
            .key(modifier(*m), if *down { Direction::Press } else { Direction::Release })
            .map_err(|_| failed("key")),
        InputOp::Tap(name) => enigo.key(key(*name)?, Direction::Click).map_err(|_| failed("key")),
    }
}

/// Let go of both mouse buttons and all four modifiers. Releasing something
/// that is not held does nothing.
pub fn release_all(enigo: &mut Enigo) {
    for b in [Button::Left, Button::Right] {
        let _ = enigo.button(b, Direction::Release);
    }
    for m in [Key::Control, Key::Shift, Key::Alt, Key::Meta] {
        let _ = enigo.key(m, Direction::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests only map names. They never create an `Enigo` and never send
    // an event.

    #[test]
    fn every_named_key_maps() {
        for name in [
            KeyName::Enter, KeyName::Tab, KeyName::Escape, KeyName::Backspace, KeyName::Delete, KeyName::Space,
            KeyName::Up, KeyName::Down, KeyName::Left, KeyName::Right, KeyName::Home, KeyName::End, KeyName::PageUp,
            KeyName::PageDown,
        ] {
            assert!(key(name).is_ok(), "{name:?}");
        }
        for n in 1..=20 {
            assert!(key(KeyName::F(n)).is_ok());
        }
        assert!(key(KeyName::F(21)).is_err());
        assert_eq!(key(KeyName::Char('ß')).unwrap(), Key::Unicode('ß'));
    }

    #[test]
    fn modifiers_and_buttons_map() {
        assert_eq!(modifier(Modifier::Control), Key::Control);
        assert_eq!(modifier(Modifier::Meta), Key::Meta);
        assert_eq!(button(MouseButton::Right), Button::Right);
    }
}
