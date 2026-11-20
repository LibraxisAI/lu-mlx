//! The user reaching for the keyboard while LU works on its own.
//!
//! The decisions live here as plain functions, so they are tested on every
//! system. Only Windows can tell a key the user pressed from one that LU
//! simulated, so only the Windows adapter counts them.

/// `WM_KEYDOWN` and `WM_SYSKEYDOWN`, the two messages a pressed key arrives as.
const KEY_DOWN: u32 = 0x0100;
const SYSTEM_KEY_DOWN: u32 = 0x0104;
/// `LLKHF_LOWER_IL_INJECTED` and `LLKHF_INJECTED`: the event was simulated.
const INJECTED: u32 = 0x02 | 0x10;

/// Is this low-level keyboard event a key the user pressed by hand? Keys LU
/// or any other program simulates carry the injected flag and do not count.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn user_key_down(message: u32, flags: u32) -> bool {
    (message == KEY_DOWN || message == SYSTEM_KEY_DOWN) && flags & INJECTED == 0
}

/// Did the user press a key between two readings of the counter? A platform
/// that cannot count answers `None`, and that is never a takeover.
pub fn keys_pressed_since(before: Option<u64>, now: Option<u64>) -> bool {
    matches!((before, now), (Some(before), Some(now)) if now != before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_pressed_by_hand_counts() {
        assert!(user_key_down(KEY_DOWN, 0));
        assert!(user_key_down(SYSTEM_KEY_DOWN, 0));
        // Extended key and Alt held are ordinary flags of a real key.
        assert!(user_key_down(KEY_DOWN, 0x01 | 0x20));
    }

    #[test]
    fn a_simulated_key_does_not_count() {
        assert!(!user_key_down(KEY_DOWN, 0x10));
        assert!(!user_key_down(KEY_DOWN, 0x02));
        assert!(!user_key_down(SYSTEM_KEY_DOWN, 0x10 | 0x20));
    }

    #[test]
    fn letting_a_key_go_does_not_count() {
        assert!(!user_key_down(0x0101, 0));
        assert!(!user_key_down(0x0105, 0));
    }

    #[test]
    fn only_a_changed_count_is_a_takeover() {
        assert!(keys_pressed_since(Some(4), Some(5)));
        assert!(!keys_pressed_since(Some(4), Some(4)));
        assert!(!keys_pressed_since(None, Some(9)));
        assert!(!keys_pressed_since(Some(9), None));
        assert!(!keys_pressed_since(None, None));
    }
}
