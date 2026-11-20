//! The running voice loop: start it, know when it is ready, notice when it
//! dies, and end it without leaving a process behind.
//!
//! The sidecar speaks one JSON object per stdout line (`listening` with its
//! port, `ready`, `fatal`). This side keeps the write end of its stdin open
//! and never writes to it: closing it is the graceful stop on every system,
//! and it closes by itself when the app dies, so the sidecar cannot outlive
//! the app even after a hard kill.
//!
//! The launch token is created here, handed to the child in its environment
//! and returned to the one caller that started it. It is never logged and is
//! not part of any status or Debug output.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rand::RngCore;
use serde::Serialize;

use crate::os_error;

const TOKEN_ENV: &str = "LU_VOICE_TOKEN";
const ORIGINS_ENV: &str = "LU_VOICE_ALLOWED_ORIGINS";

/// The webview origins the sidecar accepts when no list is passed. Mirrors
/// `DEFAULT_ORIGINS` in `lu_voice_loop/auth.py`; a test holds the two together.
pub const DEFAULT_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// A cold start loads torch and three models from disk. Over 20 seconds on a
/// fast machine, far more with a slow drive or a virus scanner reading every
/// file for the first time.
pub const READY_TIMEOUT: Duration = Duration::from_secs(180);

/// How long a stop waits for the sidecar to leave by itself. It gives itself
/// eight seconds to unwind before it ends hard.
pub const STOP_GRACE: Duration = Duration::from_secs(10);

/// The same on the app's quit path, where nothing may wait that long.
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

const LOG_TAIL_LINES: usize = 40;
const LOG_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 32 bytes from the operating system's generator, as 64 hex characters.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── stdout protocol ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    Spawned,
    Listening(u16),
    Ready,
    Fatal { code: String, message: String },
    StopRequested,
    Exited(Option<i32>),
}

/// One stdout line of the sidecar. Anything that is not one of its events is
/// ignored: a library that prints to stdout must not be able to move the state.
pub fn parse_line(line: &str) -> Option<Signal> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    match value.get("event")?.as_str()? {
        "listening" => {
            let port = value.get("port")?.as_u64()?;
            (1..=u64::from(u16::MAX)).contains(&port).then_some(Signal::Listening(port as u16))
        }
        "ready" => Some(Signal::Ready),
        "fatal" => {
            let text = |key: &str, fallback: &str| -> String {
                let raw = value.get(key).and_then(|v| v.as_str()).unwrap_or(fallback);
                os_error::english_child_text(raw).chars().filter(|c| !c.is_control()).take(600).collect()
            };
            Some(Signal::Fatal {
                code: text("code", "fatal"),
                message: text("message", "The voice loop could not start."),
            })
        }
        _ => None,
    }
}

// ── state machine ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopPhase {
    Stopped,
    Starting,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoopFailure {
    pub code: String,
    pub message: String,
}

