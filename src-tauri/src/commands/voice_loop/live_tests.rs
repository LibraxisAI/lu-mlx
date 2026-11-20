//! Tests against the real sidecar, a real pip and the real download servers.
//!
//! Ignored by default: they need an installed environment or the network and
//! take minutes. They drive the same functions the Tauri commands call, never
//! the app itself.
//!
//!   LU_VOICE_LIVE_PYTHON=<venv python> LU_VOICE_LIVE_MODELS=<models dir> \
//!     cargo test voice_loop::live_tests::lifecycle -- --ignored --nocapture
//!
//!   LU_VOICE_LIVE_ROOT=<empty scratch dir> [LU_VOICE_LIVE_SEED=<models dir>] \
//!     cargo test voice_loop::live_tests::install -- --ignored --nocapture
//!
//! With `LU_VOICE_LIVE_SEED` the large model files are not downloaded twice:
//! all but their last megabytes are copied in as a partial download, so the
//! real server only has to continue them. Everything else is fetched in full.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::install::{self, JobStatus};
use super::layout::{self, VoiceDirs};
use super::manifest::ModelManifest;
use super::sidecar::{self, LaunchSpec, LoopPhase, Session, VoiceLoop};
use super::{begin_install, remove_installation, start_loop, status_report, VoiceLoopHandle};

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var(name).unwrap_or_else(|_| panic!("set {name} to run this test")))
}

fn real_sidecar() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(layout::SIDECAR_RESOURCE_PATH)
}

fn process_exists(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    sys.process(Pid::from_u32(pid)).is_some()
}

fn port_answers(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)).is_ok()
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build().unwrap()
}

/// GET /health, then prove the returned token is the one the sidecar accepts.
fn check_session(session: &Session) {
    let base = format!("http://127.0.0.1:{}", session.port);
    let health: serde_json::Value = http().get(format!("{base}/health")).send().unwrap().json().unwrap();
    println!("health: {health}");
    assert_eq!(health["status"], "ok");
    assert_eq!(health["state"], "ready");

    let body = serde_json::json!({ "llm": { "base_url": "http://127.0.0.1:9/v1", "model": "none" } });
    let post = |token: &str, origin: &str| {
        http()
            .post(format!("{base}/session"))
            .header("Origin", origin)
            .header("Authorization", format!("Bearer {token}"))
            .json(&body)
            .send()
            .unwrap()
    };
    assert_eq!(post(&"0".repeat(64), "tauri://localhost").status(), 401, "a wrong token must be refused");
    assert_eq!(post(&session.token, "https://example.org").status(), 403, "a foreign origin must be refused");
    let accepted = post(&session.token, "tauri://localhost");
    assert_eq!(accepted.status(), 200, "the launch token must open a session");
    let ticket: serde_json::Value = accepted.json().unwrap();
    assert!(ticket["wsUrl"].as_str().unwrap().starts_with(&format!("ws://127.0.0.1:{}/", session.port)));
}

fn assert_gone(pid: u32, port: u16) {
    assert!(!process_exists(pid), "the sidecar process {pid} is still there");
    assert!(!port_answers(port), "something still answers on the sidecar port {port}");
}

