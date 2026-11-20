//! The rules of computer use, enforced before every action.
//!
//! The interface asks the user; this file decides. Whatever the interface
//! sends, an action only fires when all of this holds at the moment of
//! firing:
//!
//!   * a session exists and nobody stopped it;
//!   * the window in front is not on the blocklist and its app was approved
//!     for this session, and so is the window the pointer would land in;
//!   * a coordinate refers to the frame the model last saw, and neither the
//!     display layout nor the window in front changed since;
//!   * a supervised session carries the user's confirmation, and an
//!     autonomous one carries it for anything that sends, buys, deletes or
//!     changes permissions. Whether an action is one of those is judged in
//!     both kinds of session, so the question always carries the reason: the
//!     interface shows it in red and a voice session takes no spoken yes
//!     for it;
//!   * no password field holds the focus when text is typed;
//!   * the session is not paused. A pause begins when the user moves the
//!     mouse or presses a key while LU works on its own, or presses the pause
//!     shortcut. Only the user's answer ends it: nothing a model sends can.
//!
//! The window in front is read again right before the first event and between
//! the parts of a longer action, because a dialog can appear while the checks
//! run.
//!
//! LU's own window is never the place of an action. When it is in front (it
//! kept the focus it had before the task, or the user answered a question or
//! a pause in it), the window LU was working in is brought back first. Where
//! that does not work the action is refused and says so: nothing is typed or
//! clicked blind.
//!
//! The same holds for a spot under one of LU's own windows, the panel above
//! all. It is black in the screenshot, so the model cannot have seen what is
//! there. A pointer action that aims at it is refused, and the refusal says
//! where it aimed: whoever shows the panel moves it out of the way, and the
//! model looks again before anything is clicked.

use super::adapter::{Desktop, InputOp, MouseButton};
use super::blocklist::{self, BlockReason, Platform};
use super::capture::{self, ImageFormat};
use super::geometry;
use super::injection;
use super::keys::{self, Chord, KeyName, Modifier};
use super::sensitive;
use super::takeover;
use super::tree::{self, TreeLimits};
use super::types::{code, AppIdentity, MonitorInfo, Outcome, OwnWindow, Rect, Refusal, UiNode, WindowInfo};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_MAX_FRAME_AGE: Duration = Duration::from_secs(180);
const MIN_MAX_FRAME_AGE: Duration = Duration::from_secs(5);
const MAX_MAX_FRAME_AGE: Duration = Duration::from_secs(600);
/// A pointer this far from where LU left it means the user took the mouse.
pub const TAKEOVER_DISTANCE: f64 = 40.0;
pub const MAX_WAIT_MS: u64 = 10_000;
pub const MAX_TEXT_CHARS: usize = 4000;
/// Why typing asks first when the focus query failed.
const FOCUS_UNKNOWN: &str = "LU could not check which field has the focus, so it cannot rule out a password field.";
const TYPE_CHUNK_CHARS: usize = 24;
/// How long the focus gets to arrive after a tab or a line break in typed text.
const FOCUS_MOVE_SETTLE_MS: u64 = 60;
const DRAG_STEPS: i32 = 12;
const MAX_SCROLL_NOTCHES: i32 = 30;
const MAX_KEY_REPEAT: u32 = 20;
const WAIT_SLICE: Duration = Duration::from_millis(50);
const RAW_TREE_BUDGET: usize = 4000;
/// The title of LU's own window that only shows something and lets every
/// click through: the glow at the edge of the screen. A click at its place
/// lands in the window below, so it is left out of the window list, of the
/// hit test and of the blacked out areas.
pub const PASSTHROUGH_TITLE: &str = "LU status";
/// How long a window gets to arrive in front after LU asked for it.
const FOCUS_SETTLE: Duration = Duration::from_millis(250);
const PAUSED_SENTENCE: &str =
    "The user moved the mouse or pressed a key, so computer control is paused. Nothing runs until the user decides whether to take over or to let LU continue.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The Stop button.
    User,
    /// The global stop shortcut.
    Hotkey,
    /// The user moved the pointer or pressed a key while LU was working,
    /// was asked, and chose to take over.
    Takeover,
}

