//! Astra computer use: the Tauri commands.
//!
//! The rules live in `desk` and know nothing about Tauri. This file owns the
//! one engine of the process, hands the commands to the blocking pool, and
//! wires the ways a stop or a pause reaches the engine from outside the
//! interface: the two global shortcuts and the app quitting. `surface` is
//! what the user sees of LU meanwhile: the panel and the glow.
//!
//! A refusal (blocked app, missing approval, stale screenshot, stopped) is a
//! normal answer, not an error: every command returns `{ ok: false, refusal }`
//! for it, so the interface can act on the code. Only a broken call rejects.

pub mod desk;
pub mod surface;

use desk::engine::{ActionRequest, BeginOptions, Engine, GrantScope, ScreenOptions, StopReason};
use desk::keys::parse_chord;
use desk::platform::{self, MainThread};
use desk::types::{code, Outcome, Permission, Refusal};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::state::AppState;

/// The stop shortcut, as the plugin parses it and as the engine refuses it.
const STOP_SHORTCUT: &str = "ctrl+alt+escape";
/// Emitted to the interface when a session is stopped from outside it.
pub const STOPPED_EVENT: &str = "computer://stopped";
/// "Pause and open": holds the session and brings up the question, without
/// the user touching the mouse LU is working with.
const PAUSE_SHORTCUT: &str = "ctrl+alt+space";
/// Emitted to the interface when the session pauses: the user moved the
/// mouse, pressed a key, or pressed the pause shortcut.
pub const PAUSED_EVENT: &str = "computer://paused";

fn pause_shortcut_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Control+Option+Space"
    } else {
        "Ctrl+Alt+Space"
    }
}

fn stop_shortcut_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Control+Option+Esc"
    } else {
        "Ctrl+Alt+Esc"
    }
}

/// The engine of this process, created on first use because it needs the app
/// handle, and the state of the stop shortcut.
#[derive(Clone, Default)]
pub struct ComputerHandle {
    engine: Arc<OnceLock<Arc<Engine>>>,
    shortcut_registered: Arc<Mutex<bool>>,
    pause_registered: Arc<Mutex<bool>>,
    surface: surface::Surface,
}

impl ComputerHandle {
    fn engine(&self, app: &AppHandle) -> Arc<Engine> {
        self.engine
            .get_or_init(|| {
                let main_app = app.clone();
                let main: MainThread = Arc::new(move |job| main_app.run_on_main_thread(job).is_ok());
                let engine = Arc::new(Engine::new(platform::native(std::process::id(), main)));
                engine.set_stop_chord(parse_chord(STOP_SHORTCUT).ok());
                engine.set_pause_chord(parse_chord(PAUSE_SHORTCUT).ok());
                let events = app.clone();
                engine.set_stop_observer(Box::new(move |reason| {
                    let _ = events.emit(STOPPED_EVENT, json!({ "reason": reason, "message": reason.sentence() }));
                }));
                let events = app.clone();
                engine.set_pause_observer(Box::new(move || {
                    let _ = events.emit(PAUSED_EVENT, json!({}));
                }));
                engine
            })
            .clone()
    }

    /// Stop whatever runs. Called when the app quits.
    pub fn shutdown(&self) {
        if let Some(engine) = self.engine.get() {
            engine.stop(StopReason::User);
        }
    }

