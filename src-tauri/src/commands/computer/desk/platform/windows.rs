//! Windows: Win32 for windows and the pointer, `xcap` for monitors and
//! capture, `enigo` for buttons, keys and text, UI Automation for the tree.
//!
//! Everything runs on one worker thread. That thread is per-monitor DPI aware
//! (V2), so every coordinate Win32 hands out or takes is a physical pixel of
//! the virtual desktop, whatever scaling a display uses. The same thread owns
//! COM and the UI Automation client.

use super::super::adapter::{Desktop, InputOp};
use super::super::blocklist::Platform;
use super::super::geometry::{to_absolute_65535, virtual_desktop};
use super::super::sensitive::named_target;
use super::super::types::{AppIdentity, ElementInfo, MonitorInfo, PlatformError, PlatformResult, RawNode, Rect, WindowInfo};
use super::{input, user_keys, Worker};
use image::RgbaImage;
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use uiautomation::types::{Handle, Point, TreeScope, UIProperty};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetDlgItem, GetForegroundWindow, GetSystemMetrics, GetWindowLongW,
    GetWindowDisplayAffinity, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, InternalGetWindowText, IsIconic, IsWindowVisible, IsZoomed, SetCursorPos, SetForegroundWindow, SetWindowPos, ShowWindow,
    WindowFromPoint, GA_ROOT, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

const TREE_DEADLINE: Duration = Duration::from_secs(4);
const TREE_MAX_DEPTH: u32 = 40;

pub struct WindowsDesktop {
    own_pid: u32,
    worker: PlatformResult<Worker>,
}

impl WindowsDesktop {
    pub fn new(own_pid: u32) -> Self {
        let worker = Worker::spawn("lu-computer", || unsafe {
            // Per thread, so it does not depend on how the process was set up.
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        });
        Self { own_pid, worker }
    }

    fn run<R: Send + 'static>(&self, work: impl FnOnce() -> PlatformResult<R> + Send + 'static) -> PlatformResult<R> {
        match &self.worker {
            Ok(worker) => worker.run(work),
            Err(error) => Err(error.clone()),
        }
    }
}

// ── Strings ──────────────────────────────────────────────────────────────

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buffer: &[u16], len: usize) -> String {
    String::from_utf16_lossy(&buffer[..len.min(buffer.len())])
}

// ── Processes ────────────────────────────────────────────────────────────

struct ProcessFacts {
    exe: Option<String>,
    description: Option<String>,
    elevated: Option<bool>,
}

/// What can be read about a process without any special right. A process
/// that does not even allow that runs above LU and is treated as elevated.
unsafe fn process_facts(pid: u32) -> ProcessFacts {
    let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
        return ProcessFacts { exe: None, description: None, elevated: Some(true) };
    }
    let mut buffer = [0u16; 1024];
    let mut len = buffer.len() as u32;
    let exe = (QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len) != 0).then(|| from_wide(&buffer, len as usize));

    let mut token: HANDLE = std::ptr::null_mut();
    let elevated = if OpenProcessToken(handle, TOKEN_QUERY, &mut token) != 0 {
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        CloseHandle(token);
        if ok != 0 {
            Some(elevation.TokenIsElevated != 0)
        } else {
            Some(true)
        }
    } else {
        // The token of a protected or higher process cannot be opened.
        Some(true)
    };
    CloseHandle(handle);
    let description = exe.as_deref().and_then(|path| file_description(path));
    ProcessFacts { exe, description, elevated }
}