#[test]
#[ignore = "needs an installed voice environment, see the top of this file"]
fn lifecycle() {
    let spec = LaunchSpec {
        python: env_path("LU_VOICE_LIVE_PYTHON"),
        sidecar_dir: real_sidecar(),
        models_dir: env_path("LU_VOICE_LIVE_MODELS"),
        extra_origins: vec!["http://localhost:5273".to_string()],
        log_file: None,
        ready_timeout: sidecar::READY_TIMEOUT,
    };
    let voice = VoiceLoop::default();

    // Start, ready, health, session.
    let started = Instant::now();
    let session = voice.start(&spec).unwrap();
    println!("ready after {:.1} s on port {}", started.elapsed().as_secs_f64(), session.port);
    let status = voice.status();
    assert!(status.running && status.ready);
    assert_eq!(status.port, Some(session.port));
    let pid = status.pid.unwrap();
    check_session(&session);
    // The dev origin that was passed in is accepted next to the defaults.
    let dev = http()
        .post(format!("http://127.0.0.1:{}/session", session.port))
        .header("Origin", "http://localhost:5273")
        .header("Authorization", format!("Bearer {}", session.token))
        .json(&serde_json::json!({ "llm": { "base_url": "http://127.0.0.1:9/v1", "model": "none" } }))
        .send()
        .unwrap();
    assert_eq!(dev.status(), 200);

    // A second start is the same session, not a second process.
    let again = voice.start(&spec).unwrap();
    assert_eq!((again.port, &again.token), (session.port, &session.token));
    assert_eq!(voice.status().pid, Some(pid));

    // Stop: graceful, and nothing is left.
    let stopping = Instant::now();
    voice.stop(sidecar::STOP_GRACE);
    println!("stopped after {:.1} s", stopping.elapsed().as_secs_f64());
    assert!(stopping.elapsed() < sidecar::STOP_GRACE, "the sidecar had to be killed instead of leaving by itself");
    let status = voice.status();
    assert_eq!(status.state, LoopPhase::Stopped);
    assert!(!status.running && status.error.is_none());
    assert_gone(pid, session.port);

    // Crash: killed from outside, the status says so, a restart works.
    let second = voice.start(&spec).unwrap();
    assert_ne!(second.token, session.token, "every start gets its own token");
    let pid = voice.status().pid.unwrap();
    crate::process_util::kill_pid_tree(pid);
    let deadline = Instant::now() + Duration::from_secs(15);
    while voice.status().running && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let status = voice.status();
    println!("after the kill: {:?} {:?}", status.state, status.error);
    assert_eq!(status.state, LoopPhase::Failed);
    assert!(!status.running && !status.ready && status.port.is_none());
    assert!(status.error.is_some());
    assert_gone(pid, second.port);

    let third = voice.start(&spec).unwrap();
    check_session(&third);
    let pid = voice.status().pid.unwrap();
    // The quit path: a short grace, then the kill.
    VoiceLoopHandle { sidecar: voice.clone(), ..Default::default() }.shutdown();
    assert_gone(pid, third.port);

    // A models folder with nothing in it: the sidecar's own sentence comes back.
    let empty = tempfile::tempdir().unwrap();
    let mut broken = spec.clone();
    broken.models_dir = empty.path().to_path_buf();
    let err = voice.start(&broken).unwrap_err();
    println!("missing models: {err}");
    assert!(err.contains("missing"), "{err}");
    voice.stop(sidecar::STOP_GRACE);
    assert!(!voice.status().running);
}

/// Copy all but the tail of every large model file in as a partial download.
fn seed_partials(dirs: &VoiceDirs, seed: &Path) {
    const TAIL: u64 = 3 * 1024 * 1024;
    let manifest = ModelManifest::load(&real_sidecar()).unwrap();
    for file in manifest.files() {
        if file.remote.size < 8 * TAIL {
            continue;
        }
        let source = file.path.split('/').fold(seed.to_path_buf(), |p, part| p.join(part));
        let dest = file.path.split('/').fold(dirs.models(), |p, part| p.join(part));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let mut reader = std::io::Read::take(std::fs::File::open(&source).unwrap(), file.remote.size - TAIL);
        let mut writer = std::fs::File::create(layout::twin(&dest)).unwrap();
        let copied = std::io::copy(&mut reader, &mut writer).unwrap();
        println!("seeded {} with {copied} of {} bytes", file.path, file.remote.size);
    }
}