    /// The shortcut is only held while a session exists, so LU does not take
    /// a key combination from every other app for good.
    fn register_shortcut(&self, app: &AppHandle, engine: &Arc<Engine>) -> bool {
        let mut registered = self.shortcut_registered.lock().unwrap_or_else(|p| p.into_inner());
        if *registered {
            return true;
        }
        let engine = engine.clone();
        let result = app.global_shortcut().on_shortcut(STOP_SHORTCUT, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                engine.stop(StopReason::Hotkey);
            }
        });
        *registered = result.is_ok();
        *registered
    }

    /// Held for exactly as long as the stop shortcut, and for the same reason.
    fn register_pause_shortcut(&self, app: &AppHandle, engine: &Arc<Engine>) -> bool {
        let mut registered = self.pause_registered.lock().unwrap_or_else(|p| p.into_inner());
        if *registered {
            return true;
        }
        let engine = engine.clone();
        let result = app.global_shortcut().on_shortcut(PAUSE_SHORTCUT, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                engine.pause();
            }
        });
        *registered = result.is_ok();
        *registered
    }

    fn unregister_shortcut(&self, app: &AppHandle) {
        let mut registered = self.shortcut_registered.lock().unwrap_or_else(|p| p.into_inner());
        if *registered {
            let _ = app.global_shortcut().unregister(STOP_SHORTCUT);
            *registered = false;
        }
        let mut registered = self.pause_registered.lock().unwrap_or_else(|p| p.into_inner());
        if *registered {
            let _ = app.global_shortcut().unregister(PAUSE_SHORTCUT);
            *registered = false;
        }
    }

    fn shortcut_label(&self) -> Option<&'static str> {
        (*self.shortcut_registered.lock().unwrap_or_else(|p| p.into_inner())).then(stop_shortcut_label)
    }
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The computer control task ended unexpectedly. Try again.".to_string())
}

fn answer<T: Serialize>(outcome: Outcome<T>) -> Value {
    match outcome {
        Ok(value) => {
            let mut body = serde_json::to_value(value).unwrap_or(Value::Null);
            if !body.is_object() {
                body = json!({ "value": body });
            }
            body["ok"] = Value::Bool(true);
            body
        }
        Err(refusal) => refused(&refusal),
    }
}

fn refused(refusal: &Refusal) -> Value {
    json!({ "ok": false, "refusal": refusal })
}

/// The model is told this when the panel was over the spot it aimed at and
/// has moved. The interface adds the new look.
const PANEL_MOVED: &str = "LU's own panel was over that spot, so this step did not run. The panel has moved to another corner and the spot is free now.";
/// And this when a window of LU was there in the screenshot and is not now.
const PANEL_WAS_THERE: &str = "A window of LU itself was over that spot in the last screenshot, so this step did not run. It is not there any more.";

/// An action aimed at a spot under a window of LU itself, and `room` is what
/// became of that spot. With the spot free, the refusal turns into "look
/// again": the code the interface takes a new screenshot for, and the corner
/// the panel is in now. With LU still over it, the refusal stands as it is.
fn room_answer(refusal: Refusal, there_now: bool, room: surface::Room) -> (Refusal, Option<surface::Corner>) {
    match room {
        surface::Room::Made(corner) => (Refusal::new(code::COVERED, PANEL_MOVED), Some(corner)),
        surface::Room::Free if !there_now => (Refusal::new(code::COVERED, PANEL_WAS_THERE), None),
        surface::Room::Free | surface::Room::Stuck => (refusal, None),
    }
}

/// What this machine can do, without starting anything.
#[tauri::command]
pub async fn computer_status(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let handle = state.computer.clone();
    let engine = handle.engine(&app);
    blocking(move || {
        let input = engine.desktop().input_ready();
        let tree = engine.desktop().tree_available();
        json!({
            "ok": true,
            "platform": std::env::consts::OS,
            "inputAvailable": input.is_ok(),
            "inputError": input.err().map(|e| e.message),
            "treeAvailable": tree,
            "autonomyAvailable": tree,
            "stopShortcut": stop_shortcut_label(),
            "stopShortcutActive": handle.shortcut_label().is_some(),
            "pauseShortcut": pause_shortcut_label(),
            "shrinks": surface::shrinks(),
            "glows": surface::glows(),
            "session": engine.session(),
        })
    })
    .await
}

/// What the operating system has granted computer control. macOS asks for
/// two permissions; the other systems need none and report both as granted.
#[tauri::command]
pub async fn computer_permissions() -> Result<Value, String> {
    blocking(|| json!({ "ok": true, "permissions": platform::permissions() })).await
}

