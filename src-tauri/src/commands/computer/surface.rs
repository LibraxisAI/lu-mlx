//! What the user sees of LU while it works on the screen.
//!
//! While a screen task runs, LU's main window is not a window to work in. It
//! shrinks to a small panel in a corner of the display the task
//! runs on, and the edge of that display glows. The panel shows what the
//! model thinks and does, asks the questions of computer control and carries
//! Pause and Stop, so it takes clicks at any time. It takes the keyboard
//! only while the session is paused and the user types. Panel and glow are
//! kept out of the screenshots the model gets. The paused session can cover
//! the whole display instead; the interface decides.
//!
//! The panel has one size for as long as it is up. It stands in one of the
//! four corners of the work area, the top right one unless the user chose
//! another, and it leaves a corner for two reasons only. The user sends it
//! to another one with the grip in its head. Or the model aims at a spot
//! under it: the panel takes clicks, so that spot is out of reach and black
//! in the screenshot. Then it slides to a corner the action does not need
//! and stays there until an action needs that one. Which corner is decided
//! by [`evade`]; nothing else moves the window.
//!
//! The interface decides which of these it wants and says so again every few
//! seconds. That is a lease: when the interface goes silent (a crash, a
//! reload), the window goes back to where it was and the glow goes away by
//! themselves. Nothing here is written to disk, so the size of the panel can
//! never come back as the size of the window after a restart.
//!
//! The geometry is plain functions, tested on every system. Which parts a
//! system gets is decided in one place each: [`shrinks`], [`glows`],
//! [`glass`] and [`input_in_points`].

#[cfg(target_os = "windows")]
use super::desk::engine::PASSTHROUGH_TITLE;
use super::desk::types::Rect;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const MAIN: &str = "main";
/// The window that draws the glow. It has no capability: it runs no script
/// and calls nothing.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const GLOW: &str = "computer-glow";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const GLOW_PAGE: &str = "computer-glow.html";

/// The size of the panel in the units of the interface, before display
/// scaling. The interface draws to the same numbers
/// (src/lib/computer/surface.ts); a test there holds the two together.
pub const PANEL_SIZE: (f64, f64) = (380.0, 480.0);
/// Distance of the panel from the edges of the work area.
pub const MARGIN: f64 = 12.0;
/// How long the interface may stay silent before everything is put back.
pub const LEASE: Duration = Duration::from_secs(10);
/// A corner counts as free for an action when no point of it is this close
/// to the panel there, in the units of the interface.
pub const CLEARANCE: f64 = 16.0;
/// The slide from one corner to another: this many places, one per tick.
const GLIDE_STEPS: u32 = 14;
const GLIDE_TICK: Duration = Duration::from_millis(16);

/// A corner of the work area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Corner {
    #[default]
    TopRight,
    BottomRight,
    BottomLeft,
    TopLeft,
}

impl Corner {
    pub const ALL: [Corner; 4] = [Corner::TopRight, Corner::BottomRight, Corner::BottomLeft, Corner::TopLeft];

    pub fn top(self) -> bool {
        matches!(self, Corner::TopRight | Corner::TopLeft)
    }
    pub fn right(self) -> bool {
        matches!(self, Corner::TopRight | Corner::BottomRight)
    }
    fn at(top: bool, right: bool) -> Corner {
        match (top, right) {
            (true, true) => Corner::TopRight,
            (false, true) => Corner::BottomRight,
            (false, false) => Corner::BottomLeft,
            (true, false) => Corner::TopLeft,
        }
    }
    /// The next one around the display: what one press on the grip does.
    pub fn clockwise(self) -> Corner {
        match self {
            Corner::TopRight => Corner::BottomRight,
            Corner::BottomRight => Corner::BottomLeft,
            Corner::BottomLeft => Corner::TopLeft,
            Corner::TopLeft => Corner::TopRight,
        }
    }
    /// Where the panel looks for room, nearest first: straight down or up on
    /// its own side, then across, then the far corner. Down before across
    /// because the top of a display is where apps keep their menus, their
    /// tabs and their window buttons, on both sides.
    pub fn ways_out(self) -> [Corner; 3] {
        [Corner::at(!self.top(), self.right()), Corner::at(self.top(), !self.right()), Corner::at(!self.top(), !self.right())]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// The ordinary window, where the user left it.
    #[default]
    Window,
    /// The small panel in the corner of the display.
    Panel,
    /// The whole display, for the paused session.
    Pause,
}

/// Does the main window shrink to the panel on this system? Not on Linux: computer
/// control has never run there, and its webview has lost undecorated windows
/// before. There the window stays and shows a bar instead.
pub fn shrinks() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

/// Does the edge of the display glow on this system? That takes a
/// transparent window. Windows has one; the macOS build would need a private
/// system interface for it, and on Linux a transparent webview does not draw.
pub fn glows() -> bool {
    cfg!(target_os = "windows")
}

/// Is the main window see-through around what it shows? Then the panel has
/// round corners. Only the Windows build has a see-through main window; on
/// macOS that needs the same private interface as the glow.
pub fn glass() -> bool {
    cfg!(target_os = "windows")
}

/// A display as Tauri reports it, in real pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Display {
    pub position: (i32, i32),
    pub size: (u32, u32),
    /// The part without the taskbar or the menu bar.
    pub work: Rect,
    pub scale: f64,
}

