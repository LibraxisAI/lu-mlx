//! Counts the keys the user presses by hand, so an autonomous run can stop
//! when the user reaches for the keyboard.
//!
//! A low-level keyboard hook sees every key event together with the flag
//! that marks a simulated one. The hook only counts. It never looks at which
//! key it was and never holds an event back. It is installed when the count
//! is first asked for and removed again once nobody has asked for a while,
//! so it exists only around autonomous computer control.

use super::super::takeover;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, KillTimer, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    WM_TIMER,
};

/// The hook goes away when the count was not asked for this long.
const IDLE_MS: u64 = 60_000;
const IDLE_CHECK_MS: u32 = 5_000;

static PRESSED: AtomicU64 = AtomicU64::new(0);
static ASKED_AT: AtomicU64 = AtomicU64::new(0);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// Windows refused the hook once. Do not try again in this run of LU.
static REFUSED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Keys pressed by hand since LU started watching. `None` when the hook
/// cannot be installed.
pub fn pressed() -> Option<u64> {
    if REFUSED.load(Ordering::Relaxed) {
        return None;
    }
    ASKED_AT.store(now_ms(), Ordering::Relaxed);
    if !WATCHING.swap(true, Ordering::SeqCst) {
        let started = std::thread::Builder::new().name("lu-computer-keys".into()).spawn(watch);
        if started.is_err() {
            WATCHING.store(false, Ordering::SeqCst);
            return None;
        }
    }
    Some(PRESSED.load(Ordering::Relaxed))
}

/// A low-level hook is called on the thread that installed it, through that
/// thread's message loop. So this thread does nothing but pump messages.
fn watch() {
    unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), std::ptr::null_mut(), 0);
        if hook.is_null() {
            REFUSED.store(true, Ordering::Relaxed);
            WATCHING.store(false, Ordering::SeqCst);
            return;
        }
        let timer = SetTimer(std::ptr::null_mut(), 0, IDLE_CHECK_MS, None);
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            let idle = now_ms().saturating_sub(ASKED_AT.load(Ordering::Relaxed));
            if message.message == WM_TIMER && idle > IDLE_MS {
                break;
            }
        }
        if timer != 0 {
            KillTimer(std::ptr::null_mut(), timer);
        }
        UnhookWindowsHookEx(hook);
        WATCHING.store(false, Ordering::SeqCst);
    }
}

unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && lparam != 0 {
        let event = &*(lparam as *const KBDLLHOOKSTRUCT);
        if takeover::user_key_down(wparam as u32, event.flags) {
            PRESSED.fetch_add(1, Ordering::Relaxed);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}