/// Ask the operating system for one permission and open the place where the
/// user grants it. Answers with what is granted right after the request; the
/// interface keeps asking `computer_permissions` until the user is done.
#[tauri::command]
pub async fn computer_permission_request(app: AppHandle, permission: Permission) -> Result<Value, String> {
    // macOS wants its permission prompts to come from the main thread.
    let _ = app.run_on_main_thread(move || platform::request_permission(permission));
    blocking(|| json!({ "ok": true, "permissions": platform::permissions() })).await
}

/// Drop what the operating system stored about LU for one permission, then
/// ask for it again. For the entry of an older build that still stands in
/// the list of System Settings and no longer counts.
#[tauri::command]
pub async fn computer_permission_reset(app: AppHandle, permission: Permission) -> Result<Value, String> {
    let app_id = app.config().identifier.clone();
    if let Err(error) = blocking(move || platform::forget_permission(permission, &app_id)).await? {
        return Ok(refused(&error.into()));
    }
    let _ = app.run_on_main_thread(move || platform::request_permission(permission));
    blocking(|| json!({ "ok": true, "permissions": platform::permissions() })).await
}

#[tauri::command]
pub async fn computer_session_begin(app: AppHandle, state: State<'_, AppState>, options: Option<BeginOptions>) -> Result<Value, String> {
    let handle = state.computer.clone();
    let engine = handle.engine(&app);
    let shortcut_app = app.clone();
    blocking(move || {
        let id = uuid::Uuid::new_v4().to_string();
        match engine.begin(id, options.unwrap_or_default()) {
            Ok(session) => {
                let shortcut = handle.register_shortcut(&shortcut_app, &engine).then(stop_shortcut_label);
                let pause = handle.register_pause_shortcut(&shortcut_app, &engine).then(pause_shortcut_label);
                json!({ "ok": true, "session": session, "stopShortcut": shortcut, "pauseShortcut": pause })
            }
            Err(refusal) => refused(&refusal),
        }
    })
    .await
}

/// Open the question "may computer control work in this chat". `allowed` is
/// true when the user already said yes there since the app started.
#[tauri::command]
pub async fn computer_chat_ask(app: AppHandle, state: State<'_, AppState>, chat_id: String) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.chat_ask(&chat_id).map(|allowed| json!({ "allowed": allowed })))).await
}

/// The user's click on Allow or Deny in the card of that question. Nothing
/// else calls this: not a setting, not the model, not the result of a tool.
#[tauri::command]
pub async fn computer_chat_answer(app: AppHandle, state: State<'_, AppState>, chat_id: String, allow: bool) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.chat_answer(&chat_id, allow).map(|allowed| json!({ "allowed": allowed })))).await
}

/// Approve one app. `scope` is "once" or "session"; "always" is the
/// interface's business and arrives here as "session".
#[tauri::command]
pub async fn computer_session_allow_app(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    app_key: String,
    scope: GrantScope,
) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.allow_app(&session_id, &app_key, scope).map(|session| json!({ "session": session })))).await
}

#[tauri::command]
pub async fn computer_session_revoke_app(app: AppHandle, state: State<'_, AppState>, session_id: String, app_key: String) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.revoke_app(&session_id, &app_key).map(|session| json!({ "session": session })))).await
}

/// The Autonomous switch, for the session that is running. The session is
/// not ended and begun again: that would put the window back for a moment
/// and drop the latest look. Only the user's click on the switch calls this.
#[tauri::command]
pub async fn computer_session_set_autonomous(app: AppHandle, state: State<'_, AppState>, session_id: String, autonomous: bool) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.set_autonomous(&session_id, autonomous).map(|session| json!({ "session": session })))).await
}

#[tauri::command]
pub async fn computer_session_end(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    let handle = state.computer.clone();
    let engine = handle.engine(&app);
    let ended = engine.end(&session_id);
    if engine.session().is_none() {
        handle.unregister_shortcut(&app);
        handle.surface.release(&app);
    }
    Ok(json!({ "ok": true, "ended": ended }))
}