fn px(units: f64, scale: f64) -> i32 {
    (units * scale).round() as i32
}

/// A box of `size` in a corner of the work area. It never reaches outside
/// the work area, however small that is, so the taskbar and the menu bar
/// stay free wherever they are.
pub fn corner_rect(display: &Display, size: (f64, f64), corner: Corner) -> Rect {
    let margin = px(MARGIN, display.scale);
    let width = px(size.0, display.scale).min((display.work.width - 2 * margin).max(1));
    let height = px(size.1, display.scale).min((display.work.height - 2 * margin).max(1));
    let x = if corner.right() { display.work.x + display.work.width - margin - width } else { display.work.x + margin };
    let y = if corner.top() { display.work.y + margin } else { display.work.y + display.work.height - margin - height };
    Rect::new(x, y, width, height)
}

/// Do the adapters count in points where Tauri counts in pixels? Only on
/// macOS. Windows and X11 use real pixels on both sides.
pub fn input_in_points() -> bool {
    cfg!(target_os = "macos")
}

/// A place of the window, as the adapters would name it (see
/// [`same_display`] for the two ways of counting).
pub fn to_input(rect: Rect, scale: f64, in_points: bool) -> Rect {
    if !in_points || scale <= 0.0 {
        return rect;
    }
    let at = |value: i32| (f64::from(value) / scale).round() as i32;
    Rect::new(at(rect.x), at(rect.y), at(rect.width), at(rect.height))
}

fn grown(rect: &Rect, by: i32) -> Rect {
    Rect::new(rect.x - by, rect.y - by, rect.width + 2 * by, rect.height + 2 * by)
}

/// The corner the panel moves to when an action aims at the one it is in.
///
/// `places` is where the panel would be in each corner and `aims` are the
/// points of the action, both in the input space. A corner is free when no
/// aim is in it or within `clearance` of it. Of the free ones, a corner no
/// action has needed yet wins, then the one needed longest ago (`needed` is
/// oldest first), so two targets in two corners do not send the panel back
/// and forth. Among equals the nearest way out wins. `None` when every
/// corner is taken: the display is too small to step aside on.
pub fn evade(current: Corner, places: &[(Corner, Rect)], aims: &[(i32, i32)], needed: &[Corner], clearance: i32) -> Option<Corner> {
    let free = |corner: Corner| {
        places.iter().find(|(c, _)| *c == corner).is_some_and(|(_, rect)| {
            let keep = grown(rect, clearance);
            !aims.iter().any(|(x, y)| keep.contains(*x, *y))
        })
    };
    let last_needed = |corner: Corner| needed.iter().rposition(|c| *c == corner).map_or(0, |at| at + 1);
    current.ways_out().into_iter().filter(|corner| free(*corner)).min_by_key(|corner| last_needed(*corner))
}

/// The places the window passes on its way from one corner to another: it
/// starts fast and comes to rest. The last one is exactly `to`.
pub fn glide_path(from: (i32, i32), to: (i32, i32), steps: u32) -> Vec<(i32, i32)> {
    let steps = steps.max(1);
    (1..=steps)
        .map(|step| {
            if step == steps {
                return to;
            }
            let left = 1.0 - f64::from(step) / f64::from(steps);
            let done = 1.0 - left * left * left;
            let between = |a: i32, b: i32| a + (f64::from(b - a) * done).round() as i32;
            (between(from.0, to.0), between(from.1, to.1))
        })
        .collect()
}