fn run_setup(dirs: &VoiceDirs, handle: &VoiceLoopHandle, force: bool) -> install::InstallSnapshot {
    assert_eq!(begin_install(dirs, &real_sidecar(), handle, force), "started");
    let mut last = String::new();
    loop {
        let snap = handle.job.snapshot();
        let line = format!("{:?} {:?} {} {}/{}", snap.status, snap.phase, snap.message, snap.bytes_done, snap.bytes_total);
        if snap.message != last {
            println!("{line}");
            last = snap.message.clone();
        }
        if snap.status != JobStatus::Running {
            for log in &snap.logs {
                println!("  log: {log}");
            }
            return snap;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[test]
#[ignore = "installs for real: network, about 700 MB, several minutes"]
fn install() {
    let root = env_path("LU_VOICE_LIVE_ROOT");
    // A path with a space, as a Windows user name has.
    let dirs = VoiceDirs::at(root.join("voice loop"));
    assert!(!dirs.root.exists(), "{} must not exist yet", dirs.root.display());
    let handle = VoiceLoopHandle::default();
    let platform = layout::this_platform;

    let need = install::requirements(&dirs, &real_sidecar(), platform(), install::free_space(&dirs)).unwrap();
    println!("requirements: {}", serde_json::to_string_pretty(&need).unwrap());
    assert!(need.supported && need.enough_space && !need.installed);

    if let Ok(seed) = std::env::var("LU_VOICE_LIVE_SEED") {
        seed_partials(&dirs, Path::new(&seed));
        let seeded = install::requirements(&dirs, &real_sidecar(), platform(), install::free_space(&dirs)).unwrap();
        assert!(seeded.download_bytes < need.download_bytes, "the partial files must count as present");
    }

    // A cancel in the middle, then the run that continues.
    assert_eq!(begin_install(&dirs, &real_sidecar(), &handle, false), "started");
    assert_eq!(begin_install(&dirs, &real_sidecar(), &handle, false), "already_running");
    let deadline = Instant::now() + Duration::from_secs(120);
    while handle.job.snapshot().bytes_done == 0 && handle.job.is_running() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    handle.job.cancel();
    while handle.job.is_running() {
        std::thread::sleep(Duration::from_millis(50));
    }
    let cancelled = handle.job.snapshot();
    println!("after cancel: {:?} {:?} {}", cancelled.status, cancelled.phase, cancelled.message);
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert!(!install::installed(&dirs, &real_sidecar()).complete);

    let started = Instant::now();
    let done = run_setup(&dirs, &handle, false);
    println!("setup took {:.0} s", started.elapsed().as_secs_f64());
    assert_eq!(done.status, JobStatus::Complete, "{:?}", done.error);
    assert!(install::installed(&dirs, &real_sidecar()).complete);
    assert!(!dirs.pip_cache().exists() && !dirs.python_archive().exists() && !dirs.python_unpack().exists());

    // The sidecar's own check agrees with ours: every hash matches.
    let verify = install::private_python(&dirs.venv_python())
        .current_dir(real_sidecar())
        .args(["-m", "lu_voice_loop", "--port", "0", "--verify-models", "--models-dir"])
        .arg(dirs.models())
        .output()
        .unwrap();
    println!("verify-models: {}", String::from_utf8_lossy(&verify.stdout).trim());
    assert!(verify.status.success(), "{}", String::from_utf8_lossy(&verify.stderr));

    // A second run finds everything and does nothing.
    let started = Instant::now();
    let again = run_setup(&dirs, &handle, false);
    assert_eq!(again.status, JobStatus::Complete);
    assert!(started.elapsed() < Duration::from_secs(20), "an idempotent run must not reinstall");

    // The installed loop starts from this installation.
    let report = status_report(&dirs, &real_sidecar(), platform(), &handle);
    assert!(report.installed && !report.running);
    assert!(report.versions.installed_python.is_some());
    let session = start_loop(&dirs, &real_sidecar(), platform(), &handle, vec![]).unwrap();
    check_session(&session);
    let pid = handle.sidecar.status().pid.unwrap();
    assert!(dirs.log_file().is_file());

    // A broken model: the status notices, the setup repairs it and has to
    // stop the running sidecar for that.
    let manifest = ModelManifest::load(&real_sidecar()).unwrap();
    let small = manifest.files().min_by_key(|f| f.remote.size).unwrap();
    let victim = small.path.split('/').fold(dirs.models(), |p, part| p.join(part));
    std::fs::write(&victim, b"broken").unwrap();
    assert!(!install::installed(&dirs, &real_sidecar()).complete);
    let repaired = run_setup(&dirs, &handle, false);
    assert_eq!(repaired.status, JobStatus::Complete, "{:?}", repaired.error);
    assert_gone(pid, session.port);
    assert_eq!(std::fs::metadata(&victim).unwrap().len(), small.remote.size);

    // Uninstall removes everything.
    let session = start_loop(&dirs, &real_sidecar(), platform(), &handle, vec![]).unwrap();
    let pid = handle.sidecar.status().pid.unwrap();
    remove_installation(&dirs, &handle).unwrap();
    assert_gone(pid, session.port);
    assert!(!dirs.root.exists(), "uninstall left files behind in {}", dirs.root.display());
    assert!(!status_report(&dirs, &real_sidecar(), platform(), &handle).installed);
}