/// The emergency stop. Never waits for a running action.
#[tauri::command]
pub fn computer_stop(app: AppHandle, state: State<'_, AppState>) -> Value {
    let engine = state.computer.engine(&app);
    engine.stop(StopReason::User);
    json!({ "ok": true, "session": engine.session() })
}

/// Pause for the user: the same hold as the pause shortcut, asked for from
/// the interface (a voice session, where the user said "stop" or "wait").
/// Pausing only ever holds, so it needs no gate: the way out stays the
/// user's answer in the paused view. Without a session, or after a stop,
/// nothing is paused and the caller is told.
#[tauri::command]
pub async fn computer_pause(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    // Off the main thread: the pause asks the desktop which window is in
    // front, and the main thread must stay free to answer for LU's own.
    blocking(move || json!({ "ok": true, "paused": engine.pause() })).await
}

/// The user's answer to the pause: let LU continue, or take over. Called for
/// the user's click in the paused view and for nothing else. No tool reaches
/// this command, so nothing a model writes can lift a pause.
#[tauri::command]
pub async fn computer_takeover_answer(app: AppHandle, state: State<'_, AppState>, r#continue: bool) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || {
        if r#continue {
            engine.resume();
        } else {
            engine.stop(StopReason::Takeover);
        }
        json!({ "ok": true, "paused": engine.paused(), "session": engine.session() })
    })
    .await
}

/// Has the user reached for the mouse or the keyboard? Asked by the
/// interface a few times a second while an autonomous session is busy, so
/// the question comes up when the hand moves and not at the next action.
#[tauri::command]
pub async fn computer_watch(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || json!({ "ok": true, "paused": engine.watch() })).await
}

/// What LU shows of itself while it works on the screen: the panel, the
/// paused view, or the ordinary window. Sent again every few
/// seconds while computer control is busy; see `surface`.
#[tauri::command]
pub async fn computer_surface(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: surface::Mode,
    active: bool,
    focus: Option<bool>,
    monitor_id: Option<u32>,
    still: Option<bool>,
) -> Result<Value, String> {
    let handle = state.computer.clone();
    let engine = handle.engine(&app);
    blocking(move || {
        let origin = monitor_id.and_then(|id| engine.desktop().monitors().ok()?.into_iter().find(|m| m.id == id)).map(|m| (m.rect.x, m.rect.y));
        let applied = handle.surface.apply(&app, mode, active, focus.unwrap_or(false), origin, still.unwrap_or(false));
        let mut body = serde_json::to_value(applied).unwrap_or(Value::Null);
        body["ok"] = Value::Bool(true);
        body
    })
    .await
}

/// The grip of the panel: the user sends it to a corner, or with no corner
/// named to the next one around the display. Only the user's hand on the
/// grip calls this. No tool reaches it: the model gets the panel out of its
/// way by aiming at what is under it (see `computer_action`).
#[tauri::command]
pub async fn computer_surface_corner(app: AppHandle, state: State<'_, AppState>, corner: Option<surface::Corner>) -> Result<Value, String> {
    let handle = state.computer.clone();
    blocking(move || {
        let applied = handle.surface.place(&app, corner);
        let mut body = serde_json::to_value(applied).unwrap_or(Value::Null);
        body["ok"] = Value::Bool(true);
        body
    })
    .await
}

/// Bring LU's window to the front, because a question for the user is
/// waiting in it and the user is looking at another app. Not while LU is
/// the panel: that is on top already and takes no focus.
///
/// Never a synchronous command. Those run on the main thread, and this one
/// reads the surface, whose lock another thread holds while it waits for an
/// answer from the main thread (the size of a display, the place of the
/// window). On Windows that stopped the whole window the moment the first
/// question came up (08.10.2026).
#[tauri::command]
pub async fn computer_request_attention(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    use tauri::Manager;
    let handle = state.computer.clone();
    blocking(move || {
        if handle.surface.mode() != surface::Mode::Window {
            return json!({ "ok": true });
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        json!({ "ok": true })
    })
    .await
}

#[tauri::command]
pub async fn computer_guard(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.guard())).await
}