/// The whole display, one pixel short at the bottom. A window of exactly the
/// size of the display counts as a full screen app to Windows, which then
/// hides the taskbar and holds back notifications.
pub fn cover_rect(display: &Display) -> Rect {
    Rect::new(display.position.0, display.position.1, display.size.0 as i32, (display.size.1 as i32 - 1).max(1))
}

/// Where the main window goes in a mode. `None` for the ordinary window,
/// which goes back to where the user left it.
pub fn mode_rect(mode: Mode, display: &Display, corner: Corner) -> Option<Rect> {
    match mode {
        Mode::Window => None,
        Mode::Panel => Some(corner_rect(display, PANEL_SIZE, corner)),
        Mode::Pause => Some(cover_rect(display)),
    }
}

/// Is this the display computer control works on? The adapters report a
/// display in the input space, which is real pixels on Windows and points on
/// macOS, so both readings of Tauri's position are compared.
pub fn same_display(display: &Display, input_origin: (i32, i32)) -> bool {
    let logical = ((f64::from(display.position.0) / display.scale).round() as i32, (f64::from(display.position.1) / display.scale).round() as i32);
    display.position == input_origin || logical == input_origin
}

/// The lease the interface renews. Without it nothing stays up.
#[derive(Debug, Default)]
pub struct Lease {
    until: Option<Instant>,
}

impl Lease {
    pub fn renew(&mut self, now: Instant) {
        self.until = Some(now + LEASE);
    }
    pub fn end(&mut self) {
        self.until = None;
    }
    pub fn held(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }
    /// It was held and ran out: put everything back.
    pub fn ran_out(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now >= until)
    }
}

/// The main window as the user left it.
struct Saved {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
    fullscreen: bool,
    decorated: bool,
    resizable: bool,
}

#[derive(Default)]
struct State {
    mode: Mode,
    saved: Option<Saved>,
    /// Where the main window was last put. The lease asks again every few
    /// seconds, and a window that is already there is left alone.
    placed: Option<Rect>,
    lease: Lease,
    glow: bool,
    /// The display of the task, as the adapters name it.
    input_origin: Option<(i32, i32)>,
    watching: bool,
    /// The corner the panel is in, or goes to when it comes up.
    corner: Corner,
    /// The corner the user chose. The panel starts there for as long as LU
    /// runs; nothing of it is written to disk.
    home: Corner,
    /// The corners an action needed since the panel came up, oldest first.
    needed: Vec<Corner>,
    /// The window takes the keyboard: the paused view is in it.
    focus: bool,
    /// The user asked the system for less motion: the panel does not slide.
    still: bool,
}

impl State {
    /// The panel is gone. The next one starts where the user wants it.
    fn rest(&mut self) {
        self.corner = self.home;
        self.needed.clear();
    }
}

/// What became of the place an action aimed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Room {
    /// The panel was over it and has moved to this corner.
    Made(Corner),
    /// The panel is not over it.
    Free,
    /// The panel is over it and has nowhere to go.
    Stuck,
}

