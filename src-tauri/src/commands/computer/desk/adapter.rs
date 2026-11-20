//! The seam between the rules of computer use and the operating system.
//!
//! Everything above this trait is plain logic and runs in tests against
//! [`fake::FakeDesktop`]. Everything below it is one file per platform in
//! `platform/`.

use super::blocklist::Platform;
use super::keys::{KeyName, Modifier};
use super::types::{ElementInfo, MonitorInfo, PlatformError, PlatformResult, RawNode, Rect, WindowInfo};
use image::RgbaImage;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
}

/// One primitive input event. Coordinates are in the input space.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputOp {
    Move { x: i32, y: i32 },
    Button { button: MouseButton, down: bool },
    /// Wheel notches. Positive `dy` scrolls down, positive `dx` right.
    Scroll { dx: i32, dy: i32 },
    Text(String),
    Modifier { modifier: Modifier, down: bool },
    Tap(KeyName),
}

pub trait Desktop: Send + Sync {
    fn platform(&self) -> Platform;

    /// Can input be simulated at all right now? An `unavailable` error carries
    /// the sentence for the user (Wayland, a missing permission).
    fn input_ready(&self) -> PlatformResult<()>;

    fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>>;

    /// The monitor's pixels, unscaled.
    fn capture(&self, monitor_id: u32) -> PlatformResult<RgbaImage>;

    /// Pointer position in the input space.
    fn cursor(&self) -> PlatformResult<(i32, i32)>;

    /// How many keys the user has pressed by hand so far. Keys LU simulates
    /// are left out. `None` when this platform cannot tell the two apart;
    /// the pointer is then the only sign of a takeover.
    fn user_key_presses(&self) -> Option<u64> {
        None
    }

    /// Visible top level windows, front to back.
    fn windows(&self) -> PlatformResult<Vec<WindowInfo>>;

    /// The window that has the keyboard. `None` when no window does, which is
    /// also what a secure desktop looks like from here.
    fn foreground(&self) -> PlatformResult<Option<WindowInfo>>;

    /// The window a click at this point would land in. The default answers
    /// from the stacking order; a platform with a real hit test overrides it.
    fn window_at(&self, x: i32, y: i32) -> PlatformResult<Option<WindowInfo>> {
        Ok(self.windows()?.into_iter().find(|w| !w.minimized && w.rect.contains(x, y)))
    }

    fn focus_window(&self, window: &WindowInfo) -> PlatformResult<()>;

    /// Put a window at a place, with a size, through the system itself. A
    /// platform that cannot says so, and the model drags the title bar.
    fn place_window(&self, _window: &WindowInfo, _rect: Rect) -> PlatformResult<()> {
        Err(PlatformError::failed("Moving a window this way is not available on this system. Drag its title bar instead."))
    }

    fn input(&self, op: &InputOp) -> PlatformResult<()>;

    /// Let go of every button and modifier that might still be held. Called
    /// when an action is cut short. Best effort, never fails.
    fn release_all(&self);

    /// Does this platform have an accessibility tree here?
    fn tree_available(&self) -> bool {
        false
    }

    /// The tree of `window` in pre-order, at most `budget` elements.
    fn tree(&self, _window: &WindowInfo, _budget: usize) -> PlatformResult<Vec<RawNode>> {
        Err(tree_unavailable())
    }

    /// The element under a point. `Ok(None)` when the platform cannot tell.
    fn element_at(&self, _x: i32, _y: i32) -> PlatformResult<Option<ElementInfo>> {
        Ok(None)
    }