#[tauri::command]
pub async fn computer_windows(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.windows())).await
}

#[tauri::command]
pub async fn computer_screen(app: AppHandle, state: State<'_, AppState>, session_id: String, options: Option<ScreenOptions>) -> Result<Value, String> {
    use base64::Engine as _;
    let handle = state.computer.clone();
    let engine = handle.engine(&app);
    handle.surface.touch(&app);
    blocking(move || {
        panel_first(&handle, &app);
        engine.screen(&session_id, options.unwrap_or_default())
    })
    .await
    .map(|result| match result {
        Ok(report) => {
            let image = report.image.as_deref().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
            let mut body = serde_json::to_value(&report).unwrap_or(Value::Null);
            body["ok"] = Value::Bool(true);
            body["image"] = image.map(Value::String).unwrap_or(Value::Null);
            body
        }
        Err(refusal) => refused(&refusal),
    })
}

/// The first look of a task is taken while LU is still the large window the
/// user typed into: the interface asks for the panel a moment later. That
/// picture was almost all black (box, 08.10.2026). So the window becomes the
/// panel here, before anything is captured. The interface asks for the same
/// shape right after and keeps it up from then on.
fn panel_first(handle: &ComputerHandle, app: &AppHandle) {
    if surface::shrinks() && handle.surface.mode() == surface::Mode::Window {
        handle.surface.apply(app, surface::Mode::Panel, true, false, None, false);
    }
}

#[tauri::command]
pub async fn computer_action(app: AppHandle, state: State<'_, AppState>, session_id: String, request: ActionRequest) -> Result<Value, String> {
    let handle = state.computer.clone();
    let engine = handle.engine(&app);
    // No action without the glow: it is up before the first event fires.
    handle.surface.touch(&app);
    blocking(move || {
        panel_first(&handle, &app);
        match engine.action(&session_id, request.clone()) {
        // The engine has let go of its lock here, and this is not the main
        // thread: the panel can be moved and waited for.
        Err(mut refusal) => match refusal.own_window.take() {
            Some(own) => {
                let room = handle.surface.make_room(&app, &own.aims);
                // The panel is not in the model's pictures: it chose the spot
                // from what is really there. The panel is out of the way now,
                // so the same step runs, and the model is told nothing.
                if !own.in_picture && room != surface::Room::Stuck {
                    match engine.action(&session_id, request) {
                        Err(again) if again.own_window.is_some() => {}
                        Err(other) => return refused(&other),
                        done => return answer(done),
                    }
                }
                let (refusal, corner) = room_answer(refusal, own.there_now, room);
                let mut body = refused(&refusal);
                if let Some(corner) = corner {
                    body["refusal"]["corner"] = serde_json::to_value(corner).unwrap_or(Value::Null);
                }
                body
            }
            None => refused(&refusal),
        },
        done => answer(done),
        }
    })
    .await
}