#[derive(Clone, Default)]
pub struct Surface {
    state: Arc<Mutex<State>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub mode: Mode,
    pub glow: bool,
    /// The window is see-through around the panel, so the panel can be round.
    pub glass: bool,
    /// The corner the panel is in, or comes up in.
    pub corner: Corner,
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn displays(window: &WebviewWindow) -> Vec<Display> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let work = m.work_area();
            Display {
                position: (m.position().x, m.position().y),
                size: (m.size().width, m.size().height),
                work: Rect::new(work.position.x, work.position.y, work.size.width as i32, work.size.height as i32),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

/// The display of the task, else the one the window is on, else the first.
fn pick_display(window: &WebviewWindow, input_origin: Option<(i32, i32)>, saved: Option<&Saved>) -> Option<Display> {
    let all = displays(window);
    if let Some(found) = input_origin.and_then(|origin| all.iter().find(|d| same_display(d, origin))) {
        return Some(*found);
    }
    // While the window is the panel, "the display it is on" is the one it was on before.
    let at = saved.map(|s| (s.position.x + s.size.width as i32 / 2, s.position.y + s.size.height as i32 / 2));
    let by_place = at.and_then(|(x, y)| {
        all.iter().find(|d| x >= d.position.0 && x < d.position.0 + d.size.0 as i32 && y >= d.position.1 && y < d.position.1 + d.size.1 as i32)
    });
    by_place.or_else(|| all.first()).copied()
}

impl Surface {
    pub fn mode(&self) -> Mode {
        lock(&self.state).mode
    }

    /// What the interface asks for. `active` is "computer control is busy":
    /// it holds the lease and the glow. `take_focus` is for the paused
    /// session, where the user types and Escape has to arrive.
    pub fn apply(&self, app: &AppHandle, wanted: Mode, active: bool, take_focus: bool, input_origin: Option<(i32, i32)>, still: bool) -> Applied {
        let mut state = lock(&self.state);
        if input_origin.is_some() {
            state.input_origin = input_origin;
        }
        state.still = still;
        let wanted = if active && shrinks() { wanted } else { Mode::Window };
        if active {
            state.lease.renew(Instant::now());
        } else {
            state.lease.end();
            state.input_origin = None;
        }
        state.focus = take_focus && wanted != Mode::Window;
        if let Some(window) = app.get_webview_window(MAIN) {
            set_main(&window, &mut state, wanted);
        }
        set_glow(app, &mut state, active);
        if active && !state.watching {
            state.watching = true;
            self.watch(app.clone());
        }
        applied(&state)
    }

    /// An action aims at these points of the input space. When the panel is
    /// over one of them it moves to a corner where it is over none, and
    /// stays there. Never called on the main thread: the window is moved
    /// and read under the lock.
    pub fn make_room(&self, app: &AppHandle, aims: &[(i32, i32)]) -> Room {
        let mut state = lock(&self.state);
        if state.mode != Mode::Panel {
            return Room::Free;
        }
        let Some(window) = app.get_webview_window(MAIN) else { return Room::Free };
        let Some(display) = pick_display(&window, state.input_origin, state.saved.as_ref()) else { return Room::Stuck };
        let places = Corner::ALL.map(|corner| (corner, to_input(corner_rect(&display, PANEL_SIZE, corner), display.scale, input_in_points())));
        let here = places.iter().find(|(corner, _)| *corner == state.corner).map(|(_, rect)| *rect).unwrap_or_default();
        if !aims.iter().any(|(x, y)| here.contains(*x, *y)) {
            return Room::Free;
        }
        let clearance = if input_in_points() { CLEARANCE.round() as i32 } else { px(CLEARANCE, display.scale) };
        let Some(next) = evade(state.corner, &places, aims, &state.needed, clearance) else { return Room::Stuck };
        let left = state.corner;
        state.needed.retain(|corner| *corner != left);
        state.needed.push(left);
        state.corner = next;
        set_main(&window, &mut state, Mode::Panel);
        Room::Made(next)
    }

    /// The user sends the panel to a corner with the grip: to the one named,
    /// or to the next one around the display. That is where it starts from
    /// now on. Never called on the main thread.
    pub fn place(&self, app: &AppHandle, wanted: Option<Corner>) -> Applied {
        let mut state = lock(&self.state);
        let next = wanted.unwrap_or_else(|| state.corner.clockwise());
        state.home = next;
        state.corner = next;
        state.needed.clear();
        if state.mode == Mode::Panel {
            if let Some(window) = app.get_webview_window(MAIN) {
                set_main(&window, &mut state, Mode::Panel);
            }
        }
        applied(&state)
    }

    /// Rust is about to look at the screen or to act on it. Whatever the
    /// interface last said, the glow is up before that happens.
    pub fn touch(&self, app: &AppHandle) {
        let mut state = lock(&self.state);
        state.lease.renew(Instant::now());
        set_glow(app, &mut state, true);
        if !state.watching {
            state.watching = true;
            self.watch(app.clone());
        }
    }

    /// Put everything back, now.
    pub fn release(&self, app: &AppHandle) {
        let mut state = lock(&self.state);
        state.lease.end();
        state.input_origin = None;
        state.focus = false;
        if let Some(window) = app.get_webview_window(MAIN) {
            set_main(&window, &mut state, Mode::Window);
        }
        set_glow(app, &mut state, false);
    }

    /// One thread per stretch of work. It ends as soon as nothing is up.
    fn watch(&self, app: AppHandle) {
        let surface = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let ran_out = {
                let mut state = lock(&surface.state);
                let now = Instant::now();
                if state.lease.ran_out(now) {
                    true
                } else if !state.lease.held(now) {
                    state.watching = false;
                    return;
                } else {
                    false
                }
            };
            if ran_out {
                surface.release(&app);
                lock(&surface.state).watching = false;
                return;
            }
        });
    }
}

fn applied(state: &State) -> Applied {
    Applied { mode: state.mode, glow: state.glow, glass: glass(), corner: state.corner }
}