/// The "File description" of an executable, the name people know an app by.
unsafe fn file_description(path: &str) -> Option<String> {
    let wide_path = wide(path);
    let mut ignored = 0u32;
    let size = GetFileVersionInfoSizeW(wide_path.as_ptr(), &mut ignored);
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    if GetFileVersionInfoW(wide_path.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 {
        return None;
    }
    let mut pointer: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len = 0u32;
    let translation = wide("\\VarFileInfo\\Translation");
    if VerQueryValueW(data.as_ptr().cast(), translation.as_ptr(), &mut pointer, &mut len) == 0 || pointer.is_null() || len < 4 {
        return None;
    }
    let pair = std::slice::from_raw_parts(pointer as *const u16, 2);
    let (language, codepage) = (pair[0], pair[1]);
    let query = wide(&format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\FileDescription"));
    let mut pointer: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len = 0u32;
    if VerQueryValueW(data.as_ptr().cast(), query.as_ptr(), &mut pointer, &mut len) == 0 || pointer.is_null() || len == 0 {
        return None;
    }
    let text = std::slice::from_raw_parts(pointer as *const u16, len as usize);
    let text = String::from_utf16_lossy(text);
    let text = text.trim_end_matches('\0').trim();
    (!text.is_empty()).then(|| text.to_string())
}

// ── Windows ──────────────────────────────────────────────────────────────

fn window_id(hwnd: HWND) -> u64 {
    hwnd as usize as u64
}

fn hwnd_of(id: u64) -> HWND {
    id as usize as HWND
}

unsafe fn window_text(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    // A window of LU itself is read without a message. GetWindowTextW sends
    // WM_GETTEXT to a window of the own process and waits for its thread, and
    // that thread may be the one waiting for this answer: the pause asks for
    // the window in front from the main thread, and the window in front can
    // be LU's own question field. Both threads then wait for each other.
    let len = if window_pid(hwnd) == GetCurrentProcessId() {
        InternalGetWindowText(hwnd, buffer.as_mut_ptr(), buffer.len() as i32)
    } else {
        GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32)
    };
    from_wide(&buffer, len.max(0) as usize)
}

unsafe fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
    from_wide(&buffer, len.max(0) as usize)
}

unsafe fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    pid
}

/// The rectangle people see, without the invisible resize border.
unsafe fn window_rect(hwnd: HWND) -> Rect {
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let size = std::mem::size_of::<RECT>() as u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut rect as *mut RECT).cast(), size) != 0 {
        GetWindowRect(hwnd, &mut rect);
    }
    Rect::new(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
}

unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), 4) == 0 && cloaked != 0
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam as *mut Vec<HWND>);
    list.push(hwnd);
    1
}

/// A Store app lives in a frame window of ApplicationFrameHost. The app
/// itself is the child window that belongs to another process.
unsafe fn hosted_app_pid(frame: HWND, frame_pid: u32) -> Option<u32> {
    let mut children: Vec<HWND> = Vec::new();
    EnumChildWindows(frame, Some(collect_window), &mut children as *mut Vec<HWND> as LPARAM);
    children.into_iter().map(|child| window_pid(child)).find(|pid| *pid != 0 && *pid != frame_pid)
}

/// The Run dialog (Win+R, and "Run new task" elsewhere) is a plain dialog of
/// the file manager, so neither its process nor its class gives it away, and
/// its title is translated. Its controls are not: the command box and the
/// Browse button carry the same ids in every language.
unsafe fn is_run_dialog(hwnd: HWND, class: &str) -> bool {
    const RUN_COMMAND_BOX: i32 = 12298;
    const RUN_BROWSE_BUTTON: i32 = 12288;
    if class != "#32770" {
        return false;
    }
    let command = GetDlgItem(hwnd, RUN_COMMAND_BOX);
    !command.is_null() && class_name(command).eq_ignore_ascii_case("ComboBox") && !GetDlgItem(hwnd, RUN_BROWSE_BUTTON).is_null()
}

const WEBVIEW_HOST: &str = "msedgewebview2.exe";

/// The interface of LU is drawn by a WebView process that LU starts. Its
/// tooltips and drop down lists are top level windows of that process, not of
/// LU itself, so they showed up in a look as windows of a foreign app (box,
/// 07.10.2026). A WebView process below LU belongs to LU.
fn is_own_webview(pid: u32, own_pid: u32) -> bool {
    use crate::commands::install::pip::{descendants_of, process_parents};
    descendants_of(own_pid, &process_parents()).contains(&pid)
}

