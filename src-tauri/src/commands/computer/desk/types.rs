//! Shared shapes of the computer use core. Nothing in here touches the OS.

use serde::{Deserialize, Serialize};

/// A rectangle in the input space of the platform: physical pixels on Windows
/// and X11, points on macOS. `x`/`y` may be negative (a monitor left of or
/// above the primary one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self { x, y, width, height }
    }
    pub fn right(&self) -> i32 {
        self.x.saturating_add(self.width)
    }
    pub fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height)
    }
    pub fn is_empty(&self) -> bool {
        self.width <= 0 || self.height <= 0
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        !self.is_empty() && x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (right > x && bottom > y).then(|| Rect::new(x, y, right - x, bottom - y))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    /// Position and size in the input space (see [`Rect`]).
    pub rect: Rect,
    /// Size of a capture of this monitor in real pixels.
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// Display scaling (1.5 for 150 percent). Reported, never used for math
    /// that the input space already answers.
    pub scale_factor: f32,
    pub primary: bool,
}

/// Which application a window belongs to. `key` is what approvals and the
/// blocklist are keyed by: the lower case executable file name on Windows and
/// Linux, the lower case bundle id on macOS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppIdentity {
    pub key: String,
    pub name: String,
    pub exe: Option<String>,
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u64,
    pub pid: u32,
    pub app: AppIdentity,
    pub title: String,
    /// Window class on Windows, WM_CLASS on X11.
    pub class_name: Option<String>,
    pub rect: Rect,
    pub minimized: bool,
    /// Runs with more rights than LU (administrator, root). `None` when the
    /// platform cannot tell.
    pub elevated: Option<bool>,
    /// A window of this very process.
    pub is_self: bool,
    /// The Run dialog of the system: it runs whatever is typed into it.
    #[serde(default)]
    pub launcher: bool,
    /// The system keeps this window out of every screen capture: a picture
    /// of the display shows what lies behind it. Only LU's own panel and its
    /// glow can be that, and only where the system can do it (Windows 10
    /// 2004 and later). Everywhere else LU's own windows are painted black.
    #[serde(default)]
    pub capture_excluded: bool,
}

/// One element of the accessibility tree as the platform reports it, in
/// pre-order. The value of a password field is never read.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RawNode {
    pub depth: u32,
    pub role: String,
    pub name: String,
    pub rect: Rect,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
    pub password: bool,
    /// "checked", "unchecked" or "selected", for elements that have such a state.
    pub state: Option<String>,
    /// What a field holds right now. Never for a password field.
    pub value: Option<String>,
}

/// What is known about one element: the one under a click or the one that
/// holds the keyboard focus.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementInfo {
    pub role: String,
    pub name: String,
    pub password: bool,
}

/// A pruned tree element for the model. `rect` is `[left, top, right, bottom]`
/// on the 0..1000 grid of the current frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiNode {
    pub depth: u32,
    pub role: String,
    pub name: String,
    pub rect: [i32; 4],
    pub enabled: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub focused: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub password: bool,
    /// "checked", "unchecked" or "selected". Without it a model that ticks a
    /// box is told that nothing changed, and ticks it again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// What a field holds, shortened. The model checks its own typing with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// Why something was not done. `code` is stable and read by the interface,
/// `message` is the English sentence for the user and the model.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<Box<AppIdentity>>,
    /// For `needs_confirmation`: true when the action itself looks sensitive
    /// (send, buy, delete, permissions), false when the session is simply
    /// supervised.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sensitive: bool,
    /// For `unavailable`: the permission of the operating system that is
    /// missing, when that is the reason. The interface then shows the way to
    /// grant it instead of only this sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<Permission>,
    /// A pointer action aimed at a spot under a window of LU itself. Not for
    /// the interface: whoever owns that window may move it out of the way.
    #[serde(skip)]
    pub own_window: Option<OwnWindow>,
}

/// Where a pointer action aimed when a window of LU itself was in its way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnWindow {
    /// Every point of the action, in the input space.
    pub aims: Vec<(i32, i32)>,
    /// The window is over one of them right now. False when it only was in
    /// the screenshot the model chose from.
    pub there_now: bool,
    /// The window was in the screenshot the model chose from, as a black
    /// area. False where the system keeps LU's windows out of the capture:
    /// the model saw the spot itself, so the step is good as it is.
    pub in_picture: bool,
}

/// A permission of the operating system that computer control cannot work
/// without. Only macOS has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    /// Simulated mouse and keyboard input.
    Accessibility,
    /// Screenshots and the titles of other apps' windows.
    ScreenRecording,
}

/// What the operating system has granted. On a system without such
/// permissions `needed` is false and both count as granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub needed: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
}

impl Refusal {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), app: None, sensitive: false, permission: None, own_window: None }
    }
    pub fn with_app(mut self, app: &AppIdentity) -> Self {
        self.app = Some(Box::new(app.clone()));
        self
    }
}

pub type Outcome<T> = Result<T, Refusal>;

/// Stable refusal codes.
pub mod code {
    pub const NO_SESSION: &str = "no_session";
    pub const STOPPED: &str = "stopped";
    /// The user has the mouse or the keyboard and has not answered yet.
    pub const PAUSED: &str = "paused";
    pub const BLOCKED: &str = "blocked";
    /// The panel of LU was over the spot and has moved away, or is gone: the
    /// step did not run, and the model looks again.
    pub const COVERED: &str = "covered";
    pub const NEEDS_APPROVAL: &str = "needs_approval";
    /// The user has not said yes to computer control in this chat.
    pub const NEEDS_CHAT_PERMISSION: &str = "needs_chat_permission";
    pub const NEEDS_CONFIRMATION: &str = "needs_confirmation";
    pub const STALE_FRAME: &str = "stale_frame";
    pub const PASSWORD_FIELD: &str = "password_field";
    pub const INVALID: &str = "invalid";
    pub const UNAVAILABLE: &str = "unavailable";
    pub const FAILED: &str = "failed";
}

/// A failure of the platform layer: one English sentence, never a passed
/// through OS text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformError {
    /// True when the platform cannot do this at all (as opposed to "it failed
    /// this time").
    pub unavailable: bool,
    pub message: String,
    /// The permission that is missing, when that is why.
    pub permission: Option<Permission>,
}

impl PlatformError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self { unavailable: false, message: message.into(), permission: None }
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self { unavailable: true, message: message.into(), permission: None }
    }
    /// Not available until the user grants `permission` to LU.
    pub fn needs(permission: Permission, message: impl Into<String>) -> Self {
        Self { unavailable: true, message: message.into(), permission: Some(permission) }
    }
}

impl From<PlatformError> for Refusal {
    fn from(e: PlatformError) -> Self {
        let mut refusal = Refusal::new(if e.unavailable { code::UNAVAILABLE } else { code::FAILED }, e.message);
        refusal.permission = e.permission;
        refusal
    }
}

pub type PlatformResult<T> = Result<T, PlatformError>;