fn set_main(window: &WebviewWindow, state: &mut State, wanted: Mode) {
    let take_focus = state.focus;
    if wanted == Mode::Window {
        state.placed = None;
        state.rest();
        let Some(saved) = state.saved.take() else {
            state.mode = Mode::Window;
            return;
        };
        let _ = window.set_always_on_top(false);
        let _ = window.set_content_protected(false);
        let _ = window.set_skip_taskbar(false);
        let _ = window.set_focusable(true);
        let _ = window.set_decorations(saved.decorated);
        let _ = window.set_resizable(saved.resizable);
        let _ = window.set_size(saved.size);
        let _ = window.set_position(saved.position);
        if saved.maximized {
            let _ = window.maximize();
        }
        if saved.fullscreen {
            let _ = window.set_fullscreen(true);
        }
        state.mode = Mode::Window;
        return;
    }

    if state.saved.is_none() {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let maximized = window.is_maximized().unwrap_or(false);
        if fullscreen {
            let _ = window.set_fullscreen(false);
        }
        if maximized {
            let _ = window.unmaximize();
        }
        if fullscreen || maximized {
            // The window system needs a moment before it reports the
            // size and place the window has when it is not maximized.
            std::thread::sleep(Duration::from_millis(120));
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            // Without knowing where to go back to, the window stays as it is.
            if maximized {
                let _ = window.maximize();
            }
            if fullscreen {
                let _ = window.set_fullscreen(true);
            }
            state.mode = Mode::Window;
            return;
        };
        state.saved = Some(Saved {
            position,
            size,
            maximized,
            fullscreen,
            decorated: window.is_decorated().unwrap_or(true),
            resizable: window.is_resizable().unwrap_or(true),
        });
        let _ = window.set_decorations(false);
        let _ = window.set_resizable(false);
        let _ = window.set_always_on_top(true);
        let _ = window.set_skip_taskbar(true);
        let _ = window.set_content_protected(true);
    }

    let Some(display) = pick_display(window, state.input_origin, state.saved.as_ref()) else {
        return;
    };
    let Some(rect) = mode_rect(wanted, &display, state.corner) else { return };
    // The panel and the paused view take clicks, so the window stays LU's
    // own window in every check of the engine: off limits for the model.
    let _ = window.set_focusable(take_focus);
    // The window the user typed the task into has the foreground. As the
    // panel it must not keep it: the keys of the task are for the app LU
    // works in, and a panel that is the active window swallows them.
    #[cfg(target_os = "windows")]
    if !take_focus {
        if let Ok(handle) = window.hwnd() {
            super::desk::platform::give_up_foreground(handle.0 as usize);
        }
    }
    // A window that is resized to the size it has can still repaint, and a
    // see-through one may flash while it does.
    if state.placed != Some(rect) {
        // From corner to corner the panel slides, so the eye can follow it.
        // Anything else (it comes up, the display or the scaling changed, the
        // user wants less motion) is one step.
        let slides = state.placed.filter(|from| !state.still && state.mode == Mode::Panel && wanted == Mode::Panel && (from.width, from.height) == (rect.width, rect.height));
        match slides {
            Some(from) => {
                for (x, y) in glide_path((from.x, from.y), (rect.x, rect.y), GLIDE_STEPS) {
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                    std::thread::sleep(GLIDE_TICK);
                }
            }
            None => {
                let _ = window.set_size(PhysicalSize::new(rect.width as u32, rect.height as u32));
                let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
            }
        }
        state.placed = Some(rect);
        // The moves above are only handed to the window system. Asking it
        // where the window is waits until they are done, so whoever looks at
        // the screen next finds the window where this says it is.
        let _ = window.outer_position();
    }
    if take_focus {
        let _ = window.set_focus();
    }
    state.mode = wanted;
}