/// What an exit code means when the sidecar said nothing before it left. The
/// numbers are the sidecar's own (`lu_voice_loop/errors.py`).
pub fn failure_for_exit(code: Option<i32>) -> LoopFailure {
    let (name, message) = match code {
        Some(2) => ("bad_environment", "The voice loop was started with an invalid configuration. Restart LU and try again.".to_string()),
        Some(3) => ("model_missing", "The voice models are missing or incomplete. Run the voice setup again.".to_string()),
        Some(4) => ("port_in_use", "The voice loop could not open its local port. Close the program that uses it or restart the computer.".to_string()),
        Some(5) => ("model_load_failed", "The voice models could not be loaded. Run the voice setup again to repair them.".to_string()),
        // A clean exit nobody here asked for: something else closed it.
        Some(0) => ("crashed", "The voice loop was closed from outside the app. Start it again.".to_string()),
        Some(n) => ("crashed", format!("The voice loop stopped unexpectedly (exit code {n}). Start it again.")),
        None => ("crashed", "The voice loop was ended by the system. Start it again.".to_string()),
    };
    LoopFailure { code: name.to_string(), message }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Machine {
    pub phase: LoopPhase,
    pub port: Option<u16>,
    pub failure: Option<LoopFailure>,
    stop_requested: bool,
}

impl Default for Machine {
    fn default() -> Self {
        Machine { phase: LoopPhase::Stopped, port: None, failure: None, stop_requested: false }
    }
}

impl Machine {
    pub fn apply(&mut self, signal: Signal) {
        match signal {
            Signal::Spawned => {
                *self = Machine { phase: LoopPhase::Starting, ..Machine::default() };
            }
            Signal::Listening(port) => {
                if self.phase == LoopPhase::Starting {
                    self.port = Some(port);
                }
            }
            Signal::Ready => {
                // Ready without a port would hand the app nothing to connect to.
                if self.phase == LoopPhase::Starting && self.port.is_some() {
                    self.phase = LoopPhase::Ready;
                }
            }
            Signal::Fatal { code, message } => {
                if matches!(self.phase, LoopPhase::Starting | LoopPhase::Ready) {
                    self.phase = LoopPhase::Failed;
                    self.failure = Some(LoopFailure { code, message });
                }
            }
            Signal::StopRequested => {
                self.stop_requested = true;
            }
            Signal::Exited(code) => {
                self.port = None;
                if self.stop_requested {
                    // The exit that was asked for is not a failure, whatever
                    // the code: a hard kill after the grace period has one.
                    *self = Machine::default();
                } else {
                    if self.failure.is_none() {
                        self.failure = Some(failure_for_exit(code));
                    }
                    self.phase = LoopPhase::Failed;
                }
            }
        }
    }
}

// ── process ─────────────────────────────────────────────────────────────────

/// Everything needed to start the sidecar. No Tauri type in it.
#[derive(Clone)]
pub struct LaunchSpec {
    pub python: PathBuf,
    pub sidecar_dir: PathBuf,
    pub models_dir: PathBuf,
    /// Origins on top of [`DEFAULT_ORIGINS`], the dev server's for example.
    pub extra_origins: Vec<String>,
    pub log_file: Option<PathBuf>,
    pub ready_timeout: Duration,
}

/// What `start` hands to its caller, and to nobody else.
#[derive(Clone)]
pub struct Session {
    pub port: u16,
    pub token: String,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("port", &self.port).field("token", &"<redacted>").finish()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LoopStatus {
    pub state: LoopPhase,
    pub running: bool,
    pub ready: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub error: Option<LoopFailure>,
    /// The last lines of the sidecar's own log. It is redacted at the source
    /// and carries no audio, transcript, tool data or token.
    pub log_tail: Vec<String>,
}

#[derive(Default)]
struct Runtime {
    machine: Machine,
    /// Counts spawns. A reader thread of an earlier child must not touch the
    /// state of the current one.
    generation: u64,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    token: Option<String>,
    log_tail: VecDeque<String>,
}

#[derive(Default)]
struct Shared {
    runtime: Mutex<Runtime>,
    changed: Condvar,
}

#[derive(Clone, Default)]
pub struct VoiceLoop {
    shared: Arc<Shared>,
}

/// The origin list for the environment, or `None` when the sidecar's own
/// default is right. Setting the variable replaces the default, so the
/// defaults are always passed along with the extra ones.
pub fn origins_env(extra: &[String]) -> Option<String> {
    let extra: Vec<&str> = extra.iter().map(|o| o.trim().trim_end_matches('/')).filter(|o| !o.is_empty()).collect();
    if extra.is_empty() {
        return None;
    }
    let mut all: Vec<&str> = DEFAULT_ORIGINS.to_vec();
    for origin in extra {
        if !all.iter().any(|known| known.eq_ignore_ascii_case(origin)) {
            all.push(origin);
        }
    }
    Some(all.join(","))
}

fn build_command(spec: &LaunchSpec, token: &str) -> std::process::Command {
    // python_command: UTF-8 I/O, no console window on Windows, and no
    // AppImage library paths leaking into a foreign interpreter.
    let mut cmd = crate::python::python_command(&spec.python);
    cmd.current_dir(&spec.sidecar_dir)
        .args(["-m", "lu_voice_loop", "--port", "0", "--models-dir"])
        .arg(&spec.models_dir)
        .env(TOKEN_ENV, token)
        // The sidecar directory is inside the installation and may be
        // read-only. Site-packages were compiled by pip at install time.
        .env("PYTHONDONTWRITEBYTECODE", "1")
        // The interpreter is private. A user's global Python settings must
        // not change what it imports, and the content log is a developer
        // switch that the app never turns on.
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("LU_VOICE_LOG_CONTENT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match origins_env(&spec.extra_origins) {
        Some(list) => cmd.env(ORIGINS_ENV, list),
        None => cmd.env_remove(ORIGINS_ENV),
    };
    cmd
}

/// End a child that did not leave by itself.
fn force_kill(child: &mut Child) {
    // On Windows the venv's python.exe is a launcher that starts the real
    // interpreter as its own child, so the whole tree has to go.
    #[cfg(windows)]
    crate::commands::shell::kill_tree(child.id());
    let _ = child.kill();
}

impl VoiceLoop {
    fn lock(&self) -> MutexGuard<'_, Runtime> {
        self.shared.runtime.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> LoopStatus {
        let rt = self.lock();
        LoopStatus {
            state: rt.machine.phase,
            running: rt.child.is_some(),
            ready: rt.machine.phase == LoopPhase::Ready,
            port: rt.machine.port,
            pid: rt.child.as_ref().map(Child::id),
            error: rt.machine.failure.clone(),
            log_tail: rt.log_tail.iter().cloned().collect(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.lock().child.is_some()
    }

    /// Start the sidecar and wait until it is ready.
    ///
    /// A loop that is already ready answers at once with the same session, a
    /// second caller during a start waits for the first one's result.
    pub fn start(&self, spec: &LaunchSpec) -> Result<Session, String> {
        let deadline = Instant::now() + spec.ready_timeout;
        let generation = {
            let mut rt = self.lock();
            match rt.machine.phase {
                LoopPhase::Ready | LoopPhase::Starting if rt.child.is_some() => rt.generation,
                _ => {
                    // A child that failed but has not left yet (a fatal line
                    // comes before the exit) must be gone before the next one.
                    drop(rt);
                    self.stop(STOP_GRACE);
                    rt = self.lock();
                    if rt.child.is_some() {
                        // Another caller started it in between. Wait for theirs.
                        rt.generation
                    } else {
                        self.spawn(&mut rt, spec)?
                    }
                }
            }
        };
        self.wait_ready(generation, deadline, spec.ready_timeout)
    }

    fn spawn(&self, rt: &mut Runtime, spec: &LaunchSpec) -> Result<u64, String> {
        if !spec.python.is_file() {
            return Err("The voice loop is not installed. Run the voice setup first.".to_string());
        }
        let token = new_token();
        let mut child = build_command(spec, &token).spawn().map_err(|e| {
            format!(
                "The voice loop could not be started: {}. Run the voice setup again to repair it.",
                os_error::io_english(&e)
            )
        })?;
        // Dies with the app even when the app is killed without warning.
        #[cfg(windows)]
        crate::commands::process::assign_pid_to_kill_on_close_job(child.id());

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        rt.generation += 1;
        let generation = rt.generation;
        rt.stdin = child.stdin.take();
        rt.child = Some(child);
        rt.token = Some(token);
        rt.log_tail.clear();
        rt.machine.apply(Signal::Spawned);
        tracing::info!(generation, "voice loop sidecar spawned");

        if let Some(out) = stdout {
            let this = self.clone();
            std::thread::spawn(move || this.read_stdout(out, generation));
        }
        if let Some(err) = stderr {
            let this = self.clone();
            let log_file = spec.log_file.clone();
            std::thread::spawn(move || this.read_stderr(err, generation, log_file));
        }
        Ok(generation)
    }

    fn read_stdout(&self, out: std::process::ChildStdout, generation: u64) {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Some(signal) = parse_line(&line) else { continue };
            let mut rt = self.lock();
            if rt.generation != generation {
                return;
            }
            if let Signal::Fatal { code, .. } = &signal {
                tracing::error!(code = code.as_str(), "voice loop sidecar reported a fatal error");
            }
            rt.machine.apply(signal);
            self.shared.changed.notify_all();
        }
        self.reap(generation);
    }

    /// Stdout closed: the process is leaving. Collect its exit code, so no
    /// zombie stays behind and the status can say why it left.
    fn reap(&self, generation: u64) {
        let started = Instant::now();
        let mut killed = false;
        loop {
            {
                let mut rt = self.lock();
                if rt.generation != generation {
                    return;
                }
                let Some(child) = rt.child.as_mut() else { return };
                match child.try_wait() {
                    Ok(Some(status)) => {
                        rt.child = None;
                        rt.stdin = None;
                        rt.token = None;
                        rt.machine.apply(Signal::Exited(status.code()));
                        tracing::info!(generation, code = ?status.code(), "voice loop sidecar exited");
                        self.shared.changed.notify_all();
                        return;
                    }
                    Ok(None) => {
                        // Closed its stdout and still lives: not a state the
                        // sidecar has. Do not let it linger.
                        if !killed && started.elapsed() > Duration::from_secs(15) {
                            force_kill(child);
                            killed = true;
                        }
                    }
                    Err(_) => {
                        rt.child = None;
                        rt.stdin = None;
                        rt.token = None;
                        rt.machine.apply(Signal::Exited(None));
                        self.shared.changed.notify_all();
                        return;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn read_stderr(&self, err: std::process::ChildStderr, generation: u64, log_file: Option<PathBuf>) {
        // One file per run. The cap keeps a sidecar that logs in a loop from
        // filling the disk.
        let mut file = log_file.and_then(|path| {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::File::create(path).ok()
        });
        let mut written: u64 = 0;
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            // The sidecar words its own errors in English, a library below it
            // may not: an OSError arrives in the system language.
            let line = os_error::english_child_text(&line).into_owned();
            if let Some(f) = file.as_mut() {
                if written < LOG_FILE_MAX_BYTES {
                    written += line.len() as u64 + 1;
                    let _ = writeln!(f, "{line}");
                }
            }
            let mut rt = self.lock();
            if rt.generation != generation {
                continue;
            }
            if rt.log_tail.len() == LOG_TAIL_LINES {
                rt.log_tail.pop_front();
            }
            rt.log_tail.push_back(line.chars().take(400).collect());
        }
    }

    fn wait_ready(&self, generation: u64, deadline: Instant, timeout: Duration) -> Result<Session, String> {
        let mut rt = self.lock();
        loop {
            if rt.generation != generation {
                return Err("The voice loop was restarted before it was ready. Try again.".to_string());
            }
            match rt.machine.phase {
                LoopPhase::Ready => {
                    return match (rt.machine.port, rt.token.clone()) {
                        (Some(port), Some(token)) => Ok(Session { port, token }),
                        _ => Err("The voice loop is in an unexpected state. Stop it and start it again.".to_string()),
                    };
                }
                LoopPhase::Failed => {
                    return Err(rt
                        .machine
                        .failure
                        .as_ref()
                        .map(|f| f.message.clone())
                        .unwrap_or_else(|| "The voice loop could not start.".to_string()));
                }
                LoopPhase::Stopped => {
                    return Err("The voice loop was stopped before it was ready.".to_string());
                }
                LoopPhase::Starting => {}
            }
            let now = Instant::now();
            if now >= deadline {
                drop(rt);
                self.stop(Duration::ZERO);
                return Err(format!(
                    "The voice loop did not become ready within {} seconds. Close other heavy programs and try again. If it keeps happening, run the voice setup again.",
                    timeout.as_secs()
                ));
            }
            rt = self
                .shared
                .changed
                .wait_timeout(rt, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// End the sidecar and return when the process is gone.
    ///
    /// Closing stdin is the graceful path. After `grace` the process tree is
    /// killed. A stop without a running sidecar clears a reported failure.
    pub fn stop(&self, grace: Duration) {
        let generation = {
            let mut rt = self.lock();
            if rt.child.is_none() {
                rt.machine = Machine::default();
                self.shared.changed.notify_all();
                return;
            }
            rt.machine.apply(Signal::StopRequested);
            rt.stdin = None;
            rt.generation
        };
        if self.wait_gone(generation, grace) {
            return;
        }
        {
            let mut rt = self.lock();
            if rt.generation != generation {
                return;
            }
            if let Some(child) = rt.child.as_mut() {
                tracing::warn!("voice loop sidecar did not leave in time, killing it");
                force_kill(child);
            }
        }
        if self.wait_gone(generation, Duration::from_secs(5)) {
            return;
        }
        // The reader thread did not get to it (a pipe held open by a stray
        // grandchild). Collect the exit here.
        let mut rt = self.lock();
        if rt.generation != generation {
            return;
        }
        if let Some(mut child) = rt.child.take() {
            let code = child.wait().ok().and_then(|s| s.code());
            rt.stdin = None;
            rt.token = None;
            rt.machine.apply(Signal::Exited(code));
            self.shared.changed.notify_all();
        }
    }

    /// Wait until the child of `generation` has been collected.
    fn wait_gone(&self, generation: u64, max: Duration) -> bool {
        let deadline = Instant::now() + max;
        let mut rt = self.lock();
        loop {
            if rt.generation != generation || rt.child.is_none() {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            rt = self
                .shared
                .changed
                .wait_timeout(rt, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── token ───────────────────────────────────────────────────────────

    #[test]
    fn a_token_is_64_hex_characters_and_never_the_same_twice() {
        let tokens: std::collections::HashSet<String> = (0..64).map(|_| new_token()).collect();
        assert_eq!(tokens.len(), 64);
        for t in &tokens {
            assert_eq!(t.len(), 64);
            assert!(t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{t}");
        }
    }

    #[test]
    fn a_token_is_long_enough_for_the_sidecar() {
        // MIN_TOKEN_CHARS in lu_voice_loop/auth.py.
        let auth = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/voice_loop/lu_voice_loop/auth.py"),
        )
        .unwrap();
        let min: usize = auth
            .lines()
            .find_map(|l| l.strip_prefix("MIN_TOKEN_CHARS = "))
            .and_then(|v| v.trim().parse().ok())
            .expect("MIN_TOKEN_CHARS not found in auth.py");
        assert!(new_token().len() >= min);
    }

    #[test]
    fn a_session_does_not_print_its_token() {
        let session = Session { port: 47000, token: "s3cret-token-value".to_string() };
        let printed = format!("{session:?}");
        assert!(!printed.contains("s3cret"), "{printed}");
        assert!(printed.contains("47000"));
    }

    #[test]
    fn the_status_has_no_token_field() {
        let voice = VoiceLoop::default();
        voice.lock().token = Some("s3cret-token-value".to_string());
        let json = serde_json::to_string(&voice.status()).unwrap();
        assert!(!json.contains("s3cret") && !json.contains("token"), "{json}");
    }

    #[test]
    fn the_token_travels_in_the_environment_and_never_as_an_argument() {
        let spec = LaunchSpec {
            python: PathBuf::from("python"),
            sidecar_dir: PathBuf::from("."),
            models_dir: PathBuf::from("models dir"),
            extra_origins: vec![],
            log_file: None,
            ready_timeout: READY_TIMEOUT,
        };
        let cmd = build_command(&spec, "s3cret-token-value");
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, ["-m", "lu_voice_loop", "--port", "0", "--models-dir", "models dir"]);
        let env: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string())))
            .collect();
        assert!(env.contains(&(TOKEN_ENV.to_string(), Some("s3cret-token-value".to_string()))));
        // No origin list: the sidecar's default applies, and an inherited
        // value is taken away.
        assert!(env.contains(&(ORIGINS_ENV.to_string(), None)));
        assert!(env.contains(&("LU_VOICE_LOG_CONTENT".to_string(), None)));
    }

    // ── origins ─────────────────────────────────────────────────────────

    #[test]
    fn the_default_origins_match_the_sidecar() {
        let auth = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/voice_loop/lu_voice_loop/auth.py"),
        )
        .unwrap();
        let line = auth.lines().find(|l| l.starts_with("DEFAULT_ORIGINS")).expect("DEFAULT_ORIGINS not found");
        let theirs: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        assert_eq!(theirs, DEFAULT_ORIGINS);
    }

    #[test]
    fn a_dev_origin_is_added_to_the_defaults_and_not_instead_of_them() {
        assert_eq!(origins_env(&[]), None);
        assert_eq!(origins_env(&["  ".to_string()]), None);
        let list = origins_env(&["http://localhost:5273/".to_string()]).unwrap();
        assert_eq!(list, "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:5273");
        // Already a default: nothing is listed twice.
        assert_eq!(origins_env(&["tauri://localhost".to_string()]).unwrap().matches("tauri://localhost").count(), 1);
    }

    // ── stdout lines ────────────────────────────────────────────────────

    #[test]
    fn the_three_events_are_parsed() {
        assert_eq!(parse_line(r#"{"event": "listening", "port": 47720}"#), Some(Signal::Listening(47720)));
        assert_eq!(parse_line("{\"event\": \"ready\"}\r\n"), Some(Signal::Ready));
        assert_eq!(
            parse_line(r#"{"event": "fatal", "code": "model_missing", "message": "Voice model file is missing: a.bin."}"#),
            Some(Signal::Fatal {
                code: "model_missing".to_string(),
                message: "Voice model file is missing: a.bin.".to_string()
            })
        );
    }

    #[test]
    fn anything_else_on_stdout_is_ignored() {
        for line in [
            "",
            "Loading model...",
            "{broken",
            "[1, 2]",
            r#"{"event": "verified"}"#,
            r#"{"event": "listening"}"#,
            r#"{"event": "listening", "port": 0}"#,
            r#"{"event": "listening", "port": 70000}"#,
            r#"{"event": "listening", "port": "47720"}"#,
            r#"{"event": 5}"#,
            r#"{"port": 47720}"#,
        ] {
            assert_eq!(parse_line(line), None, "{line}");
        }
    }

    #[test]
    fn a_fatal_line_without_text_still_gives_a_sentence_and_cannot_flood() {
        match parse_line(r#"{"event": "fatal"}"#) {
            Some(Signal::Fatal { code, message }) => {
                assert_eq!(code, "fatal");
                assert!(message.ends_with('.'));
            }
            other => panic!("{other:?}"),
        }
        let long = format!(r#"{{"event": "fatal", "code": "x", "message": "{}\u0007"}}"#, "a".repeat(5000));
        match parse_line(&long) {
            Some(Signal::Fatal { message, .. }) => {
                assert_eq!(message.len(), 600);
                assert!(!message.contains('\u{7}'));
            }
            other => panic!("{other:?}"),
        }
    }

    // ── state machine ───────────────────────────────────────────────────

    fn run(signals: &[Signal]) -> Machine {
        let mut m = Machine::default();
        for s in signals {
            m.apply(s.clone());
        }
        m
    }

    #[test]
    fn a_normal_start_goes_from_starting_to_ready_with_its_port() {
        let m = run(&[Signal::Spawned]);
        assert_eq!((m.phase, m.port), (LoopPhase::Starting, None));
        let m = run(&[Signal::Spawned, Signal::Listening(47720)]);
        assert_eq!((m.phase, m.port), (LoopPhase::Starting, Some(47720)));
        let m = run(&[Signal::Spawned, Signal::Listening(47720), Signal::Ready]);
        assert_eq!((m.phase, m.port, m.failure), (LoopPhase::Ready, Some(47720), None));
    }

    #[test]
    fn ready_without_a_port_is_not_ready() {
        assert_eq!(run(&[Signal::Spawned, Signal::Ready]).phase, LoopPhase::Starting);
        assert_eq!(run(&[Signal::Ready]).phase, LoopPhase::Stopped);
    }

    #[test]
    fn a_requested_stop_ends_in_stopped_without_an_error() {
        let m = run(&[Signal::Spawned, Signal::Listening(1), Signal::Ready, Signal::StopRequested, Signal::Exited(Some(0))]);
        assert_eq!(m, Machine::default());
        // Also when it had to be killed, and also when it was still loading.
        let m = run(&[Signal::Spawned, Signal::StopRequested, Signal::Exited(None)]);
        assert_eq!(m, Machine::default());
    }

    #[test]
    fn an_exit_nobody_asked_for_is_a_crash() {
        let m = run(&[Signal::Spawned, Signal::Listening(1), Signal::Ready, Signal::Exited(Some(1))]);
        assert_eq!(m.phase, LoopPhase::Failed);
        assert_eq!(m.port, None);
        let failure = m.failure.unwrap();
        assert_eq!(failure.code, "crashed");
        assert!(failure.message.contains("exit code 1"), "{}", failure.message);

        let m = run(&[Signal::Spawned, Signal::Listening(1), Signal::Ready, Signal::Exited(None)]);
        assert!(m.failure.unwrap().message.contains("ended by the system"));
        // Even a clean exit code is a crash when nobody asked for the stop.
        let m = run(&[Signal::Spawned, Signal::Listening(1), Signal::Ready, Signal::Exited(Some(0))]);
        assert_eq!(m.phase, LoopPhase::Failed);
        assert!(m.failure.unwrap().message.contains("closed from outside"));
    }

    #[test]
    fn a_fatal_line_keeps_its_own_message_over_the_exit_code() {
        let fatal = Signal::Fatal { code: "model_missing".into(), message: "Voice model file is missing: a.bin.".into() };
        let m = run(&[Signal::Spawned, fatal.clone()]);
        assert_eq!(m.phase, LoopPhase::Failed);
        let m = run(&[Signal::Spawned, fatal, Signal::Exited(Some(3))]);
        assert_eq!(m.phase, LoopPhase::Failed);
        assert_eq!(m.failure.unwrap().message, "Voice model file is missing: a.bin.");
    }

    #[test]
    fn a_restart_clears_the_last_failure() {
        let m = run(&[Signal::Spawned, Signal::Exited(Some(5)), Signal::Spawned]);
        assert_eq!((m.phase, m.failure, m.port), (LoopPhase::Starting, None, None));
    }

    #[test]
    fn late_lines_of_a_dead_process_change_nothing() {
        let dead = run(&[Signal::Spawned, Signal::Exited(Some(1))]);
        let mut m = dead.clone();
        m.apply(Signal::Listening(9));
        m.apply(Signal::Ready);
        m.apply(Signal::Fatal { code: "x".into(), message: "y".into() });
        assert_eq!(m, dead);
    }

    #[test]
    fn every_documented_exit_code_has_its_own_sentence() {
        let codes = [(2, "bad_environment"), (3, "model_missing"), (4, "port_in_use"), (5, "model_load_failed")];
        for (code, name) in codes {
            let failure = failure_for_exit(Some(code));
            assert_eq!(failure.code, name);
            assert!(!failure.message.contains("exit code"), "{}", failure.message);
        }
        // The numbers are the sidecar's.
        let errors = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/voice_loop/lu_voice_loop/errors.py"),
        )
        .unwrap();
        for line in ["EXIT_USAGE = 2", "EXIT_MODEL_MISSING = 3", "EXIT_PORT_IN_USE = 4", "EXIT_MODEL_LOAD = 5"] {
            assert!(errors.contains(line), "errors.py no longer says {line}");
        }
    }

    // ── process, with a stand-in for the sidecar ────────────────────────
    //
    // A shell script that speaks the same stdout protocol and ends when its
    // stdin closes. The real sidecar is driven by the ignored tests in
    // `live_tests.rs`.

    #[cfg(unix)]
    mod with_a_stand_in {
        use super::*;

        /// A fake interpreter: ignores its arguments and runs `body`.
        ///
        /// Written through [`crate::test_support::write_script`], so it is
        /// never busy when it starts. Written here directly, the start failed
        /// with "text file busy" (os error 26). Linux, 08.10.2026: 79 of 300
        /// runs of this module red, and 1 of 31 full runs.
        fn stand_in(dir: &std::path::Path, body: &str) -> LaunchSpec {
            let script = dir.join("python");
            crate::test_support::write_script(&script, format!("#!/bin/sh\n{body}\n"));
            LaunchSpec {
                python: script,
                sidecar_dir: dir.to_path_buf(),
                models_dir: dir.join("models"),
                extra_origins: vec![],
                log_file: Some(dir.join("sidecar.log")),
                ready_timeout: Duration::from_secs(10),
            }
        }

        const SERVE: &str = r#"echo '{"event": "listening", "port": 47999}'
echo "log line" >&2
echo '{"event": "ready"}'
cat >/dev/null"#;

        fn alive(pid: u32) -> bool {
            use sysinfo::{Pid, ProcessesToUpdate, System};
            let mut sys = System::new();
            sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
            sys.process(Pid::from_u32(pid)).is_some()
        }

        /// The log file once the stderr reader has written `expected` to it.
        ///
        /// The reader is a thread of its own, and `stop` returns as soon as
        /// the exit is collected, which the stdout reader does. Read straight
        /// after the stop, the file was sometimes not created yet ("No such
        /// file or directory"). Linux, 10.10.2026: 1 of 30 full runs red.
        fn log_once_written(path: &std::path::Path, expected: &str) -> String {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let text = std::fs::read_to_string(path).unwrap_or_default();
                if text == expected || Instant::now() >= deadline {
                    return text;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        /// Wait until the exit of the current child has been collected.
        fn settled(voice: &VoiceLoop) -> bool {
            let generation = voice.lock().generation;
            voice.wait_gone(generation, Duration::from_secs(5))
        }

        #[test]
        fn start_returns_the_port_and_a_token_and_stop_leaves_no_process() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let session = voice.start(&stand_in(tmp.path(), SERVE)).unwrap();
            assert_eq!(session.port, 47999);
            assert_eq!(session.token.len(), 64);
            let status = voice.status();
            assert!(status.running && status.ready);
            assert_eq!(status.port, Some(47999));
            let pid = status.pid.unwrap();
            assert!(alive(pid));

            voice.stop(STOP_GRACE);
            let status = voice.status();
            assert_eq!(status.state, LoopPhase::Stopped);
            assert!(!status.running && status.error.is_none() && status.port.is_none());
            // Collected, so not even a zombie is left under this pid.
            assert!(!alive(pid));
            assert_eq!(log_once_written(&tmp.path().join("sidecar.log"), "log line\n"), "log line\n");
        }

        #[test]
        fn a_second_start_gets_the_same_session() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let spec = stand_in(tmp.path(), SERVE);
            let first = voice.start(&spec).unwrap();
            let pid = voice.status().pid;
            let second = voice.start(&spec).unwrap();
            assert_eq!((first.port, &first.token), (second.port, &second.token));
            assert_eq!(voice.status().pid, pid, "a second start must not spawn a second sidecar");
            voice.stop(STOP_GRACE);
        }

        #[test]
        fn the_child_receives_the_token_in_its_environment() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let body = r#"printf '%s' "$LU_VOICE_TOKEN" > token.txt
echo '{"event": "listening", "port": 47998}'
echo '{"event": "ready"}'
cat >/dev/null"#;
            let session = voice.start(&stand_in(tmp.path(), body)).unwrap();
            // The working directory is the sidecar directory.
            assert_eq!(std::fs::read_to_string(tmp.path().join("token.txt")).unwrap(), session.token);
            voice.stop(STOP_GRACE);
        }

        #[test]
        fn a_fatal_start_returns_the_sidecars_sentence() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let body = r#"echo '{"event": "fatal", "code": "model_missing", "message": "Voice model file is missing: stt/model.bin. Install the voice models again."}'
exit 3"#;
            let err = voice.start(&stand_in(tmp.path(), body)).unwrap_err();
            assert!(err.contains("stt/model.bin"), "{err}");
            // The status settles once the exit is collected.
            assert!(settled(&voice));
            let status = voice.status();
            assert_eq!(status.state, LoopPhase::Failed);
            assert_eq!(status.error.unwrap().code, "model_missing");
            assert!(!status.running);
        }

        #[test]
        fn a_silent_exit_is_explained_by_its_code() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let err = voice.start(&stand_in(tmp.path(), "exit 5")).unwrap_err();
            assert!(err.contains("could not be loaded"), "{err}");
        }

        #[test]
        fn a_crash_after_ready_shows_in_the_status_and_a_restart_works() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let spec = stand_in(tmp.path(), SERVE);
            voice.start(&spec).unwrap();
            let pid = voice.status().pid.unwrap();
            assert!(std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap().success());
            assert!(settled(&voice));
            let status = voice.status();
            assert_eq!(status.state, LoopPhase::Failed);
            assert_eq!(status.error.as_ref().unwrap().code, "crashed");
            assert!(!status.running && !status.ready && status.port.is_none());

            let again = voice.start(&spec).unwrap();
            assert_eq!(again.port, 47999);
            assert!(voice.status().ready && voice.status().error.is_none());
            voice.stop(STOP_GRACE);
        }

        #[test]
        fn a_sidecar_that_never_gets_ready_is_ended_after_the_timeout() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let mut spec = stand_in(tmp.path(), "echo '{\"event\": \"listening\", \"port\": 47997}'\nexec sleep 60");
            spec.ready_timeout = Duration::from_millis(600);
            let started = Instant::now();
            let err = voice.start(&spec).unwrap_err();
            assert!(err.contains("did not become ready"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(8));
            assert!(!voice.status().running, "the stuck sidecar must not stay behind");
        }

        #[test]
        fn a_sidecar_that_ignores_the_closed_stdin_is_killed_after_the_grace() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let body = "echo '{\"event\": \"listening\", \"port\": 47996}'\necho '{\"event\": \"ready\"}'\nexec sleep 60";
            voice.start(&stand_in(tmp.path(), body)).unwrap();
            let pid = voice.status().pid.unwrap();
            let started = Instant::now();
            voice.stop(Duration::from_millis(300));
            assert!(started.elapsed() < Duration::from_secs(6));
            assert!(!alive(pid));
            assert_eq!(voice.status().state, LoopPhase::Stopped);
        }

        #[test]
        fn stop_without_a_sidecar_clears_an_old_failure() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let _ = voice.start(&stand_in(tmp.path(), "exit 5"));
            assert!(settled(&voice));
            assert!(voice.status().error.is_some());
            voice.stop(STOP_GRACE);
            let status = voice.status();
            assert!(status.error.is_none());
            assert_eq!(status.state, LoopPhase::Stopped);
        }

        #[test]
        fn a_missing_interpreter_says_the_setup_has_not_run() {
            let tmp = tempfile::tempdir().unwrap();
            let voice = VoiceLoop::default();
            let mut spec = stand_in(tmp.path(), SERVE);
            spec.python = tmp.path().join("no-such-python");
            let err = voice.start(&spec).unwrap_err();
            assert!(err.contains("not installed"), "{err}");
            assert_eq!(voice.status().state, LoopPhase::Stopped);
        }
    }
}