unsafe fn describe(hwnd: HWND, own_pid: u32, cache: &mut HashMap<u32, (AppIdentity, Option<bool>)>) -> WindowInfo {
    let class = class_name(hwnd);
    let frame_pid = window_pid(hwnd);
    let pid = if class == "ApplicationFrameWindow" { hosted_app_pid(hwnd, frame_pid).unwrap_or(frame_pid) } else { frame_pid };
    let (app, elevated) = cache
        .entry(pid)
        .or_insert_with(|| {
            let facts = process_facts(pid);
            let file = facts.exe.as_deref().map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()).unwrap_or_default();
            let stem = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(&file).to_string();
            let identity = AppIdentity { key: file.to_lowercase(), name: facts.description.unwrap_or(stem), exe: facts.exe, bundle_id: None };
            (identity, facts.elevated)
        })
        .clone();
    let app_key = app.key.clone();
    WindowInfo {
        id: window_id(hwnd),
        pid,
        app,
        title: window_text(hwnd),
        rect: window_rect(hwnd),
        minimized: IsIconic(hwnd) != 0,
        elevated,
        is_self: pid == own_pid || frame_pid == own_pid || (app_key == WEBVIEW_HOST && is_own_webview(pid, own_pid)),
        launcher: is_run_dialog(hwnd, &class),
        capture_excluded: frame_pid == own_pid && excluded_from_capture(hwnd),
        class_name: Some(class),
    }
}

/// `WDA_EXCLUDEFROMCAPTURE`: the window is left out of every capture and what
/// lies behind it is shown. Windows 10 2004 and later; an older system
/// refuses the value when the window asks for it, and the window then reads
/// as an ordinary or a blanked one here.
const EXCLUDED_FROM_CAPTURE: u32 = 0x11;

/// Does the system keep this window of LU out of screen captures? Only a
/// window of the own process can be asked.
unsafe fn excluded_from_capture(hwnd: HWND) -> bool {
    let mut affinity = 0u32;
    GetWindowDisplayAffinity(hwnd, &mut affinity) != 0 && affinity == EXCLUDED_FROM_CAPTURE
}

unsafe fn list_windows(own_pid: u32) -> Vec<WindowInfo> {
    let mut handles: Vec<HWND> = Vec::new();
    // Top level windows from front to back.
    EnumWindows(Some(collect_window), &mut handles as *mut Vec<HWND> as LPARAM);
    let mut cache = HashMap::new();
    let mut windows = Vec::new();
    for hwnd in handles {
        if IsWindowVisible(hwnd) == 0 || is_cloaked(hwnd) {
            continue;
        }
        // Click-through overlays (recorders, GPU tools) cover the screen
        // without being anything a click could land in.
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if style & WS_EX_TRANSPARENT != 0 && style & WS_EX_LAYERED != 0 {
            continue;
        }
        let info = describe(hwnd, own_pid, &mut cache);
        if info.rect.is_empty() && !info.minimized {
            continue;
        }
        windows.push(info);
    }
    windows
}

// ── Pointer ──────────────────────────────────────────────────────────────

unsafe fn cursor() -> PlatformResult<(i32, i32)> {
    let mut point = POINT { x: 0, y: 0 };
    if GetCursorPos(&mut point) == 0 {
        return Err(PlatformError::failed("Windows did not report the pointer position."));
    }
    Ok((point.x, point.y))
}

/// Move the pointer to a physical pixel anywhere on the virtual desktop.
unsafe fn move_pointer(x: i32, y: i32) -> PlatformResult<()> {
    let desk = Rect::new(
        GetSystemMetrics(SM_XVIRTUALSCREEN),
        GetSystemMetrics(SM_YVIRTUALSCREEN),
        GetSystemMetrics(SM_CXVIRTUALSCREEN),
        GetSystemMetrics(SM_CYVIRTUALSCREEN),
    );
    if let Some((nx, ny)) = to_absolute_65535(&desk, x, y) {
        let event = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, time: 0, dwExtraInfo: 0 },
            },
        };
        SendInput(1, &event, std::mem::size_of::<INPUT>() as i32);
    }
    // The 0..65535 range rounds. Where it missed, set the exact pixel.
    match cursor() {
        Ok((cx, cy)) if cx == x && cy == y => Ok(()),
        _ => {
            if SetCursorPos(x, y) == 0 {
                return Err(PlatformError::failed("Windows did not accept the pointer move. A window with administrator rights may be in front."));
            }
            Ok(())
        }
    }
}