    /// The element that holds the keyboard focus. `Ok(None)` when this
    /// platform has no way to ask. An error when it can ask and the question
    /// failed this time: the engine then treats the focus as unknown and
    /// has the user confirm before text is typed.
    fn focused_element(&self) -> PlatformResult<Option<ElementInfo>> {
        Ok(None)
    }

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub fn tree_unavailable() -> PlatformError {
    PlatformError::unavailable(
        "Reading the interface tree is not available on this platform yet. It works on Windows. Use a screenshot instead.",
    )
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use super::super::types::{AppIdentity, Rect};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// A desktop that exists only in memory. Records every input event and
    /// lets a test script what the foreground window is on each question.
    pub struct FakeDesktop {
        pub platform: Platform,
        pub state: Mutex<FakeState>,
    }

    #[derive(Default)]
    pub struct FakeState {
        pub monitors: Vec<MonitorInfo>,
        pub windows: Vec<WindowInfo>,
        /// Id of the foreground window.
        pub foreground: Option<u64>,
        /// Answers for the next `foreground()` calls, before `foreground`
        /// applies again. This is how a test switches apps mid-action.
        pub foreground_script: VecDeque<Option<u64>>,
        pub cursor: (i32, i32),
        /// Input does not move the pointer when set, as if the user held it.
        pub cursor_follows_input: bool,
        /// Keys pressed by the user. `None` is a platform that cannot count.
        pub user_keys: Option<u64>,
        pub ops: Vec<InputOp>,
        pub released: u32,
        pub pauses: Vec<Duration>,
        pub input_error: Option<PlatformError>,
        pub has_tree: bool,
        pub tree: Vec<RawNode>,
        pub element_at: Option<ElementInfo>,
        pub focused: Option<ElementInfo>,
        /// The focus query fails, as UI Automation does on a window that
        /// does not answer.
        pub focus_error: Option<PlatformError>,
        pub captures: u32,
        /// Asking for a window changes nothing, as when Windows does not
        /// let a process take the foreground.
        pub focus_ignored: bool,
        /// Asking for a window fails and says so.
        pub focus_refused: Option<PlatformError>,
        /// Runs after each input op, with the number of ops so far.
        pub after_op: Option<AfterOp>,
    }

    pub type AfterOp = Box<dyn FnMut(usize, &mut FakeStateView) + Send>;

    /// What an `after_op` hook may change.
    pub struct FakeStateView<'a> {
        pub foreground: &'a mut Option<u64>,
        pub cursor: &'a mut (i32, i32),
        pub user_keys: &'a mut Option<u64>,
        /// The element that holds the focus: a Tab in typed text moves it.
        pub focused: &'a mut Option<ElementInfo>,
    }

    pub fn app(key: &str) -> AppIdentity {
        AppIdentity { key: key.into(), name: key.trim_end_matches(".exe").into(), exe: Some(format!("C:\\Apps\\{key}")), bundle_id: None }
    }

    pub fn window(id: u64, key: &str, rect: Rect) -> WindowInfo {
        WindowInfo { id, pid: 1000 + id as u32, app: app(key), title: format!("{key} window"), rect, ..Default::default() }
    }

    pub fn monitor(id: u32, rect: Rect, scale: f32, primary: bool) -> MonitorInfo {
        MonitorInfo {
            id,
            name: format!("Display {id}"),
            rect,
            pixel_width: rect.width as u32,
            pixel_height: rect.height as u32,
            scale_factor: scale,
            primary,
        }
    }

    impl Default for FakeDesktop {
        fn default() -> Self {
            Self::new()
        }
    }

    impl FakeDesktop {
        /// One 1920x1080 monitor, Notepad in front of LU.
        pub fn new() -> Self {
            let mut lu = window(1, "lu.exe", Rect::new(0, 0, 900, 700));
            lu.is_self = true;
            let state = FakeState {
                monitors: vec![monitor(1, Rect::new(0, 0, 1920, 1080), 1.0, true)],
                windows: vec![window(2, "notepad.exe", Rect::new(200, 100, 1200, 800)), lu],
                foreground: Some(2),
                cursor: (10, 10),
                cursor_follows_input: true,
                ..Default::default()
            };
            Self { platform: Platform::Windows, state: Mutex::new(state) }
        }

        pub fn with<R>(&self, f: impl FnOnce(&mut FakeState) -> R) -> R {
            f(&mut self.state.lock().unwrap())
        }

        pub fn ops(&self) -> Vec<InputOp> {
            self.with(|s| s.ops.clone())
        }
    }