impl StopReason {
    pub fn sentence(self) -> &'static str {
        match self {
            StopReason::User => "The user stopped computer control.",
            StopReason::Hotkey => "The user stopped computer control with the stop shortcut.",
            StopReason::Takeover => "The user took over the mouse or keyboard, so computer control stopped.",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
    /// The next action in this app, then asked again.
    Once,
    /// Until the session ends.
    Session,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BeginOptions {
    /// The chat this session works for. The user has to have allowed
    /// computer control in exactly this chat, see `Engine::chat_answer`.
    pub chat_id: Option<String>,
    pub autonomous: bool,
    pub max_frame_age_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenOptions {
    pub monitor_id: Option<u32>,
    pub max_edge: Option<u32>,
    pub format: ImageFormat,
    pub quality: Option<u8>,
    /// Register a frame without encoding an image (for a model without
    /// vision that works from the tree).
    pub no_image: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Click { x: i32, y: i32 },
    DoubleClick { x: i32, y: i32 },
    RightClick { x: i32, y: i32 },
    Move { x: i32, y: i32 },
    Drag { x: i32, y: i32, to_x: i32, to_y: i32 },
    Scroll { x: Option<i32>, y: Option<i32>, #[serde(default)] dx: i32, #[serde(default)] dy: i32 },
    Type { text: String },
    Key { keys: String, repeat: Option<u32> },
    Wait { ms: u64 },
    FocusWindow { window_id: u64 },
    /// Put a window somewhere else, and give it another size when one is
    /// named: x and y are where its top left goes, on the 0..1000
    /// grid of the display the window is on. Done by the system, not by
    /// dragging the title bar, which a model rarely hits.
    ///
    /// With dx or dy the window moves by that many pixels from where it is,
    /// and x and y are not read. "300 pixels to the right" is what a user
    /// says, and a model that has to turn it into a place on the grid first
    /// needs the place and the size of the display for it (box, 09.10.2026:
    /// the 9B model never got there).
    MoveWindow {
        window_id: u64,
        #[serde(default)]
        x: i32,
        #[serde(default)]
        y: i32,
        #[serde(default)]
        dx: Option<i32>,
        #[serde(default)]
        dy: Option<i32>,
        width: Option<i32>,
        height: Option<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub action: Action,
    /// The frame the coordinates refer to. Checked against the latest frame.
    #[serde(default)]
    pub frame_id: Option<u64>,
    /// The user confirmed exactly this action in the interface.
    #[serde(default)]
    pub confirmed: bool,
    /// The window that was in front before LU's own dialog took the focus.
    /// Honoured only while LU itself is in front and only for an approved app.
    #[serde(default)]
    pub refocus_window: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    /// One English sentence about what was done.
    pub performed: String,
    pub app: Option<AppIdentity>,
    pub window_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub key: String,
    pub scope: GrantScope,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    /// The chat the user allowed computer control in, and this session works for.
    pub chat_id: String,
    pub autonomous: bool,
    pub allowed: Vec<GrantView>,
    pub stopped: Option<StopReason>,
    /// The user has the mouse or the keyboard and has not answered yet.
    pub paused: bool,
    pub frame_id: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allowed,
    NeedsApproval,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowView {
    #[serde(flatten)]
    pub window: WindowInfo,
    pub verdict: Verdict,
    pub block_reason: Option<BlockReason>,
    pub foreground: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardReport {
    pub foreground: Option<WindowView>,
    pub verdict: Verdict,
    pub block_reason: Option<BlockReason>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsReport {
    pub foreground: Option<WindowView>,
    pub windows: Vec<WindowView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenReport {
    pub frame_id: u64,
    pub monitor: MonitorInfo,
    /// Size of the image for the model.
    pub width: u32,
    pub height: u32,
    /// Image pixels per captured pixel.
    pub scale: f64,
    /// Pointer on the 0..1000 grid, when it is on this monitor.
    pub cursor: Option<[i32; 2]>,
    pub foreground: Option<WindowView>,
    /// How many areas of blocked windows were blacked out.
    pub hidden_areas: usize,
    /// The blacked out areas that are LU's own windows, as
    /// `[left, top, right, bottom]` on the 0..1000 grid. A pointer action
    /// that aims into one is refused with the place it aimed at.
    pub covered: Vec<[i32; 4]>,
    /// What the picture looks like, to tell whether a step changed anything
    /// (see `capture::fingerprint`). None when no image was asked for.
    pub look: Option<String>,
    pub mime: Option<&'static str>,
    #[serde(skip)]
    pub image: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeReport {
    pub window: WindowView,
    pub nodes: Vec<UiNode>,
    pub dropped: usize,
    pub password_focused: bool,
    /// Phrases in the tree that look like instructions to a model.
    pub warnings: Vec<&'static str>,
}

#[derive(Debug, Clone)]
struct Frame {
    id: u64,
    monitor: MonitorInfo,
    captured: Instant,
    foreground: Option<u64>,
    /// Where LU's own windows were, and so what the model saw as black.
    own: Vec<Rect>,
}

struct Session {
    id: String,
    chat_id: String,
    autonomous: bool,
    grants: HashMap<String, GrantScope>,
    frame: Option<Frame>,
    /// Where LU left the pointer.
    last_cursor: Option<(i32, i32)>,
    /// How many keys the user had pressed when LU last acted.
    last_keys: Option<u64>,
    /// The window LU works in: the last one of another app that was in front
    /// when LU looked at the screen or acted. Where the focus goes back to
    /// when LU's own window is in front.
    work_window: Option<u64>,
    max_frame_age: Duration,
}

/// What the user answered to "may computer control work in this chat".
/// It lives in memory only: a restart of the app asks again.
#[derive(Default)]
struct ChatPermissions {
    /// Chats whose question is open. Only an open question can be answered.
    asked: HashSet<String>,
    allowed: HashSet<String>,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    next_frame: u64,
}

type Clock = Box<dyn Fn() -> Instant + Send + Sync>;
type StopObserver = Box<dyn Fn(StopReason) + Send + Sync>;
type PauseObserver = Box<dyn Fn() + Send + Sync>;

pub struct Engine {
    desktop: Arc<dyn Desktop>,
    inner: Mutex<Inner>,
    stop_flag: AtomicBool,
    stop_reason: Mutex<Option<StopReason>>,
    on_stop: Mutex<Option<StopObserver>>,
    /// The chord that stops the session. A `key` action with it is refused.
    stop_chord: Mutex<Option<Chord>>,
    /// The chord that pauses the session. It belongs to the user as well.
    pause_chord: Mutex<Option<Chord>>,
    /// The user has the mouse or the keyboard and has not answered yet.
    paused: AtomicBool,
    on_pause: Mutex<Option<PauseObserver>>,
    /// The window that was in front when the pause began. The focus goes
    /// back there when the user lets LU continue.
    paused_over: Mutex<Option<u64>>,
    has_session: AtomicBool,
    /// Per chat: has the user allowed computer control there. No setting, no
    /// standing approval and no autonomous session stands in for it.
    chats: Mutex<ChatPermissions>,
    clock: Clock,
}

impl Engine {
    pub fn new(desktop: Arc<dyn Desktop>) -> Self {
        Self::with_clock(desktop, Box::new(Instant::now))
    }

    pub fn with_clock(desktop: Arc<dyn Desktop>, clock: Clock) -> Self {
        Self {
            desktop,
            inner: Mutex::new(Inner::default()),
            stop_flag: AtomicBool::new(false),
            stop_reason: Mutex::new(None),
            on_stop: Mutex::new(None),
            stop_chord: Mutex::new(None),
            pause_chord: Mutex::new(None),
            paused: AtomicBool::new(false),
            on_pause: Mutex::new(None),
            paused_over: Mutex::new(None),
            has_session: AtomicBool::new(false),
            chats: Mutex::new(ChatPermissions::default()),
            clock,
        }
    }

    pub fn desktop(&self) -> &Arc<dyn Desktop> {
        &self.desktop
    }

    pub fn platform(&self) -> Platform {
        self.desktop.platform()
    }

    pub fn set_stop_observer(&self, observer: StopObserver) {
        *lock(&self.on_stop) = Some(observer);
    }

    pub fn set_stop_chord(&self, chord: Option<Chord>) {
        *lock(&self.stop_chord) = chord;
    }

    pub fn set_pause_observer(&self, observer: PauseObserver) {
        *lock(&self.on_pause) = Some(observer);
    }

    pub fn set_pause_chord(&self, chord: Option<Chord>) {
        *lock(&self.pause_chord) = chord;
    }

    // ── Session ──────────────────────────────────────────────────────────

    /// Open the question "may computer control work in this chat". True when
    /// the user has already said yes there, and then nothing is open.
    pub fn chat_ask(&self, chat_id: &str) -> Outcome<bool> {
        let chat_id = valid_chat(chat_id)?;
        let mut chats = lock(&self.chats);
        if chats.allowed.contains(chat_id) {
            return Ok(true);
        }
        chats.asked.insert(chat_id.to_string());
        Ok(false)
    }

    /// The user's answer to the open question of one chat. A yes holds for
    /// that chat until the app ends. A no leaves nothing behind: the next
    /// request asks again. Without an open question there is nothing to
    /// answer, so a yes cannot be put here ahead of time.
    pub fn chat_answer(&self, chat_id: &str, allow: bool) -> Outcome<bool> {
        let chat_id = valid_chat(chat_id)?;
        let mut chats = lock(&self.chats);
        if !chats.asked.remove(chat_id) {
            return Err(Refusal::new(code::INVALID, "There is no open question about computer control in this chat."));
        }
        if allow {
            chats.allowed.insert(chat_id.to_string());
        }
        Ok(allow)
    }

    pub fn chat_allowed(&self, chat_id: &str) -> bool {
        lock(&self.chats).allowed.contains(chat_id.trim())
    }

    pub fn begin(&self, id: String, options: BeginOptions) -> Outcome<SessionView> {
        // First of all: the user has allowed computer control in this chat.
        // Nothing the interface sends gets a session without that.
        let chat_id = options.chat_id.as_deref().map(str::trim).filter(|c| self.chat_allowed(c)).ok_or_else(chat_refusal)?.to_string();
        // A new session is not a way around the question the user has not answered.
        self.refuse_if_paused()?;
        self.desktop.input_ready()?;
        if options.autonomous {
            self.autonomy_available()?;
        }
        let max_frame_age = options
            .max_frame_age_ms
            .map(Duration::from_millis)
            .unwrap_or(DEFAULT_MAX_FRAME_AGE)
            .clamp(MIN_MAX_FRAME_AGE, MAX_MAX_FRAME_AGE);
        let mut inner = lock(&self.inner);
        self.stop_flag.store(false, Ordering::SeqCst);
        *lock(&self.stop_reason) = None;
        inner.session = Some(Session {
            id,
            chat_id,
            autonomous: options.autonomous,
            grants: HashMap::new(),
            frame: None,
            last_cursor: None,
            last_keys: None,
            work_window: None,
            max_frame_age,
        });
        self.has_session.store(true, Ordering::SeqCst);
        Ok(self.view(inner.session.as_ref().expect("just set")))
    }

    pub fn session(&self) -> Option<SessionView> {
        lock(&self.inner).session.as_ref().map(|s| self.view(s))
    }

    fn autonomy_available(&self) -> Outcome<()> {
        if self.desktop.tree_available() {
            return Ok(());
        }
        Err(Refusal::new(
            code::UNAVAILABLE,
            "Autonomous computer control is available on Windows only for now. On this system LU cannot yet read what a click would press, so every action is confirmed.",
        ))
    }

    /// Switch the running session between supervised and autonomous. The
    /// session stays the same one: its approvals, its latest look, a stop and
    /// a pause all hold, and so does everything LU shows of itself. The
    /// user's hand is forgotten, because the switch was just clicked with it.
    pub fn set_autonomous(&self, session_id: &str, autonomous: bool) -> Outcome<SessionView> {
        if autonomous {
            self.autonomy_available()?;
        }
        let mut inner = lock(&self.inner);
        let session = require_session(&mut inner, session_id)?;
        session.autonomous = autonomous;
        session.last_cursor = None;
        session.last_keys = None;
        Ok(self.view(session))
    }

    /// Approve one app for the session. A blocked app cannot be approved.
    /// The user's hand is forgotten, because the answer was just clicked with it.
    pub fn allow_app(&self, session_id: &str, key: &str, scope: GrantScope) -> Outcome<SessionView> {
        let key = key.trim().to_lowercase();
        if key.is_empty() {
            return Err(Refusal::new(code::INVALID, "The app to allow has no name."));
        }
        if let Some(reason) = blocklist::blocked_key(self.platform(), &key) {
            return Err(Refusal::new(code::BLOCKED, reason.sentence()));
        }
        let mut inner = lock(&self.inner);
        let session = require_session(&mut inner, session_id)?;
        // A session grant is never downgraded by a later "once".
        if !(scope == GrantScope::Once && session.grants.get(&key) == Some(&GrantScope::Session)) {
            session.grants.insert(key, scope);
        }
        // The user just used the mouse to answer in LU's own window. That is
        // not a takeover: an autonomous session would pause right after "Allow".
        session.last_cursor = None;
        session.last_keys = None;
        Ok(self.view(session))
    }

    pub fn revoke_app(&self, session_id: &str, key: &str) -> Outcome<SessionView> {
        let mut inner = lock(&self.inner);
        let session = require_session(&mut inner, session_id)?;
        session.grants.remove(&key.trim().to_lowercase());
        Ok(self.view(session))
    }

    /// End the session. Returns whether there was one with this id.
    pub fn end(&self, session_id: &str) -> bool {
        let mut inner = lock(&self.inner);
        if inner.session.as_ref().is_some_and(|s| s.id == session_id) {
            inner.session = None;
            self.has_session.store(false, Ordering::SeqCst);
            self.stop_flag.store(false, Ordering::SeqCst);
            *lock(&self.stop_reason) = None;
            return true;
        }
        false
    }

    /// The emergency stop. Takes no lock an action holds, so it lands while
    /// one runs. Everything the session does from here on is refused.
    pub fn stop(&self, reason: StopReason) {
        let mut slot = lock(&self.stop_reason);
        let first = slot.is_none();
        if first {
            *slot = Some(reason);
        }
        drop(slot);
        self.stop_flag.store(true, Ordering::SeqCst);
        // A stop answers the pause too: there is nothing left to continue.
        self.paused.store(false, Ordering::SeqCst);
        *lock(&self.paused_over) = None;
        if first {
            if let Some(observer) = lock(&self.on_stop).as_ref() {
                observer(reason);
            }
        }
    }

    pub fn stopped(&self) -> Option<StopReason> {
        if self.stop_flag.load(Ordering::SeqCst) {
            Some((*lock(&self.stop_reason)).unwrap_or(StopReason::User))
        } else {
            None
        }
    }

    // ── Pause ────────────────────────────────────────────────────────────

    /// Hold everything until the user answers. Takes no lock an action
    /// holds, so the shortcut lands while one runs. Returns whether the
    /// session is paused now; without a session, or after a stop, it is not.
    pub fn pause(&self) -> bool {
        if !self.has_session.load(Ordering::SeqCst) || self.stop_flag.load(Ordering::SeqCst) {
            return false;
        }
        if !self.paused.swap(true, Ordering::SeqCst) {
            let front = self.desktop.foreground().ok().flatten().filter(|w| !w.is_self).map(|w| w.id);
            *lock(&self.paused_over) = front;
            if let Some(observer) = lock(&self.on_pause).as_ref() {
                observer();
            }
        }
        true
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// The user lets LU continue. This is the only way out of a pause other
    /// than a stop, and it is called for the user's click alone. The frame is
    /// dropped, so coordinates from before the pause are refused and the
    /// model has to look again: the user may have changed the screen. What
    /// the user did with the mouse and the keyboard to answer is not a new
    /// takeover.
    pub fn resume(&self) {
        let mut inner = lock(&self.inner);
        if !self.paused.load(Ordering::SeqCst) {
            return;
        }
        let over = lock(&self.paused_over).take();
        if let Some(session) = inner.session.as_mut() {
            session.frame = None;
            session.last_cursor = None;
            session.last_keys = None;
            // The question was answered in LU's window. Hand the focus back:
            // to the window that was in front when the pause began, else to
            // the one LU was working in. The next action checks again.
            if self.desktop.foreground().ok().flatten().is_some_and(|front| front.is_self) {
                if let Some(target) = self.work_target(session, [over, session.work_window]).ok().and_then(|found| found.allowed) {
                    if self.desktop.focus_window(&target).is_ok() {
                        self.desktop.pause(FOCUS_SETTLE);
                    }
                }
            }
        }
        self.paused.store(false, Ordering::SeqCst);
    }

    /// Look for the user's hand while no action runs, so the question comes
    /// up when the mouse moves and not only when LU would act next. Returns
    /// whether the session is paused. Never waits for a running action: that
    /// one checks by itself.
    pub fn watch(&self) -> bool {
        if self.paused() || self.stopped().is_some() {
            return self.paused();
        }
        if let Ok(inner) = self.inner.try_lock() {
            if let Some(session) = inner.session.as_ref().filter(|s| s.autonomous) {
                let _ = self.check_takeover(session);
            }
        }
        self.paused()
    }

    fn refuse_if_paused(&self) -> Outcome<()> {
        if self.paused() {
            return Err(Refusal::new(code::PAUSED, PAUSED_SENTENCE));
        }
        Ok(())
    }

    /// The user's hand was seen. Pause and say so.
    fn hand_seen(&self) -> Outcome<()> {
        self.pause();
        self.refuse_if_stopped()?;
        self.refuse_if_paused()
    }

    // ── LU's own display windows ─────────────────────────────────────────

    fn passthrough(window: &WindowInfo) -> bool {
        window.is_self && window.title == PASSTHROUGH_TITLE
    }

    /// The windows a click can land in, front to back.
    fn solid_windows(&self) -> Outcome<Vec<WindowInfo>> {
        Ok(self.desktop.windows()?.into_iter().filter(|w| !Self::passthrough(w)).collect())
    }

    /// The window a click at this point lands in. A display window of LU
    /// lets the click through, so the answer is the window below it.
    fn target_at(&self, x: i32, y: i32) -> Outcome<Option<WindowInfo>> {
        match self.desktop.window_at(x, y)? {
            Some(hit) if Self::passthrough(&hit) => Ok(self.solid_windows()?.into_iter().find(|w| !w.minimized && w.rect.contains(x, y))),
            other => Ok(other),
        }
    }

    fn view(&self, session: &Session) -> SessionView {
        let mut allowed: Vec<GrantView> = session.grants.iter().map(|(key, scope)| GrantView { key: key.clone(), scope: *scope }).collect();
        allowed.sort_by(|a, b| a.key.cmp(&b.key));
        SessionView {
            id: session.id.clone(),
            chat_id: session.chat_id.clone(),
            autonomous: session.autonomous,
            allowed,
            stopped: self.stopped(),
            paused: self.paused(),
            frame_id: session.frame.as_ref().map(|f| f.id),
        }
    }

    fn refuse_if_stopped(&self) -> Outcome<()> {
        match self.stopped() {
            Some(reason) => Err(Refusal::new(code::STOPPED, format!("{} Do not continue. Tell the user what was done so far.", reason.sentence()))),
            None => Ok(()),
        }
    }

    // ── Guard ────────────────────────────────────────────────────────────

    fn judge(&self, session: Option<&Session>, window: &WindowInfo) -> (Verdict, Option<BlockReason>) {
        if let Some(reason) = blocklist::blocked(self.platform(), window) {
            return (Verdict::Blocked, Some(reason));
        }
        let allowed = session.is_some_and(|s| s.grants.contains_key(&window.app.key.to_lowercase()));
        (if allowed { Verdict::Allowed } else { Verdict::NeedsApproval }, None)
    }

    fn window_view(&self, session: Option<&Session>, window: WindowInfo, foreground: bool) -> WindowView {
        let (verdict, block_reason) = self.judge(session, &window);
        WindowView { window, verdict, block_reason, foreground }
    }

    /// The verdict for the window in front, as an error unless it is allowed.
    fn require_allowed(&self, session: &Session, window: Option<&WindowInfo>) -> Outcome<()> {
        let Some(window) = window else {
            return Err(Refusal::new(code::BLOCKED, BlockReason::NoForeground.sentence()));
        };
        match self.judge(Some(session), window) {
            (Verdict::Allowed, _) => Ok(()),
            (Verdict::Blocked, reason) => Err(Refusal::new(code::BLOCKED, reason.unwrap_or(BlockReason::SystemDialog).sentence()).with_app(&window.app)),
            (Verdict::NeedsApproval, _) => Err(Refusal::new(
                code::NEEDS_APPROVAL,
                format!("The user has not allowed LU to control {} in this session.", display_name(&window.app)),
            )
            .with_app(&window.app)),
        }
    }

    /// The verdict for the window in front. It names that window, so it needs
    /// a session like every other look at the screen.
    pub fn guard(&self) -> Outcome<GuardReport> {
        let inner = lock(&self.inner);
        let session = Some(any_session(&inner)?);
        let foreground = self.desktop.foreground()?;
        let report = match foreground {
            None => GuardReport {
                foreground: None,
                verdict: Verdict::Blocked,
                block_reason: Some(BlockReason::NoForeground),
                message: BlockReason::NoForeground.sentence().to_string(),
            },
            Some(window) => {
                let view = self.window_view(session, window, true);
                let message = match (view.verdict, view.block_reason) {
                    (Verdict::Blocked, Some(reason)) => reason.sentence().to_string(),
                    (Verdict::Allowed, _) => format!("{} is allowed in this session.", display_name(&view.window.app)),
                    _ => format!("{} needs the user's approval before LU controls it.", display_name(&view.window.app)),
                };
                GuardReport { verdict: view.verdict, block_reason: view.block_reason, message, foreground: Some(view) }
            }
        };
        Ok(report)
    }

    /// The open windows by app and title. A look at the screen: no session, no list.
    pub fn windows(&self) -> Outcome<WindowsReport> {
        let inner = lock(&self.inner);
        let session = Some(any_session(&inner)?);
        let foreground = self.desktop.foreground()?;
        let foreground_id = foreground.as_ref().map(|w| w.id);
        let windows = self.solid_windows()?.into_iter().map(|w| {
            let is_front = Some(w.id) == foreground_id;
            self.window_view(session, w, is_front)
        });
        Ok(WindowsReport { windows: windows.collect(), foreground: foreground.map(|w| self.window_view(session, w, true)) })
    }

    // ── Screen ───────────────────────────────────────────────────────────

    pub fn screen(&self, session_id: &str, options: ScreenOptions) -> Outcome<ScreenReport> {
        let mut inner = lock(&self.inner);
        require_session(&mut inner, session_id)?;
        self.refuse_if_stopped()?;
        self.refuse_if_paused()?;

        // What the user types into a password field is not for the model.
        // A focus query that fails does not withhold the picture: a password
        // field draws dots, and every action that types is checked again.
        if self.desktop.focused_element().ok().flatten().is_some_and(|e| e.password) {
            return Err(Refusal::new(
                code::PASSWORD_FIELD,
                "A password field has the focus, so the screenshot is withheld. Ask the user to type the password themselves and to say when they are done.",
            ));
        }

        let foreground = self.desktop.foreground()?;
        let monitors = self.desktop.monitors()?;
        let monitor = pick_monitor(&monitors, options.monitor_id, foreground.as_ref())
            .ok_or_else(|| Refusal::new(code::FAILED, "No display was found."))?
            .clone();

        // Without the window list nothing can be hidden, so nothing is shown.
        let windows = self.solid_windows()?;
        // A window of LU that the system keeps out of the capture is not in
        // the picture at all: the model sees what lies behind it, as if LU
        // were not there. Only where the system cannot do that is LU's own
        // window painted black, like every other window that is off limits.
        let hidden = self.visible_areas(&windows, &monitor.rect, |w| !Self::unseen(w) && blocklist::blocked(self.platform(), w).is_some());
        let own = self.visible_areas(&windows, &monitor.rect, |w| w.is_self && !Self::unseen(w));
        let covered = own.iter().filter_map(|area| geometry::rect_to_grid(&monitor.rect, area)).collect();

        let cursor = self.desktop.cursor().ok().filter(|(x, y)| monitor.rect.contains(*x, *y));
        let cursor = cursor.and_then(|(x, y)| geometry::input_to_grid(&monitor.rect, x, y)).map(|(x, y)| [x, y]);

        let max_edge = capture::clamp_max_edge(options.max_edge);
        let (width, height, scale, image, mime, look) = if options.no_image {
            let (w, h, scale) = geometry::fit_longest_edge(monitor.pixel_width, monitor.pixel_height, max_edge);
            (w, h, scale, None, None, None)
        } else {
            let raw = self.desktop.capture(monitor.id)?;
            let captured_width = raw.width().max(1);
            let prepared = capture::prepare(raw, &monitor.rect, &hidden, max_edge);
            let scale = f64::from(prepared.width()) / f64::from(captured_width);
            let bytes = capture::encode(&prepared, options.format, options.quality.unwrap_or(capture::DEFAULT_JPEG_QUALITY))?;
            (prepared.width(), prepared.height(), scale, Some(bytes), Some(options.format.mime()), Some(capture::fingerprint(&prepared)))
        };

        // Stopped while capturing: the picture stays here.
        self.refuse_if_stopped()?;

        inner.next_frame += 1;
        let frame_id = inner.next_frame;
        let captured = (self.clock)();
        let session = inner.session.as_mut().expect("checked above");
        session.frame = Some(Frame { id: frame_id, monitor: monitor.clone(), captured, foreground: foreground.as_ref().map(|w| w.id), own });
        if let Some(front) = foreground.as_ref().filter(|w| !w.is_self) {
            session.work_window = Some(front.id);
        }
        let foreground = foreground.map(|w| self.window_view(Some(session), w, true));
        Ok(ScreenReport { frame_id, monitor, width, height, scale, cursor, foreground, hidden_areas: hidden.len(), covered, look, mime, image })
    }

    /// A window of LU itself that no screen capture shows.
    fn unseen(window: &WindowInfo) -> bool {
        window.is_self && window.capture_excluded
    }

    /// The visible parts of the `wanted` windows on `monitor`. `windows` is
    /// front to back, so everything before a window may cover it.
    fn visible_areas(&self, windows: &[WindowInfo], monitor: &Rect, wanted: impl Fn(&WindowInfo) -> bool) -> Vec<Rect> {
        let mut areas = Vec::new();
        let mut above: Vec<Rect> = Vec::new();
        for window in windows.iter().filter(|w| !w.minimized && !w.rect.is_empty()) {
            if wanted(window) {
                if let Some(on_monitor) = monitor.intersect(&window.rect) {
                    areas.extend(geometry::visible_parts(&on_monitor, &above));
                }
            }
            // A window that is not in the picture covers nothing in it: what
            // lies under LU's panel is shown, so it is hidden when it has to be.
            if !Self::unseen(window) {
                above.push(window.rect);
            }
        }
        areas
    }

    // ── Tree ─────────────────────────────────────────────────────────────

    pub fn tree(&self, session_id: &str, max_depth: Option<u32>, max_nodes: Option<usize>) -> Outcome<TreeReport> {
        let mut inner = lock(&self.inner);
        let session = require_session(&mut inner, session_id)?;
        let result = self.read_tree(session, max_depth, max_nodes);
        Self::forget_hand_for_a_question(session, &result);
        result
    }

    fn read_tree(&self, session: &mut Session, max_depth: Option<u32>, max_nodes: Option<usize>) -> Outcome<TreeReport> {
        self.refuse_if_stopped()?;
        self.refuse_if_paused()?;
        if !self.desktop.tree_available() {
            return Err(super::adapter::tree_unavailable().into());
        }
        let foreground = self.desktop.foreground()?;
        self.require_allowed(session, foreground.as_ref())?;
        let window = foreground.expect("allowed means present");
        let frame = self.current_frame(session, None, Some(window.id))?;
        let raw = self.desktop.tree(&window, RAW_TREE_BUDGET)?;
        let pruned = tree::prune(&raw, &frame.monitor.rect, TreeLimits::clamped(max_depth, max_nodes));
        let text: String = pruned
            .nodes
            .iter()
            .flat_map(|n| [Some(n.name.as_str()), n.value.as_deref()])
            .flatten()
            .chain(std::iter::once(window.title.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        let warnings = injection::scan(&text);
        Ok(TreeReport {
            window: self.window_view(Some(session), window, true),
            nodes: pruned.nodes,
            dropped: pruned.dropped,
            password_focused: pruned.password_focused,
            warnings,
        })
    }

    // ── Frames ───────────────────────────────────────────────────────────

    /// The frame coordinates refer to, or why it can no longer be used.
    fn current_frame(&self, session: &Session, claimed: Option<u64>, foreground: Option<u64>) -> Outcome<Frame> {
        let stale = |why: &str| Refusal::new(code::STALE_FRAME, format!("{why} Take a new screenshot first."));
        let frame = session.frame.clone().ok_or_else(|| stale("There is no screenshot yet."))?;
        if claimed.is_some_and(|id| id != frame.id) {
            return Err(stale("These coordinates belong to an older screenshot."));
        }
        if (self.clock)().saturating_duration_since(frame.captured) > session.max_frame_age {
            return Err(stale("The last screenshot is too old."));
        }
        let monitors = self.desktop.monitors()?;
        let unchanged = monitors.iter().any(|m| {
            m.id == frame.monitor.id
                && m.rect == frame.monitor.rect
                && m.pixel_width == frame.monitor.pixel_width
                && m.pixel_height == frame.monitor.pixel_height
        });
        if !unchanged {
            return Err(stale("The display layout or scaling changed since the last screenshot."));
        }
        if frame.foreground != foreground {
            return Err(stale("Another window came to the front since the last screenshot."));
        }
        Ok(frame)
    }

    // ── Actions ──────────────────────────────────────────────────────────

    pub fn action(&self, session_id: &str, request: ActionRequest) -> Outcome<ActionReport> {
        let mut inner = lock(&self.inner);
        let session = require_session(&mut inner, session_id)?;
        let result = self.act(session, request);
        Self::forget_hand_for_a_question(session, &result);
        result
    }

    /// The answer is a question for the user: may LU use this app, may it run
    /// this action. The user answers it in LU's own window with the mouse,
    /// whatever the answer is. That hand is not a takeover, so it is forgotten
    /// here, and counts again from LU's next action.
    fn forget_hand_for_a_question<T>(session: &mut Session, result: &Outcome<T>) {
        if let Err(refusal) = result {
            if refusal.code == code::NEEDS_APPROVAL || refusal.code == code::NEEDS_CONFIRMATION {
                session.last_cursor = None;
                session.last_keys = None;
            }
        }
    }

    fn act(&self, session: &mut Session, request: ActionRequest) -> Outcome<ActionReport> {
        self.refuse_if_stopped()?;
        self.refuse_if_paused()?;

        if let Action::Wait { ms } = request.action {
            let ms = ms.min(MAX_WAIT_MS);
            self.wait(Duration::from_millis(ms))?;
            return Ok(ActionReport { performed: format!("Waited {ms} ms."), app: None, window_title: None });
        }

        self.desktop.input_ready()?;

        // The user grabbed the mouse between two actions of an autonomous run.
        if session.autonomous && !request.confirmed {
            self.check_takeover(session)?;
        }
        if request.confirmed {
            // The user just used the mouse to confirm. That is not a takeover.
            session.last_cursor = None;
            session.last_keys = None;
        }

        let mut foreground = self.desktop.foreground()?;

        if let Action::FocusWindow { window_id } = request.action {
            return self.focus_window(session, window_id, request.confirmed);
        }
        if let Action::MoveWindow { window_id, x, y, dx, dy, width, height } = request.action {
            let by = (dx.is_some() || dy.is_some()).then(|| (dx.unwrap_or(0), dy.unwrap_or(0)));
            return self.move_window(session, window_id, (x, y), by, width.zip(height), request.confirmed);
        }

        // LU's own window is in front: it kept the focus it had before the
        // task, or the user answered a question or a pause in it. Nothing is
        // typed or clicked there. The window LU works in comes back first, or
        // the action is refused. Never away from another app: only LU's own
        // window is left behind.
        if foreground.as_ref().is_some_and(|front| front.is_self) {
            foreground = Some(self.back_to_work(session, request.refocus_window)?);
        }

        self.require_allowed(session, foreground.as_ref())?;
        let front = foreground.expect("allowed means present");

        // A drag that starts on the title bar of the window in front means
        // "move this window". The system moves it by the same distance: the
        // place where the drag ends belongs to whatever lies beside the
        // window (the desktop, another app), and a drag with the mouse would
        // ask the user to approve that app for a move that never touches it
        // (box, 09.10.2026: "allow Windows Explorer" for a window pushed
        // 300 pixels to the right). Where the system names no title bar (apps
        // that draw their own), the mouse does it as before.
        if let Action::Drag { x, y, to_x, to_y } = request.action {
            if let Some(by) = self.title_bar_drag(session, &request, &front, (x, y), (to_x, to_y))? {
                return self.move_window(session, front.id, (0, 0), Some(by), None, request.confirmed);
            }
        }

        let plan = self.plan(session, &request, &front)?;

        if !request.confirmed {
            // The reason comes first, so a supervised session shows it too
            // and its question is not one a spoken yes may answer.
            if let Some(reason) = &plan.sensitive {
                let mut refusal = Refusal::new(code::NEEDS_CONFIRMATION, format!("{reason} It needs your confirmation.")).with_app(&front.app);
                refusal.sensitive = true;
                return Err(refusal);
            }
            if !session.autonomous {
                return Err(Refusal::new(code::NEEDS_CONFIRMATION, "This session is supervised. The user confirms each action.").with_app(&front.app));
            }
        }

        // Point of no return. Everything is read once more.
        let performed = match self.fire(session, &front, &plan.steps)? {
            Fired::All => plan.summary,
            // The whole action ran, and it went to the window that is in
            // front now. Naming the window that was in front before would
            // tell the model it missed, and it would do it again.
            Fired::CutShort { complete: true } => {
                let before = format!(" in {}.", display_name(&front.app));
                match self.desktop.foreground().ok().flatten().filter(|now| !now.is_self && plan.summary.ends_with(&before)) {
                    Some(now) => format!(
                        "{} in {}, which came to the front with it. This ran. Do not do it again.",
                        &plan.summary[..plan.summary.len() - before.len()],
                        display_name(&now.app)
                    ),
                    None => format!("{} Another window came to the front with it. This ran. Do not do it again.", plan.summary),
                }
            }
            Fired::CutShort { complete: false } => format!(
                "Only the first part of this ran: {} Another window came to the front in the middle, and the rest was not sent. Take a new screenshot to see what arrived before you do anything again.",
                plan.summary
            ),
        };

        let key = front.app.key.to_lowercase();
        if session.grants.get(&key) == Some(&GrantScope::Once) {
            session.grants.remove(&key);
        }
        session.last_cursor = self.desktop.cursor().ok();
        session.last_keys = self.desktop.user_key_presses();
        session.work_window = Some(front.id);
        Ok(ActionReport { performed, app: Some(front.app.clone()), window_title: Some(front.title.clone()) })
    }

    /// The window to go back to from LU's own: the first of `wanted` that is
    /// still open, belongs to another app and is approved. The first one that
    /// only lacks the approval is named too, so the user can be asked.
    fn work_target(&self, session: &Session, wanted: [Option<u64>; 2]) -> Outcome<WorkTarget> {
        let windows = self.solid_windows()?;
        let mut found = WorkTarget { allowed: None, unapproved: None };
        for id in wanted.into_iter().flatten() {
            let Some(window) = windows.iter().find(|w| w.id == id && !w.is_self) else { continue };
            match self.judge(Some(session), window).0 {
                Verdict::Allowed => {
                    found.allowed = Some(window.clone());
                    break;
                }
                Verdict::NeedsApproval if found.unapproved.is_none() => found.unapproved = Some(window.clone()),
                _ => {}
            }
        }
        Ok(found)
    }

    /// LU's own window is in front and an action is about to run. Bring the
    /// window LU works in to the front and return it, or say why nothing ran.
    /// `asked_over` is the window the interface saw in front before it asked
    /// the user; it counts before the one the engine remembers.
    fn back_to_work(&self, session: &Session, asked_over: Option<u64>) -> Outcome<WindowInfo> {
        let found = self.work_target(session, [asked_over, session.work_window])?;
        let Some(target) = found.allowed else {
            // The app LU worked in lost its approval (it was given once): ask again.
            if let Some(window) = found.unapproved {
                self.require_allowed(session, Some(&window))?;
            }
            return Err(Refusal::new(
                code::BLOCKED,
                "LU's own window is in front, so nothing was typed or clicked. Bring the window to work in to the front with focus_window and an id from the list of open windows, then take a new screenshot.",
            ));
        };
        self.refuse_if_stopped()?;
        if let Err(error) = self.desktop.focus_window(&target) {
            let mut refusal = Refusal::from(error).with_app(&target.app);
            refusal.message = format!("{} LU's own window is in front, so nothing was typed or clicked.", refusal.message);
            return Err(refusal);
        }
        self.desktop.pause(FOCUS_SETTLE);
        match self.desktop.foreground()? {
            Some(front) if front.id == target.id => Ok(front),
            _ => Err(Refusal::new(
                code::FAILED,
                format!(
                    "LU's own window is in front and {} did not come back to the front, so nothing was typed or clicked. Bring it to the front with focus_window, then take a new screenshot.",
                    display_name(&target.app)
                ),
            )
            .with_app(&target.app)),
        }
    }

    fn focus_window(&self, session: &mut Session, window_id: u64, confirmed: bool) -> Outcome<ActionReport> {
        let target = self
            .solid_windows()?
            .into_iter()
            .find(|w| w.id == window_id)
            .ok_or_else(|| Refusal::new(code::INVALID, "That window is not open any more. Take a new screenshot to see the current windows."))?;
        self.require_allowed(session, Some(&target))?;
        let summary = format!("Brought {} to the front.", display_name(&target.app));
        if !confirmed && !session.autonomous {
            return Err(Refusal::new(code::NEEDS_CONFIRMATION, "This session is supervised. The user confirms each action.").with_app(&target.app));
        }
        self.refuse_if_stopped()?;
        self.desktop.focus_window(&target)?;
        self.desktop.pause(FOCUS_SETTLE);
        let key = target.app.key.to_lowercase();
        if session.grants.get(&key) == Some(&GrantScope::Once) {
            session.grants.remove(&key);
        }
        session.last_cursor = self.desktop.cursor().ok();
        session.last_keys = self.desktop.user_key_presses();
        session.work_window = Some(target.id);
        Ok(ActionReport { performed: summary, app: Some(target.app.clone()), window_title: Some(target.title) })
    }

    /// The distance in pixels of a drag that starts on the title bar of
    /// `front`, or None for every other drag.
    fn title_bar_drag(&self, session: &Session, request: &ActionRequest, front: &WindowInfo, from: (i32, i32), to: (i32, i32)) -> Outcome<Option<(i32, i32)>> {
        let frame = self.current_frame(session, request.frame_id, Some(front.id))?;
        let (Some(start), Some(end)) = (geometry::grid_to_input(&frame.monitor.rect, from.0, from.1), geometry::grid_to_input(&frame.monitor.rect, to.0, to.1)) else {
            return Ok(None);
        };
        if !front.rect.contains(start.0, start.1) {
            return Ok(None);
        }
        let on_title_bar = self.desktop.element_at(start.0, start.1)?.is_some_and(|element| element.role == "TitleBar");
        Ok(on_title_bar.then_some((end.0 - start.0, end.1 - start.1)))
    }

    fn move_window(&self, session: &mut Session, window_id: u64, to: (i32, i32), by: Option<(i32, i32)>, size: Option<(i32, i32)>, confirmed: bool) -> Outcome<ActionReport> {
        let target = self
            .solid_windows()?
            .into_iter()
            .find(|w| w.id == window_id)
            .ok_or_else(|| Refusal::new(code::INVALID, "That window is not open any more. Take a new screenshot to see the current windows."))?;
        self.require_allowed(session, Some(&target))?;
        let monitors = self.desktop.monitors()?;
        let monitor = pick_monitor(&monitors, None, Some(&target)).ok_or_else(|| Refusal::new(code::FAILED, "No display was found."))?.rect;
        let off_grid = || Refusal::new(code::INVALID, "The place and the size of a window are numbers from 0 to 1000, relative to its display.");
        let (x, y) = match by {
            Some((dx, dy)) => (target.rect.x.saturating_add(dx), target.rect.y.saturating_add(dy)),
            None => geometry::grid_to_input(&monitor, to.0, to.1).ok_or_else(off_grid)?,
        };
        let (width, height) = match size {
            Some((w, h)) if w > 0 && h > 0 && w <= 1000 && h <= 1000 => (
                (i64::from(monitor.width) * i64::from(w) / 1000) as i32,
                (i64::from(monitor.height) * i64::from(h) / 1000) as i32,
            ),
            Some(_) => return Err(off_grid()),
            None => (target.rect.width, target.rect.height),
        };
        if !confirmed && !session.autonomous {
            return Err(Refusal::new(code::NEEDS_CONFIRMATION, "This session is supervised. The user confirms each action.").with_app(&target.app));
        }
        self.refuse_if_stopped()?;
        self.desktop.place_window(&target, Rect::new(x, y, width.max(120), height.max(80)))?;
        self.desktop.pause(FOCUS_SETTLE);
        // Believe the system, not the call: where is the window now?
        let now = self.solid_windows()?.into_iter().find(|w| w.id == window_id).map(|w| w.rect).unwrap_or(target.rect);
        // It was there already: that is what was asked for, not a failure.
        let wanted = (x, y, width.max(120), height.max(80));
        let near = |a: i32, b: i32| (a - b).abs() <= 16;
        let there = near(now.x, wanted.0) && near(now.y, wanted.1) && near(now.width, wanted.2) && near(now.height, wanted.3);
        if now == target.rect && !there {
            return Err(Refusal::new(code::FAILED, format!("{} did not move. A window that fills the screen or has a fixed place cannot be moved this way.", display_name(&target.app))));
        }
        let at = geometry::input_to_grid(&monitor, now.x, now.y).unwrap_or(to);
        let summary = format!("Moved {} to {}, {}. It is {} by {} on the 0 to 1000 grid now.", display_name(&target.app), at.0, at.1, i64::from(now.width) * 1000 / i64::from(monitor.width.max(1)), i64::from(now.height) * 1000 / i64::from(monitor.height.max(1)));
        session.last_cursor = self.desktop.cursor().ok();
        session.last_keys = self.desktop.user_key_presses();
        Ok(ActionReport { performed: summary, app: Some(target.app.clone()), window_title: Some(target.title) })
    }

    fn check_takeover(&self, session: &Session) -> Outcome<()> {
        if takeover::keys_pressed_since(session.last_keys, self.desktop.user_key_presses()) {
            return self.hand_seen();
        }
        let Some(left_at) = session.last_cursor else { return Ok(()) };
        let Ok(now) = self.desktop.cursor() else { return Ok(()) };
        if geometry::distance(left_at, now) > TAKEOVER_DISTANCE {
            return self.hand_seen();
        }
        Ok(())
    }

    /// Everything about an action that can be decided before it runs: the
    /// real coordinates, the events, the sentence, and whether it is
    /// sensitive. Refuses what must never run.
    fn plan(&self, session: &Session, request: &ActionRequest, front: &WindowInfo) -> Outcome<Plan> {
        // Before anything else about the place: is a window of LU itself
        // over it, or was it when the model looked?
        self.require_room(session, request, front)?;
        // Judged for every action the user has not confirmed yet, supervised
        // or autonomous: the reason has to stand in the question either way.
        let needs_sensitivity = !request.confirmed;
        let point = |gx: i32, gy: i32| -> Outcome<(i32, i32)> {
            let frame = self.current_frame(session, request.frame_id, Some(front.id))?;
            let (x, y) = geometry::grid_to_input(&frame.monitor.rect, gx, gy)
                .ok_or_else(|| Refusal::new(code::INVALID, "Coordinates must be between 0 and 1000 on both axes."))?;
            self.require_target(session, front, x, y, request.confirmed)?;
            Ok((x, y))
        };
        let target_sensitivity = |x: i32, y: i32, opens: bool| -> Outcome<Option<String>> {
            if !needs_sensitivity {
                return Ok(None);
            }
            let element = self.desktop.element_at(x, y)?;
            let reason = sensitive::sensitive_click(element.as_ref());
            Ok(if opens { reason.or_else(|| sensitive::sensitive_open(element.as_ref())) } else { reason })
        };
        let click_sensitivity = |x: i32, y: i32| target_sensitivity(x, y, false);
        let click = |button: MouseButton| [InputOp::Button { button, down: true }, InputOp::Button { button, down: false }];

        let plan = match &request.action {
            Action::Click { x, y } => {
                let (px, py) = point(*x, *y)?;
                let mut steps = vec![Step::Op(InputOp::Move { x: px, y: py }), Step::Pause(40)];
                steps.extend(click(MouseButton::Left).map(Step::Op));
                Plan { steps, summary: format!("Clicked at {x}, {y} in {}.", display_name(&front.app)), sensitive: click_sensitivity(px, py)? }
            }
            Action::DoubleClick { x, y } => {
                let (px, py) = point(*x, *y)?;
                let mut steps = vec![Step::Op(InputOp::Move { x: px, y: py }), Step::Pause(40)];
                steps.extend(click(MouseButton::Left).map(Step::Op));
                steps.push(Step::Pause(60));
                steps.extend(click(MouseButton::Left).map(Step::Op));
                Plan { steps, summary: format!("Double clicked at {x}, {y} in {}.", display_name(&front.app)), sensitive: target_sensitivity(px, py, true)? }
            }
            Action::RightClick { x, y } => {
                let (px, py) = point(*x, *y)?;
                let mut steps = vec![Step::Op(InputOp::Move { x: px, y: py }), Step::Pause(40)];
                steps.extend(click(MouseButton::Right).map(Step::Op));
                Plan { steps, summary: format!("Right clicked at {x}, {y} in {}.", display_name(&front.app)), sensitive: None }
            }
            Action::Move { x, y } => {
                let (px, py) = point(*x, *y)?;
                Plan { steps: vec![Step::Op(InputOp::Move { x: px, y: py })], summary: format!("Moved the pointer to {x}, {y}."), sensitive: None }
            }
            Action::Drag { x, y, to_x, to_y } => {
                let (sx, sy) = point(*x, *y)?;
                let (ex, ey) = point(*to_x, *to_y)?;
                let mut steps = vec![
                    Step::Op(InputOp::Move { x: sx, y: sy }),
                    Step::Pause(60),
                    Step::Op(InputOp::Button { button: MouseButton::Left, down: true }),
                    Step::Pause(80),
                ];
                for i in 1..=DRAG_STEPS {
                    steps.push(Step::Op(InputOp::Move { x: sx + (ex - sx) * i / DRAG_STEPS, y: sy + (ey - sy) * i / DRAG_STEPS }));
                    steps.push(Step::Pause(15));
                }
                steps.push(Step::Pause(80));
                steps.push(Step::Op(InputOp::Button { button: MouseButton::Left, down: false }));
                Plan {
                    steps,
                    summary: format!("Dragged from {x}, {y} to {to_x}, {to_y} in {}.", display_name(&front.app)),
                    sensitive: click_sensitivity(ex, ey)?,
                }
            }
            Action::Scroll { x, y, dx, dy } => {
                let dx = (*dx).clamp(-MAX_SCROLL_NOTCHES, MAX_SCROLL_NOTCHES);
                let dy = (*dy).clamp(-MAX_SCROLL_NOTCHES, MAX_SCROLL_NOTCHES);
                if dx == 0 && dy == 0 {
                    return Err(Refusal::new(code::INVALID, "Scroll needs dx or dy other than zero."));
                }
                let mut steps = Vec::new();
                match (x, y) {
                    (Some(x), Some(y)) => {
                        let (px, py) = point(*x, *y)?;
                        steps.push(Step::Op(InputOp::Move { x: px, y: py }));
                        steps.push(Step::Pause(40));
                    }
                    (None, None) => {
                        // Scrolls where the pointer is. That has to be an allowed window too.
                        let (cx, cy) = self.desktop.cursor()?;
                        self.require_target(session, front, cx, cy, request.confirmed)?;
                    }
                    _ => return Err(Refusal::new(code::INVALID, "Scroll needs both x and y, or neither.")),
                }
                steps.push(Step::Op(InputOp::Scroll { dx, dy }));
                Plan { steps, summary: format!("Scrolled by {dx}, {dy} in {}.", display_name(&front.app)), sensitive: None }
            }
            Action::Type { text } => {
                let count = text.chars().count();
                if count == 0 {
                    return Err(Refusal::new(code::INVALID, "There is no text to type."));
                }
                if count > MAX_TEXT_CHARS {
                    return Err(Refusal::new(code::INVALID, format!("The text is too long. Type at most {MAX_TEXT_CHARS} characters at a time.")));
                }
                if text.contains('\0') {
                    return Err(Refusal::new(code::INVALID, "The text contains a character that cannot be typed."));
                }
                // The platform can tell which field has the focus, and this
                // time the question failed. "Unknown" is not "safe": the user
                // confirms, with the reason, before anything is typed.
                let (focused, focus_unknown) = match self.desktop.focused_element() {
                    Ok(focused) => (focused, false),
                    Err(_) => (None, true),
                };
                if focused.as_ref().is_some_and(|e| e.password) {
                    return Err(Refusal::new(
                        code::PASSWORD_FIELD,
                        "A password field has the focus. LU does not type into password fields. Ask the user to type the password themselves and to say when they are done.",
                    )
                    .with_app(&front.app));
                }
                // A tab or a line break moves the focus, so the text is cut
                // after each one and the field is checked again before the
                // rest goes out: "name, tab, password" must not end up in a
                // password field that had no focus when the check above ran.
                let chars: Vec<char> = text.chars().collect();
                let mut steps = Vec::new();
                for (index, part) in chars.split_inclusive(|c| matches!(c, '\t' | '\n' | '\r')).enumerate() {
                    if index > 0 {
                        steps.push(Step::NoPasswordFocus);
                    }
                    steps.extend(part.chunks(TYPE_CHUNK_CHARS).map(|chunk| Step::Op(InputOp::Text(chunk.iter().collect()))));
                }
                Plan {
                    steps,
                    summary: format!("Typed {count} characters in {}.", display_name(&front.app)),
                    sensitive: if focus_unknown && !request.confirmed {
                        Some(FOCUS_UNKNOWN.to_string())
                    } else if needs_sensitivity {
                        sensitive::sensitive_text(text, focused.as_ref())
                    } else {
                        None
                    },
                }
            }
            Action::Key { keys, repeat } => {
                let chord = keys::parse_chord(keys).map_err(|message| Refusal::new(code::INVALID, message))?;
                if lock(&self.stop_chord).as_ref().is_some_and(|stop| stop.is(&chord.modifiers, chord.key)) {
                    return Err(Refusal::new(code::INVALID, "That chord is the stop shortcut of computer control and belongs to the user."));
                }
                if lock(&self.pause_chord).as_ref().is_some_and(|pause| pause.is(&chord.modifiers, chord.key)) {
                    return Err(Refusal::new(code::INVALID, "That chord is the pause shortcut of computer control and belongs to the user."));
                }
                if chord.is(&[Modifier::Control, Modifier::Alt], KeyName::Delete) {
                    return Err(Refusal::new(code::BLOCKED, BlockReason::SystemDialog.sentence()));
                }
                if let Some(opens) = blocklist::blocked_chord(self.platform(), &chord) {
                    return Err(Refusal::new(
                        code::BLOCKED,
                        format!("{opens} {} Work in a window that is already open, or ask the user to open the app.", BlockReason::Launcher.sentence()),
                    ));
                }
                // The rule for `type` holds for keys too: a password is not
                // spelled one key at a time, and the clipboard is not pasted
                // into the field. Keys that only move or leave stay free.
                let focused = self.desktop.focused_element().ok().flatten();
                if focused.as_ref().is_some_and(|e| e.password) && keys::enters_text(&chord) {
                    return Err(Refusal::new(
                        code::PASSWORD_FIELD,
                        "A password field has the focus. LU does not type or paste into password fields. Ask the user to type the password themselves and to say when they are done.",
                    )
                    .with_app(&front.app));
                }
                let repeat = repeat.unwrap_or(1).clamp(1, MAX_KEY_REPEAT);
                let mut steps = Vec::new();
                for round in 0..repeat {
                    if round > 0 {
                        steps.push(Step::Pause(30));
                    }
                    steps.extend(chord.modifiers.iter().map(|m| Step::Op(InputOp::Modifier { modifier: *m, down: true })));
                    steps.push(Step::Op(InputOp::Tap(chord.key)));
                    steps.extend(chord.modifiers.iter().rev().map(|m| Step::Op(InputOp::Modifier { modifier: *m, down: false })));
                }
                // An unknown focus is judged like no focus: Enter and Delete ask.
                let sensitive = if needs_sensitivity {
                    sensitive::sensitive_key(&chord, focused.as_ref()).or_else(|| sensitive::sensitive_access_key(self.platform(), &chord))
                } else {
                    None
                };
                Plan { steps, summary: format!("Pressed {} in {}.", keys.trim().to_lowercase(), display_name(&front.app)), sensitive }
            }
            Action::Wait { .. } | Action::FocusWindow { .. } | Action::MoveWindow { .. } => unreachable!("handled before the plan"),
        };
        Ok(plan)
    }

    /// The points a pointer action aims at, in the input space. Empty for an
    /// action without a place, and for one whose place cannot be read (no
    /// usable frame, a coordinate off the grid): that is said where the
    /// action is planned.
    fn aims(&self, session: &Session, request: &ActionRequest, front: &WindowInfo) -> Vec<(i32, i32)> {
        let grid: Vec<(i32, i32)> = match &request.action {
            Action::Click { x, y } | Action::DoubleClick { x, y } | Action::RightClick { x, y } | Action::Move { x, y } => vec![(*x, *y)],
            Action::Drag { x, y, to_x, to_y } => vec![(*x, *y), (*to_x, *to_y)],
            Action::Scroll { x: Some(x), y: Some(y), .. } => vec![(*x, *y)],
            // Scrolls where the pointer is.
            Action::Scroll { x: None, y: None, .. } => return self.desktop.cursor().map(|at| vec![at]).unwrap_or_default(),
            _ => return Vec::new(),
        };
        let Ok(frame) = self.current_frame(session, request.frame_id, Some(front.id)) else { return Vec::new() };
        grid.into_iter().map(|(gx, gy)| geometry::grid_to_input(&frame.monitor.rect, gx, gy)).collect::<Option<Vec<_>>>().unwrap_or_default()
    }

    /// A click must never land in a window of LU itself. The refusal carries
    /// every point of the action, so the panel can be moved to where none of
    /// them is, and says whether the model saw the spot (the panel is kept
    /// out of the capture) or only a black area.
    fn require_room(&self, session: &Session, request: &ActionRequest, front: &WindowInfo) -> Outcome<()> {
        let aims = self.aims(session, request, front);
        if aims.is_empty() {
            return Ok(());
        }
        let mut there_now = false;
        for (x, y) in &aims {
            if self.target_at(*x, *y)?.is_some_and(|window| window.is_self) {
                there_now = true;
                break;
            }
        }
        let was_there = session.frame.as_ref().is_some_and(|frame| aims.iter().any(|(x, y)| frame.own.iter().any(|area| area.contains(*x, *y))));
        if !there_now && !was_there {
            return Ok(());
        }
        let mut refusal = Refusal::new(code::BLOCKED, BlockReason::OwnApp.sentence());
        refusal.own_window = Some(OwnWindow { aims, there_now, in_picture: was_there });
        Err(refusal)
    }

    /// The window a pointer action would land in has to pass the same guard
    /// as the window in front. A click on a terminal next to the allowed app
    /// would otherwise bring the terminal to the front and type into it.
    fn require_target(&self, session: &Session, front: &WindowInfo, x: i32, y: i32, confirmed: bool) -> Outcome<()> {
        match self.target_at(x, y)? {
            Some(target) if target.id == front.id => Ok(()),
            Some(target) => self.require_allowed(session, Some(&target)),
            // Nothing LU knows is there (a dock, a system tray, the desktop).
            None if confirmed => Ok(()),
            None => {
                let mut refusal = Refusal::new(code::NEEDS_CONFIRMATION, "LU cannot tell which window this point belongs to. It needs your confirmation.").with_app(&front.app);
                refusal.sensitive = true;
                Err(refusal)
            }
        }
    }

    /// Run the events. Before the first one and between all of them: stopped?
    /// Still the same window in front? Did the user grab the mouse or press
    /// a key?
    ///
    /// An action that already pressed, typed or scrolled something has run.
    /// A window that comes to the front after that is something LU saw, not
    /// a reason to say nothing ran: a click on a window in the background
    /// brings it to the front between the press and the release, and a
    /// refusal there made the model click a second time (box, 09.10.2026:
    /// a counter at 2 after "one" click). The rest is still not sent into
    /// the new window. Only what is held gets released.
    fn fire(&self, session: &Session, front: &WindowInfo, steps: &[Step]) -> Outcome<Fired> {
        let mut expected_cursor: Option<(i32, i32)> = None;
        let keys_before = if session.autonomous { self.desktop.user_key_presses() } else { None };
        let mut fired = false;
        let mut acted = false;
        let result = (|| -> Outcome<Fired> {
            for (index, step) in steps.iter().enumerate() {
                match step {
                    Step::Pause(ms) => self.desktop.pause(Duration::from_millis(*ms)),
                    Step::NoPasswordFocus => {
                        // Let the focus arrive where the tab sent it.
                        self.desktop.pause(Duration::from_millis(FOCUS_MOVE_SETTLE_MS));
                        match self.desktop.focused_element() {
                            Ok(focused) if focused.as_ref().is_some_and(|e| e.password) => {
                                return Err(Refusal::new(
                                    code::PASSWORD_FIELD,
                                    "The text moved the focus into a password field, so LU stopped typing there. LU does not type into password fields. Ask the user to type the password themselves and to say when they are done.",
                                )
                                .with_app(&front.app));
                            }
                            Ok(_) => {}
                            // "Unknown" is not "safe" here either.
                            Err(_) => {
                                return Err(Refusal::new(
                                    code::FAILED,
                                    "The text moved the focus and LU could not check which field has it now, so the rest was not typed. Take a new screenshot and go on from there.",
                                )
                                .with_app(&front.app));
                            }
                        }
                    }
                    Step::Op(op) => {
                        self.refuse_if_stopped()?;
                        // The pause shortcut lands between two events too.
                        self.refuse_if_paused()?;
                        if let Err(refusal) = self.same_foreground(session, front) {
                            if !acted {
                                return Err(refusal);
                            }
                            if steps[index..].iter().all(Step::only_lets_go) {
                                return Ok(Fired::CutShort { complete: true });
                            }
                            if refusal.code == code::STALE_FRAME {
                                return Ok(Fired::CutShort { complete: false });
                            }
                            // The new window is one LU may not use. That
                            // stays the answer, with what already happened.
                            let mut refusal = refusal;
                            refusal.message = format!("The first part of the action was already sent, the rest was not. {}", refusal.message);
                            return Err(refusal);
                        }
                        if takeover::keys_pressed_since(keys_before, self.desktop.user_key_presses()) {
                            self.hand_seen()?;
                        }
                        if let Some(expected) = expected_cursor {
                            if let Ok(now) = self.desktop.cursor() {
                                if geometry::distance(expected, now) > TAKEOVER_DISTANCE {
                                    self.hand_seen()?;
                                }
                            }
                        }
                        self.desktop.input(op)?;
                        fired = true;
                        acted |= !matches!(op, InputOp::Move { .. });
                        if let InputOp::Move { x, y } = op {
                            expected_cursor = Some((*x, *y));
                        }
                    }
                }
            }
            Ok(Fired::All)
        })();
        if fired && !matches!(result, Ok(Fired::All)) {
            // Cut short in the middle: nothing may stay pressed.
            self.desktop.release_all();
        }
        result
    }

    fn same_foreground(&self, session: &Session, judged: &WindowInfo) -> Outcome<()> {
        let now = self.desktop.foreground()?;
        match &now {
            Some(window) if window.id == judged.id && window.app.key == judged.app.key => Ok(()),
            other => {
                // Something else is in front now. Say what, by the same rules.
                self.require_allowed(session, other.as_ref())?;
                Err(Refusal::new(code::STALE_FRAME, "Another window came to the front just before the action. Take a new screenshot first."))
            }
        }
    }

    /// Sleep in slices, so Stop lands within one of them.
    fn wait(&self, total: Duration) -> Outcome<()> {
        let mut left = total;
        while !left.is_zero() {
            self.refuse_if_stopped()?;
            self.refuse_if_paused()?;
            let slice = left.min(WAIT_SLICE);
            self.desktop.pause(slice);
            left -= slice;
        }
        self.refuse_if_stopped()
    }
}

enum Step {
    Op(InputOp),
    Pause(u64),
    /// Typed text just moved the focus: no password field may have it now.
    NoPasswordFocus,
}

impl Step {
    /// Nothing new reaches a window with this step: it waits, or it lets go
    /// of a button or a modifier, which the engine does anyway when it stops.
    fn only_lets_go(&self) -> bool {
        match self {
            Step::Pause(_) => true,
            Step::Op(InputOp::Button { down, .. } | InputOp::Modifier { down, .. }) => !down,
            Step::Op(_) | Step::NoPasswordFocus => false,
        }
    }
}

/// How far the events of one action got.
enum Fired {
    All,
    /// Another window came to the front after something was already sent.
    /// `complete`: only letting go was left, so the whole action ran.
    CutShort { complete: bool },
}

struct WorkTarget {
    allowed: Option<WindowInfo>,
    unapproved: Option<WindowInfo>,
}

struct Plan {
    steps: Vec<Step>,
    summary: String,
    sensitive: Option<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn require_session<'a>(inner: &'a mut Inner, session_id: &str) -> Outcome<&'a mut Session> {
    inner
        .session
        .as_mut()
        .filter(|s| s.id == session_id)
        .ok_or_else(|| Refusal::new(code::NO_SESSION, "There is no computer control session. Start one first."))
}

fn any_session(inner: &Inner) -> Outcome<&Session> {
    inner.session.as_ref().ok_or_else(|| Refusal::new(code::NO_SESSION, "There is no computer control session. Start one first."))
}

fn valid_chat(chat_id: &str) -> Outcome<&str> {
    let chat_id = chat_id.trim();
    if chat_id.is_empty() {
        return Err(Refusal::new(code::INVALID, "A chat is needed to ask about computer control."));
    }
    Ok(chat_id)
}

fn chat_refusal() -> Refusal {
    Refusal::new(code::NEEDS_CHAT_PERMISSION, "The user has not allowed computer control in this chat.")
}

pub fn display_name(app: &AppIdentity) -> &str {
    if app.name.trim().is_empty() {
        &app.key
    } else {
        &app.name
    }
}

/// The monitor to capture: the requested one, else the one holding most of
/// the window in front, else the primary one.
fn pick_monitor<'a>(monitors: &'a [MonitorInfo], requested: Option<u32>, foreground: Option<&WindowInfo>) -> Option<&'a MonitorInfo> {
    if let Some(id) = requested {
        if let Some(found) = monitors.iter().find(|m| m.id == id) {
            return Some(found);
        }
    }
    let by_window = foreground.filter(|w| !w.minimized && !w.is_self).and_then(|w| {
        monitors
            .iter()
            .filter_map(|m| m.rect.intersect(&w.rect).map(|hit| (i64::from(hit.width) * i64::from(hit.height), m)))
            .max_by_key(|(area, _)| *area)
            .map(|(_, m)| m)
    });
    by_window.or_else(|| monitors.iter().find(|m| m.primary)).or_else(|| monitors.first())
}

#[cfg(test)]
mod tests;