/// `VK_NONAME`: a key no keyboard has and no program acts on. Windows still
/// counts it as input, so the process that sent it may change the foreground
/// window. LU used to tap Alt for this, which opens the menu bar in many
/// apps and can swallow the next key. The pattern is from Cua Driver
/// (trycua/cua, MIT licence, `platform-windows/src/input/inject.rs`).
const VK_NONAME: u16 = 0xFC;

unsafe fn tap_no_key() {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_NONAME, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let events = [key(0), key(KEYEVENTF_KEYUP)];
    SendInput(2, events.as_ptr(), std::mem::size_of::<INPUT>() as i32);
}

/// How often LU tries to bring a window to the front, and how long it waits
/// each time for Windows to say the window is there.
const FRONT_ATTEMPTS: usize = 3;
const FRONT_WAIT: Duration = Duration::from_millis(150);

unsafe fn is_in_front(hwnd: HWND) -> bool {
    let end = Instant::now() + FRONT_WAIT;
    loop {
        if GetForegroundWindow() == hwnd {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// Bring a window to the front and make sure it is there.
///
/// Windows lets only the process that owns the input change the foreground
/// window. From any other process `SetForegroundWindow` answers "done" and
/// only makes the taskbar button flash. So this thread joins the input of
/// the thread that has the foreground for the moment of the call, which
/// makes the call count as coming from there. The second try adds a tap of
/// a key that does nothing (`tap_no_key`), which makes LU the process with
/// the last input. Nothing is believed until `GetForegroundWindow` names the
/// window. Both steps follow Cua Driver (trycua/cua, MIT licence).
unsafe fn bring_to_front(hwnd: HWND) -> PlatformResult<()> {
    if IsIconic(hwnd) != 0 {
        ShowWindow(hwnd, SW_RESTORE);
    }
    for attempt in 0..FRONT_ATTEMPTS {
        let front = GetForegroundWindow();
        if front == hwnd {
            return Ok(());
        }
        if attempt > 0 {
            tap_no_key();
        }
        let here = GetCurrentThreadId();
        let there = if front.is_null() { 0 } else { GetWindowThreadProcessId(front, std::ptr::null_mut()) };
        let joined = there != 0 && there != here && AttachThreadInput(here, there, 1) != 0;
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        if joined {
            AttachThreadInput(here, there, 0);
        }
        if is_in_front(hwnd) {
            return Ok(());
        }
    }
    Err(PlatformError::failed("Windows did not let LU bring that window to the front. Click the window once yourself, then try again."))
}

/// LU's own window has the foreground and is about to become the panel,
/// which never takes the keyboard. Hand the foreground to the window right
/// below it: the app the user was in before they typed into LU. Without
/// this the panel stays the active window, and every key LU presses for the
/// task would be for LU itself. Returns whether another window is in front
/// afterwards. `panel` is the handle of LU's main window.
pub fn give_up_foreground(panel: usize) -> bool {
    unsafe {
        let own_pid = GetCurrentProcessId();
        // Only the panel itself: a dialog of LU that is in front stays there.
        if GetForegroundWindow() != panel as HWND {
            return true;
        }
        let mut handles: Vec<HWND> = Vec::new();
        // Top level windows from front to back.
        EnumWindows(Some(collect_window), &mut handles as *mut Vec<HWND> as LPARAM);
        for hwnd in handles {
            if window_pid(hwnd) == own_pid || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || is_cloaked(hwnd) {
                continue;
            }
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOPMOST) != 0 || window_rect(hwnd).is_empty() || window_text(hwnd).is_empty() {
                continue;
            }
            return bring_to_front(hwnd).is_ok();
        }
        false
    }
}

// ── UI Automation ────────────────────────────────────────────────────────

thread_local! {
    static AUTOMATION: RefCell<Option<UIAutomation>> = const { RefCell::new(None) };
}

fn uia_failed() -> PlatformError {
    PlatformError::failed("Windows UI Automation did not answer for this window.")
}

fn with_automation<R>(work: impl FnOnce(&UIAutomation) -> uiautomation::Result<R>) -> PlatformResult<R> {
    AUTOMATION.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(UIAutomation::new().map_err(|_| uia_failed())?);
        }
        work(slot.as_ref().expect("just created")).map_err(|_| uia_failed())
    })
}