#[cfg(target_os = "windows")]
fn set_glow(app: &AppHandle, state: &mut State, on: bool) {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let existing = app.get_webview_window(GLOW);
    if !on {
        if let Some(window) = existing {
            let _ = window.destroy();
        }
        state.glow = false;
        return;
    }
    let anchor = app.get_webview_window(MAIN);
    let display = anchor.as_ref().and_then(|main| pick_display(main, state.input_origin, state.saved.as_ref()));
    let Some(display) = display else { return };
    let rect = cover_rect(&display);
    let window = match existing {
        Some(window) => window,
        None => {
            let built = WebviewWindowBuilder::new(app, GLOW, WebviewUrl::App(GLOW_PAGE.into()))
                .title(PASSTHROUGH_TITLE)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .focusable(false)
                .focused(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .content_protected(true)
                .visible(false)
                .build();
            let Ok(window) = built else {
                state.glow = false;
                return;
            };
            window
        }
    };
    // Before it is shown: a glow that caught one click would be a wall
    // across the whole display.
    if window.set_ignore_cursor_events(true).is_err() {
        let _ = window.destroy();
        state.glow = false;
        return;
    }
    let _ = window.set_size(PhysicalSize::new(rect.width as u32, rect.height as u32));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
    let _ = window.show();
    state.glow = true;
}

#[cfg(not(target_os = "windows"))]
fn set_glow(_app: &AppHandle, state: &mut State, _on: bool) {
    state.glow = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(position: (i32, i32), size: (u32, u32), scale: f64, bar: i32) -> Display {
        Display { position, size, work: Rect::new(position.0, position.1, size.0 as i32, size.1 as i32 - bar), scale }
    }

    #[test]
    fn the_panel_sits_in_the_top_right_corner_of_the_work_area() {
        let d = display((0, 0), (1920, 1080), 1.0, 40);
        assert_eq!(corner_rect(&d, PANEL_SIZE, Corner::TopRight), Rect::new(1920 - 12 - 380, 12, 380, 480));
        assert_eq!(mode_rect(Mode::Panel, &d, Corner::TopRight), Some(corner_rect(&d, PANEL_SIZE, Corner::TopRight)));
        assert_eq!(Corner::default(), Corner::TopRight);
    }

    #[test]
    fn the_panel_follows_the_display_of_the_task_and_its_scaling() {
        // A second display to the left, at 150 percent.
        let d = display((-2560, 0), (2560, 1440), 1.5, 60);
        let panel = corner_rect(&d, PANEL_SIZE, Corner::TopRight);
        assert_eq!((panel.width, panel.height), (570, 720));
        assert_eq!(panel.x + panel.width, -18);
        assert_eq!(panel.y, 18);
        // 125 percent, as on many laptops.
        let d = display((0, 0), (1920, 1080), 1.25, 60);
        assert_eq!(corner_rect(&d, PANEL_SIZE, Corner::TopRight), Rect::new(1920 - 15 - 475, 15, 475, 600));
    }

    #[test]
    fn nothing_reaches_outside_a_small_work_area() {
        let d = display((0, 0), (320, 240), 1.0, 0);
        for corner in Corner::ALL {
            let panel = corner_rect(&d, PANEL_SIZE, corner);
            assert!(panel.x >= 0 && panel.y >= 0);
            assert!(panel.x + panel.width <= 320 && panel.y + panel.height <= 240);
        }
    }

    #[test]
    fn the_cover_is_the_display_but_not_a_full_screen_window() {
        let d = display((1920, 0), (1920, 1080), 1.0, 40);
        assert_eq!(cover_rect(&d), Rect::new(1920, 0, 1920, 1079));
        assert_eq!(mode_rect(Mode::Pause, &d, Corner::BottomLeft), Some(cover_rect(&d)));
        assert_eq!(mode_rect(Mode::Window, &d, Corner::TopRight), None);
    }

    #[test]
    fn the_display_of_the_task_is_found_in_pixels_and_in_points() {
        let windows = display((1920, 0), (1920, 1080), 1.0, 0);
        assert!(same_display(&windows, (1920, 0)));
        assert!(!same_display(&windows, (0, 0)));
        // macOS: Tauri says 3024 pixels to the right, the adapter says 1512 points.
        let mac = display((3024, 0), (2560, 1440), 2.0, 0);
        assert!(same_display(&mac, (1512, 0)));
    }

    #[test]
    fn nothing_stays_up_once_the_interface_goes_silent() {
        let start = Instant::now();
        let mut lease = Lease::default();
        // Never held: nothing is up, nothing ran out.
        assert!(!lease.held(start) && !lease.ran_out(start));
        lease.renew(start);
        assert!(lease.held(start + LEASE - Duration::from_millis(1)));
        assert!(!lease.ran_out(start + LEASE - Duration::from_millis(1)));
        assert!(lease.ran_out(start + LEASE));
        assert!(!lease.held(start + LEASE));
        // The interface said "done": gone at once, and that is not running out.
        lease.renew(start);
        lease.end();
        assert!(!lease.held(start) && !lease.ran_out(start + LEASE));
    }

    #[test]
    fn the_glow_needs_a_see_through_window_and_only_windows_has_one() {
        assert_eq!(glows(), cfg!(target_os = "windows"));
        assert_eq!(shrinks(), cfg!(any(target_os = "windows", target_os = "macos")));
        assert_eq!(glass(), cfg!(target_os = "windows"));
    }

    // ── The four corners ─────────────────────────────────────────────────

    /// Full HD with the taskbar at the bottom, and where the panel is in each corner.
    fn places(d: &Display) -> [(Corner, Rect); 4] {
        Corner::ALL.map(|corner| (corner, corner_rect(d, PANEL_SIZE, corner)))
    }

    #[test]
    fn each_corner_keeps_the_margin_to_the_work_area() {
        let d = display((0, 0), (1920, 1080), 1.0, 40);
        assert_eq!(corner_rect(&d, PANEL_SIZE, Corner::TopLeft), Rect::new(12, 12, 380, 480));
        assert_eq!(corner_rect(&d, PANEL_SIZE, Corner::BottomRight), Rect::new(1920 - 12 - 380, 1040 - 12 - 480, 380, 480));
        assert_eq!(corner_rect(&d, PANEL_SIZE, Corner::BottomLeft), Rect::new(12, 1040 - 12 - 480, 380, 480));
    }

    #[test]
    fn a_taskbar_at_the_top_or_at_the_side_stays_free_in_every_corner() {
        // Taskbar on top, 48 high, and one on the left, 64 wide, at 125 percent.
        let top = Display { position: (0, 0), size: (1920, 1080), work: Rect::new(0, 48, 1920, 1032), scale: 1.0 };
        let left = Display { position: (-1920, 0), size: (1920, 1080), work: Rect::new(-1856, 0, 1856, 1080), scale: 1.25 };
        for d in [top, left] {
            for corner in Corner::ALL {
                let panel = corner_rect(&d, PANEL_SIZE, corner);
                let margin = px(MARGIN, d.scale);
                assert!(panel.x >= d.work.x + margin && panel.right() <= d.work.right() - margin, "{corner:?} {panel:?}");
                assert!(panel.y >= d.work.y + margin && panel.bottom() <= d.work.bottom() - margin, "{corner:?} {panel:?}");
            }
        }
        assert_eq!(corner_rect(&top, PANEL_SIZE, Corner::TopRight).y, 60);
        assert_eq!(corner_rect(&left, PANEL_SIZE, Corner::TopLeft).x, -1856 + 15);
    }

    #[test]
    fn the_grip_walks_once_around_the_display() {
        let mut corner = Corner::TopRight;
        let mut seen = Vec::new();
        for _ in 0..4 {
            corner = corner.clockwise();
            seen.push(corner);
        }
        assert_eq!(seen, [Corner::BottomRight, Corner::BottomLeft, Corner::TopLeft, Corner::TopRight]);
    }

    #[test]
    fn the_panel_steps_down_on_its_own_side_first() {
        let d = display((0, 0), (1920, 1080), 1.0, 40);
        // The close button of a maximized app, under the panel in the top right corner.
        assert_eq!(evade(Corner::TopRight, &places(&d), &[(1900, 20)], &[], 16), Some(Corner::BottomRight));
        assert_eq!(evade(Corner::TopLeft, &places(&d), &[(40, 30)], &[], 16), Some(Corner::BottomLeft));
        assert_eq!(evade(Corner::BottomRight, &places(&d), &[(1800, 900)], &[], 16), Some(Corner::TopRight));
        assert_eq!(Corner::TopRight.ways_out(), [Corner::BottomRight, Corner::TopLeft, Corner::BottomLeft]);
    }

    #[test]
    fn a_drag_keeps_both_of_its_ends_free() {
        let d = display((0, 0), (1920, 1080), 1.0, 40);
        // From the top right down into the bottom right corner: across it is.
        assert_eq!(evade(Corner::TopRight, &places(&d), &[(1800, 100), (1800, 900)], &[], 16), Some(Corner::TopLeft));
        // And with the top left taken too, the far corner.
        assert_eq!(evade(Corner::TopRight, &places(&d), &[(1800, 100), (1800, 900), (100, 100)], &[], 16), Some(Corner::BottomLeft));
    }

    #[test]
    fn a_point_right_next_to_a_corner_does_not_count_as_free() {
        let d = display((0, 0), (1920, 1080), 1.0, 40);
        let bottom_right = corner_rect(&d, PANEL_SIZE, Corner::BottomRight);
        // Ten pixels above the panel in the bottom right corner.
        let aims = [(1900, 20), (bottom_right.x + 50, bottom_right.y - 10)];
        assert_eq!(evade(Corner::TopRight, &places(&d), &aims, &[], 16), Some(Corner::TopLeft));
        assert_eq!(evade(Corner::TopRight, &places(&d), &aims, &[], 0), Some(Corner::BottomRight));
    }

    #[test]
    fn two_targets_in_two_corners_do_not_send_the_panel_back_and_forth() {
        let d = display((0, 0), (1920, 1080), 1.0, 40);
        let close = (1900, 20);
        let status = (1800, 1000);
        // The close button first: down. Then the status bar there: not back
        // up to where the model just worked, but across.
        assert_eq!(evade(Corner::TopRight, &places(&d), &[close], &[], 16), Some(Corner::BottomRight));
        assert_eq!(evade(Corner::BottomRight, &places(&d), &[status], &[Corner::TopRight], 16), Some(Corner::BottomLeft));
        // With every other corner needed once, the one needed longest ago.
        let needed = [Corner::TopLeft, Corner::BottomLeft, Corner::TopRight];
        assert_eq!(evade(Corner::BottomRight, &places(&d), &[status], &needed, 16), Some(Corner::TopLeft));
    }

    #[test]
    fn a_display_too_small_to_step_aside_on_has_no_free_corner() {
        let d = display((0, 0), (640, 480), 1.0, 0);
        // The panel fills the height: every corner on the right holds the point.
        assert_eq!(evade(Corner::TopRight, &places(&d), &[(600, 240), (40, 240)], &[], 16), None);
        // With only the right side aimed at, the left one is free.
        assert_eq!(evade(Corner::TopRight, &places(&d), &[(600, 240)], &[], 16), Some(Corner::TopLeft));
    }

    #[test]
    fn the_second_display_and_its_scaling_are_counted_in_its_own_pixels() {
        // To the left of the main display, at 150 percent.
        let d = display((-2560, 0), (2560, 1440), 1.5, 60);
        let top_right = corner_rect(&d, PANEL_SIZE, Corner::TopRight);
        assert!(top_right.contains(-30, 30));
        assert_eq!(evade(Corner::TopRight, &places(&d), &[(-30, 30)], &[], px(CLEARANCE, d.scale)), Some(Corner::BottomRight));
        let bottom_right = corner_rect(&d, PANEL_SIZE, Corner::BottomRight);
        assert_eq!((bottom_right.right(), bottom_right.bottom()), (-18, 1380 - 18));
    }

    #[test]
    fn a_place_is_named_in_points_where_the_adapters_count_in_points() {
        // macOS at 2x: Tauri says pixels, the adapter says points.
        let d = display((0, 0), (3024, 1964), 2.0, 0);
        let pixels = corner_rect(&d, PANEL_SIZE, Corner::TopRight);
        assert_eq!(to_input(pixels, d.scale, true), Rect::new(1512 - 12 - 380, 12, 380, 480));
        assert_eq!(to_input(pixels, d.scale, false), pixels);
        assert_eq!(input_in_points(), cfg!(target_os = "macos"));
    }

    #[test]
    fn the_slide_ends_exactly_in_the_corner_and_never_overshoots() {
        let path = glide_path((1528, 12), (1528, 548), 14);
        assert_eq!(path.len(), 14);
        assert_eq!(path.last(), Some(&(1528, 548)));
        assert!(path.windows(2).all(|pair| pair[0].1 <= pair[1].1 && pair[0].0 == 1528));
        // It starts fast and comes to rest.
        assert!(path[0].1 - 12 > 548 - path[12].1);
        // To the left, across a display with negative coordinates.
        let path = glide_path((-398, 18), (-2542, 18), 14);
        assert_eq!(path.last(), Some(&(-2542, 18)));
        assert!(path.windows(2).all(|pair| pair[0].0 >= pair[1].0));
        assert_eq!(glide_path((0, 0), (10, 10), 0), vec![(10, 10)]);
    }

    #[test]
    fn a_corner_travels_as_a_plain_word() {
        assert_eq!(serde_json::to_string(&Corner::BottomLeft).unwrap(), "\"bottom_left\"");
        assert_eq!(serde_json::from_str::<Corner>("\"top_right\"").unwrap(), Corner::TopRight);
    }

    #[test]
    fn a_mode_travels_as_a_plain_word() {
        assert_eq!(serde_json::to_string(&Mode::Panel).unwrap(), "\"panel\"");
        assert_eq!(serde_json::from_str::<Mode>("\"pause\"").unwrap(), Mode::Pause);
    }
}