    impl Desktop for FakeDesktop {
        fn platform(&self) -> Platform {
            self.platform
        }
        fn input_ready(&self) -> PlatformResult<()> {
            self.with(|s| s.input_error.clone().map_or(Ok(()), Err))
        }
        fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>> {
            Ok(self.with(|s| s.monitors.clone()))
        }
        fn capture(&self, monitor_id: u32) -> PlatformResult<RgbaImage> {
            self.with(|s| {
                s.captures += 1;
                let m = s.monitors.iter().find(|m| m.id == monitor_id).ok_or_else(|| PlatformError::failed("That display is gone."))?;
                Ok(RgbaImage::from_pixel(m.pixel_width, m.pixel_height, image::Rgba([200, 200, 200, 255])))
            })
        }
        fn cursor(&self) -> PlatformResult<(i32, i32)> {
            Ok(self.with(|s| s.cursor))
        }
        fn user_key_presses(&self) -> Option<u64> {
            self.with(|s| s.user_keys)
        }
        fn windows(&self) -> PlatformResult<Vec<WindowInfo>> {
            Ok(self.with(|s| s.windows.clone()))
        }
        fn foreground(&self) -> PlatformResult<Option<WindowInfo>> {
            Ok(self.with(|s| {
                let id = s.foreground_script.pop_front().unwrap_or(s.foreground);
                id.and_then(|id| s.windows.iter().find(|w| w.id == id).cloned())
            }))
        }
        fn place_window(&self, window: &WindowInfo, rect: Rect) -> PlatformResult<()> {
            self.with(|s| {
                if let Some(found) = s.windows.iter_mut().find(|w| w.id == window.id) {
                    if !found.title.contains("fixed") {
                        found.rect = rect;
                    }
                }
            });
            Ok(())
        }
        fn focus_window(&self, window: &WindowInfo) -> PlatformResult<()> {
            self.with(|s| {
                if let Some(error) = s.focus_refused.clone() {
                    return Err(error);
                }
                if s.focus_ignored {
                    return Ok(());
                }
                s.foreground = Some(window.id);
                if let Some(at) = s.windows.iter().position(|w| w.id == window.id) {
                    let mut w = s.windows.remove(at);
                    w.minimized = false;
                    s.windows.insert(0, w);
                }
                Ok(())
            })
        }
        fn input(&self, op: &InputOp) -> PlatformResult<()> {
            self.with(|s| {
                if let Some(e) = s.input_error.clone() {
                    return Err(e);
                }
                if let (InputOp::Move { x, y }, true) = (op, s.cursor_follows_input) {
                    s.cursor = (*x, *y);
                }
                s.ops.push(op.clone());
                let count = s.ops.len();
                if let Some(mut hook) = s.after_op.take() {
                    hook(count, &mut FakeStateView { foreground: &mut s.foreground, cursor: &mut s.cursor, user_keys: &mut s.user_keys, focused: &mut s.focused });
                    s.after_op = Some(hook);
                }
                Ok(())
            })
        }
        fn release_all(&self) {
            self.with(|s| s.released += 1);
        }
        fn tree_available(&self) -> bool {
            self.with(|s| s.has_tree)
        }
        fn tree(&self, _window: &WindowInfo, budget: usize) -> PlatformResult<Vec<RawNode>> {
            self.with(|s| if s.has_tree { Ok(s.tree.iter().take(budget).cloned().collect()) } else { Err(tree_unavailable()) })
        }
        fn element_at(&self, _x: i32, _y: i32) -> PlatformResult<Option<ElementInfo>> {
            Ok(self.with(|s| s.element_at.clone()))
        }
        fn focused_element(&self) -> PlatformResult<Option<ElementInfo>> {
            self.with(|s| match &s.focus_error {
                Some(error) => Err(error.clone()),
                None => Ok(s.focused.clone()),
            })
        }
        fn pause(&self, duration: Duration) {
            self.with(|s| s.pauses.push(duration));
        }
    }
}