fn element_info(automation: &UIAutomation, element: &UIElement) -> ElementInfo {
    let role = element.get_control_type().map(|t| format!("{t:?}")).unwrap_or_default();
    let password = element.is_password().unwrap_or(false);
    let own_name = element.get_name().unwrap_or_default();
    // The text of a button is often a nameless child. Up to three parents
    // are asked for the name that says what the control does, and only when
    // `named_target` needs them.
    let mut walker: Option<UITreeWalker> = None;
    let mut current = element.clone();
    let parents = std::iter::from_fn(move || {
        if walker.is_none() {
            walker = Some(automation.get_control_view_walker().ok()?);
        }
        let parent = walker.as_ref()?.get_parent(&current).ok()?;
        let seen = (parent.get_control_type().map(|t| format!("{t:?}")).unwrap_or_default(), parent.get_name().unwrap_or_default());
        current = parent;
        Some(seen)
    })
    .take(3);
    let (role, name) = named_target(role, own_name, parents);
    ElementInfo { role, name, password }
}

/// The longest value of a field that is read for the list.
const MAX_VALUE_CHARS: usize = 80;

fn raw_node(element: &UIElement, depth: u32) -> RawNode {
    let rect = element.get_cached_bounding_rectangle().map(|r| Rect::new(r.get_left(), r.get_top(), r.get_width(), r.get_height())).unwrap_or_default();
    let role = element.get_cached_control_type().map(|t| format!("{t:?}")).unwrap_or_default();
    let password = element.is_cached_password().unwrap_or(false);
    // Asked by role: for an element without the pattern the system answers
    // with the default, and every button would read as "unchecked".
    let kind = role.to_lowercase();
    let state = if matches!(kind.as_str(), "checkbox" | "togglebutton") {
        let toggled: Option<i32> = element.get_cached_property_value(UIProperty::ToggleToggleState).ok().and_then(|v| v.try_into().ok());
        toggled.map(|t| if t == 1 { "checked" } else { "unchecked" }.to_string())
    } else if matches!(kind.as_str(), "radiobutton" | "listitem" | "tabitem" | "treeitem") {
        let selected: Option<bool> = element.get_cached_property_value(UIProperty::SelectionItemIsSelected).ok().and_then(|v| v.try_into().ok());
        selected.filter(|s| *s).map(|_| "selected".to_string())
    } else {
        None
    };
    let value = if !password && matches!(kind.as_str(), "edit" | "combobox" | "spinner") {
        let text: Option<String> = element.get_cached_property_value(UIProperty::ValueValue).ok().and_then(|v| v.try_into().ok());
        text.map(|t| t.chars().take(MAX_VALUE_CHARS).collect::<String>()).filter(|t| !t.trim().is_empty())
    } else {
        None
    };
    RawNode {
        depth,
        role,
        name: element.get_cached_name().unwrap_or_default(),
        rect,
        enabled: element.is_cached_enabled().unwrap_or(false),
        offscreen: element.is_cached_offscreen().unwrap_or(false),
        focused: element.has_cached_keyboard_focus().unwrap_or(false),
        password,
        state,
        value,
    }
}

struct TreeWalk<'a> {
    walker: &'a UITreeWalker,
    cache: &'a uiautomation::core::UICacheRequest,
    budget: usize,
    deadline: Instant,
    out: Vec<RawNode>,
}

impl TreeWalk<'_> {
    fn full(&self) -> bool {
        self.out.len() >= self.budget || Instant::now() >= self.deadline
    }

    /// Pre-order. Children of an element that is off screen and has no size
    /// are skipped: that is how virtual lists park thousands of rows.
    fn visit(&mut self, element: &UIElement, depth: u32) {
        if self.full() {
            return;
        }
        let node = raw_node(element, depth);
        let skip_children = node.offscreen && node.rect.is_empty();
        self.out.push(node);
        if skip_children || depth >= TREE_MAX_DEPTH {
            return;
        }
        let mut child = self.walker.get_first_child_build_cache(element, self.cache).ok();
        while let Some(current) = child {
            if self.full() {
                return;
            }
            self.visit(&current, depth + 1);
            child = self.walker.get_next_sibling_build_cache(&current, self.cache).ok();
        }
    }
}