#[tauri::command]
pub async fn computer_tree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    max_depth: Option<u32>,
    max_nodes: Option<usize>,
) -> Result<Value, String> {
    let engine = state.computer.engine(&app);
    blocking(move || answer(engine.tree(&session_id, max_depth, max_nodes))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use desk::types::AppIdentity;

    #[test]
    fn a_refusal_is_an_answer_with_a_code() {
        let app = AppIdentity { key: "notepad.exe".into(), name: "Notepad".into(), exe: None, bundle_id: None };
        let outcome: Outcome<Value> = Err(Refusal::new(code::NEEDS_APPROVAL, "Ask first.").with_app(&app));
        let body = answer(outcome);
        assert_eq!(body["ok"], false);
        assert_eq!(body["refusal"]["code"], "needs_approval");
        assert_eq!(body["refusal"]["app"]["key"], "notepad.exe");
        assert!(body["refusal"].get("sensitive").is_none());
    }

    #[test]
    fn a_success_carries_ok_next_to_its_fields() {
        let body = answer(Ok(json!({ "performed": "Clicked." })));
        assert_eq!(body, json!({ "ok": true, "performed": "Clicked." }));
    }

    /// A command without `async` runs on the main thread. The surface keeps
    /// its lock while it asks the window system something, and that answer
    /// comes from the main thread. A synchronous command that reaches for the
    /// surface therefore stops the window for good.
    #[test]
    fn no_command_on_the_main_thread_reaches_for_the_surface() {
        let marker = concat!("#[tauri", "::command]");
        let source = include_str!("computer.rs");
        let commands: Vec<&str> = source.split(marker).skip(1).collect();
        assert!(commands.len() >= 15, "the commands of this file were not found");
        let mut checked = 0;
        for command in commands {
            let end = command.find("\n}\n").unwrap_or(command.len());
            let body = &command[..end];
            let signature = body.lines().find(|line| line.trim_start().starts_with("pub ")).unwrap_or("");
            if body.contains(".surface.") || body.contains("surface::Surface") || body.contains("engine.pause()") {
                checked += 1;
                assert!(signature.trim_start().starts_with("pub async fn "), "this command reaches for the surface on the main thread: {signature}");
            }
        }
        assert!(checked >= 5, "expected the surface commands and the pause, found {checked}");
    }

    #[test]
    fn a_spot_under_the_panel_becomes_look_again_once_the_panel_has_moved() {
        let own = || Refusal::new(code::BLOCKED, "LU does not control its own window.");
        // The panel was there and moved: the model looks again, and the interface learns the corner.
        let (refusal, corner) = room_answer(own(), true, surface::Room::Made(surface::Corner::BottomRight));
        assert_eq!((refusal.code, corner), (code::COVERED, Some(surface::Corner::BottomRight)));
        assert!(refusal.message.contains("did not run") && refusal.message.contains("moved"));
        // It was there in the screenshot only (the user sent it elsewhere since): look again too.
        let (refusal, corner) = room_answer(own(), false, surface::Room::Free);
        assert_eq!((refusal.code, corner), (code::COVERED, None));
        // LU's ordinary window, or a panel with nowhere to go: off limits, as ever.
        for room in [surface::Room::Free, surface::Room::Stuck] {
            let (refusal, corner) = room_answer(own(), true, room);
            assert_eq!((refusal.code, corner), (code::BLOCKED, None));
        }
        assert_eq!(room_answer(own(), false, surface::Room::Stuck).0.code, code::BLOCKED);
    }

    #[test]
    fn the_model_has_no_command_that_moves_the_panel() {
        // The corner command is the grip's. Everything a tool can reach goes
        // through the engine, and the engine knows no such action.
        let source = include_str!("computer/desk/engine.rs");
        let actions = source.split("pub enum Action {").nth(1).and_then(|rest| rest.split("\n}").next()).expect("the actions of the engine");
        assert!(!actions.to_lowercase().contains("panel") && !actions.to_lowercase().contains("corner"));
    }

    #[test]
    fn the_stop_shortcut_parses_and_has_a_label() {
        let chord = parse_chord(STOP_SHORTCUT).expect("the stop shortcut is a valid chord");
        assert_eq!(chord.modifiers.len(), 2);
        assert!(stop_shortcut_label().ends_with("Esc"));
    }

    #[test]
    fn the_pause_shortcut_parses_and_is_not_the_stop_shortcut() {
        let pause = parse_chord(PAUSE_SHORTCUT).expect("the pause shortcut is a valid chord");
        let stop = parse_chord(STOP_SHORTCUT).unwrap();
        assert!(!stop.is(&pause.modifiers, pause.key));
        assert!(pause_shortcut_label().ends_with("Space"));
    }
}