fn read_tree(hwnd_id: u64, budget: usize) -> PlatformResult<Vec<RawNode>> {
    with_automation(|automation| {
        let cache = automation.create_cache_request()?;
        for property in [
            UIProperty::Name,
            UIProperty::ControlType,
            UIProperty::BoundingRectangle,
            UIProperty::IsEnabled,
            UIProperty::IsOffscreen,
            UIProperty::HasKeyboardFocus,
            UIProperty::IsPassword,
            UIProperty::ToggleToggleState,
            UIProperty::SelectionItemIsSelected,
            UIProperty::ValueValue,
        ] {
            cache.add_property(property)?;
        }
        cache.set_tree_scope(TreeScope::Element)?;
        let root = automation.element_from_handle_build_cache(Handle::from(hwnd_id as usize as isize), &cache)?;
        let walker = automation.get_control_view_walker()?;
        let mut walk = TreeWalk { walker: &walker, cache: &cache, budget, deadline: Instant::now() + TREE_DEADLINE, out: Vec::new() };
        walk.visit(&root, 0);
        Ok(walk.out)
    })
}

// ── Adapter ──────────────────────────────────────────────────────────────

fn xcap_failed() -> PlatformError {
    PlatformError::failed("Windows did not hand out the screen. A secure system screen may be showing.")
}

fn list_monitors() -> PlatformResult<Vec<MonitorInfo>> {
    let monitors = xcap::Monitor::all().map_err(|_| xcap_failed())?;
    let mut out = Vec::new();
    for monitor in monitors {
        // DEVMODE values: physical pixels, whatever the DPI awareness.
        let (Ok(id), Ok(x), Ok(y), Ok(width), Ok(height)) = (monitor.id(), monitor.x(), monitor.y(), monitor.width(), monitor.height()) else {
            continue;
        };
        out.push(MonitorInfo {
            id,
            name: monitor.friendly_name().or_else(|_| monitor.name()).unwrap_or_default(),
            rect: Rect::new(x, y, width as i32, height as i32),
            pixel_width: width,
            pixel_height: height,
            scale_factor: monitor.scale_factor().unwrap_or(1.0),
            primary: monitor.is_primary().unwrap_or(false),
        });
    }
    if virtual_desktop(&out.iter().map(|m| m.rect).collect::<Vec<_>>()).is_none() {
        return Err(xcap_failed());
    }
    Ok(out)
}

impl Desktop for WindowsDesktop {
    fn platform(&self) -> Platform {
        Platform::Windows
    }

    fn input_ready(&self) -> PlatformResult<()> {
        self.run(input::ready)
    }

    fn monitors(&self) -> PlatformResult<Vec<MonitorInfo>> {
        self.run(list_monitors)
    }

    fn capture(&self, monitor_id: u32) -> PlatformResult<RgbaImage> {
        self.run(move || {
            let monitor = xcap::Monitor::all()
                .map_err(|_| xcap_failed())?
                .into_iter()
                .find(|m| m.id().ok() == Some(monitor_id))
                .ok_or_else(|| PlatformError::failed("That display is not connected any more."))?;
            monitor.capture_image().map_err(|_| xcap_failed())
        })
    }

    fn cursor(&self) -> PlatformResult<(i32, i32)> {
        self.run(|| unsafe { cursor() })
    }

    fn user_key_presses(&self) -> Option<u64> {
        user_keys::pressed()
    }

    fn windows(&self) -> PlatformResult<Vec<WindowInfo>> {
        let own_pid = self.own_pid;
        self.run(move || Ok(unsafe { list_windows(own_pid) }))
    }

    fn foreground(&self) -> PlatformResult<Option<WindowInfo>> {
        let own_pid = self.own_pid;
        self.run(move || unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                // No foreground window: a secure desktop (UAC, lock screen)
                // or the moment between two windows.
                return Ok(None);
            }
            Ok(Some(describe(hwnd, own_pid, &mut HashMap::new())))
        })
    }

    fn window_at(&self, x: i32, y: i32) -> PlatformResult<Option<WindowInfo>> {
        let own_pid = self.own_pid;
        self.run(move || unsafe {
            // The real hit test of Windows, including shaped and layered windows.
            let hit = WindowFromPoint(POINT { x, y });
            if hit.is_null() {
                return Ok(None);
            }
            let root = GetAncestor(hit, GA_ROOT);
            let hwnd = if root.is_null() { hit } else { root };
            Ok(Some(describe(hwnd, own_pid, &mut HashMap::new())))
        })
    }

    fn focus_window(&self, window: &WindowInfo) -> PlatformResult<()> {
        let id = window.id;
        self.run(move || unsafe { bring_to_front(hwnd_of(id)) })
    }

    fn place_window(&self, window: &WindowInfo, rect: Rect) -> PlatformResult<()> {
        let id = window.id;
        self.run(move || unsafe {
            let hwnd = hwnd_of(id);
            // A maximised or minimised window has no place of its own.
            if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetWindowPos(hwnd, std::ptr::null_mut(), rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE) == 0 {
                return Err(PlatformError::failed("Windows did not let LU move that window."));
            }
            Ok(())
        })
    }

    fn input(&self, op: &InputOp) -> PlatformResult<()> {
        let op = op.clone();
        self.run(move || match op {
            InputOp::Move { x, y } => unsafe { move_pointer(x, y) },
            other => input::with_enigo(|enigo| input::apply(enigo, &other)),
        })
    }

    fn release_all(&self) {
        let _ = self.run(|| input::with_enigo(|enigo| {
            input::release_all(enigo);
            Ok(())
        }));
    }

    fn tree_available(&self) -> bool {
        true
    }

    fn tree(&self, window: &WindowInfo, budget: usize) -> PlatformResult<Vec<RawNode>> {
        let id = window.id;
        self.run(move || read_tree(id, budget))
    }

    fn element_at(&self, x: i32, y: i32) -> PlatformResult<Option<ElementInfo>> {
        // A window that does not answer leaves the target unknown, and an
        // unknown target is confirmed by the user.
        Ok(self.run(move || with_automation(|automation| {
            let element = automation.element_from_point(Point::new(x, y))?;
            Ok(element_info(automation, &element))
        })).ok())
    }

    fn focused_element(&self) -> PlatformResult<Option<ElementInfo>> {
        // A failed query is an error, not "no focus": the engine must not
        // read "could not ask" as "not a password field".
        self.run(|| with_automation(|automation| {
            let element = automation.get_focused_element()?;
            Ok(Some(element_info(automation, &element)))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The title of a window of LU itself is read while the thread that owns
    /// the window is busy. With a message to that thread the read would wait
    /// for as long as the owner does, and the owner may be waiting for the
    /// read (the pause from the interface while LU's own field is in front).
    #[test]
    fn the_title_of_an_own_window_is_read_while_its_thread_is_busy() {
        let (window_tx, window_rx) = mpsc::channel::<usize>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let owner = std::thread::spawn(move || unsafe {
            let hwnd = CreateWindowExW(0, wide("STATIC").as_ptr(), wide("LU own window").as_ptr(), 0, 0, 0, 10, 10, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
            window_tx.send(hwnd as usize).unwrap();
            // Busy: this thread handles no message until it is released.
            let _ = release_rx.recv();
            if !hwnd.is_null() {
                DestroyWindow(hwnd);
            }
        });
        let hwnd = window_rx.recv().unwrap() as HWND;
        assert!(!hwnd.is_null(), "the test window was not created");
        let (title_tx, title_rx) = mpsc::channel::<String>();
        let target = hwnd as usize;
        std::thread::spawn(move || {
            let _ = title_tx.send(unsafe { window_text(target as HWND) });
        });
        let title = title_rx.recv_timeout(Duration::from_secs(3));
        let _ = release_tx.send(());
        let _ = owner.join();
        assert_eq!(title.expect("reading the title waited for the busy thread"), "LU own window");
    }
}
