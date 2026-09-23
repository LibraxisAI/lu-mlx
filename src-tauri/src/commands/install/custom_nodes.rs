//! Ein Node-Paket in ComfyUIs `custom_nodes/` bringen und lauffähig halten.
//!
//! Der geteilte Zustand ist ein einzelnes Verzeichnis unter `custom_nodes/`,
//! das in drei Zuständen angetroffen werden kann: gar nicht da, als
//! git-Checkout, oder als Rest eines abgebrochenen Versuchs. Alle Funktionen
//! hier arbeiten an diesem einen Verzeichnis, und die Naht läuft genau darum
//! herum.
//!
//! Aus #72 stammt die Regel, die das Modul zusammenhält: der Klon-Weg und der
//! Aktualisierungs-Weg müssen BEIDE die `requirements.txt` einspielen. Solange
//! nur der Klon das tat, konnte sich ein Paket, dessen Requirements einmal
//! gescheitert waren, nie wieder erholen — ComfyUI meldete weiter IMPORT
//! FAILED, und der Knoten tauchte nie auf. Deshalb ist
//! `install_node_requirements` eine eigene Funktion und wird von beiden Wegen
//! gerufen.
//!
//! Warum die Rechte-Erkennung NICHT mehr hier steht: sie deutet eine
//! pip-Ausgabe, und das tut `pip`. Der Fall, den sie rettet, ist trotzdem
//! genau dieser hier — eine python.org-Installation unter Program Files hat
//! ein Administrator-eigenes `site-packages`, und dort scheitert das erste
//! Paket, das ein NEUES Wheel zieht, während Pakete mit schon vorhandenen
//! Abhängigkeiten durchlaufen. Deshalb ruft dieses Modul
//! `super::pip::is_permission_denied_pip_error` und deutet nichts selbst.

use std::fs;
use std::path::PathBuf;
use crate::python::python_command;
use super::pip::is_permission_denied_pip_error;
use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::State;
use tracing::{error, info};

use crate::os_error;
use crate::state::AppState;

use super::pip::diagnose_pip_error;
#[cfg(target_os = "windows")]
use super::git::{windows_git_install_hint, windows_git_probe, WindowsGitState};
#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;

// ──────────────────────────────────────────────────────────────────────────────

#[allow(non_snake_case)]
#[tauri::command]
pub async fn install_custom_node(
    state: State<'_, AppState>,
    repoUrl: String,
    nodeName: String,
) -> Result<serde_json::Value, String> {
    // Snapshot the state the blocking worker needs before spawning it: a Tauri
    // `State` (and the MutexGuard behind it) is not Send, so clone the values
    // out and move owned copies into the worker.
    let comfy_path = { state.comfy_path.lock().unwrap().clone() };
    let path_slot = state.comfy_path.clone();
    let comfy_port = *state.comfy_port.lock().unwrap();
    let fallback_python = { state.python_bin.lock().unwrap().clone() };
    // Freeze fix (David 2026-07-04): the git clone + pip below are blocking. As
    // a plain sync #[command] they ran on the Tauri main thread and froze the
    // WebView2 window for the entire 30s-2min install with no feedback ("hängt
    // sich auf, keine Rückmeldung"). Run them on the blocking pool so the UI
    // stays responsive and the staged status messages actually paint — the JS
    // caller still awaits this command's result exactly as before.
    tauri::async_runtime::spawn_blocking(move || {
        install_custom_node_blocking(
            repoUrl,
            nodeName,
            comfy_path,
            &fallback_python,
            path_slot,
            comfy_port,
        )
    })
    .await
    .map_err(|e| format!("Custom node install task failed to run: {e}"))?
}

/// Blocking half of `install_custom_node`, run on the blocking pool. Holds all
/// the ComfyUI-path resolution, git clone/pull healing (#72) and pip work so
/// the async command above never stalls the UI thread.
#[allow(non_snake_case)]
fn install_custom_node_blocking(
    repoUrl: String,
    nodeName: String,
    comfy_path: Option<String>,
    fallback_python: &str,
    path_slot: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    comfy_port: u16,
) -> Result<serde_json::Value, String> {
    let repo_url = repoUrl;
    let node_name = nodeName;

    // Security review 2.5.7: this clones `repo_url` and joins `node_name` under
    // custom_nodes/. Every in-app caller passes a hardcoded registry entry, so
    // these are trusted today — but a single renderer foothold could call the
    // command with a hostile value, so validate defensively. Reject anything that
    // isn't a plain https:// URL: git's `ext::`/`file::`/`ssh` transports execute
    // commands, and a leading `-` would be parsed as a git flag. Reject any path
    // syntax in `node_name` (`/`, `\`, `..`, `:`, leading `-`/`.`) — an absolute
    // or `..` component makes `custom_nodes_dir.join(node_name)` escape the dir.
    if !repo_url.starts_with("https://")
        || repo_url.len() > 512
        || repo_url.contains(|c: char| c.is_whitespace() || c.is_control())
    {
        return Err("Refusing to install: repository URL must be a plain https:// URL.".to_string());
    }
    if node_name.is_empty()
        || node_name.len() > 128
        || node_name.contains('/')
        || node_name.contains('\\')
        || node_name.contains("..")
        || node_name.contains(':')
        || node_name.starts_with('-')
        || node_name.starts_with('.')
    {
        return Err("Refusing to install: invalid custom-node name.".to_string());
    }

    info!(node = %node_name, "custom node install start");

    // A remembered path that no longer contains main.py is not an install.
    // On macOS the disk walk is off, so the usual miss is a ComfyUI that is
    // already serving the configured port whose folder was never
    // written down. Ask that process before concluding it is absent.
    let remembered = comfy_path.filter(|p| {
        std::path::Path::new(p).join("main.py").is_file()
    });
    let discovered = remembered.or_else(|| {
        crate::commands::process::find_comfyui_path().filter(|p| {
            std::path::Path::new(p).join("main.py").is_file()
        })
    }).or_else(|| crate::commands::process::comfy_install_from_listener(comfy_port));
    let comfy_dir = match discovered {
        Some(p) => {
            if path_slot.lock().ok().and_then(|g| g.clone()).as_deref() != Some(p.as_str()) {
                if let Ok(mut slot) = path_slot.lock() {
                    *slot = Some(p.clone());
                }
                if let Err(e) = crate::commands::process::persist_comfyui_path(&p) {
                    println!("[Install] Could not persist ComfyUI path: {e}");
                }
            }
            PathBuf::from(p)
        }
        None => {
            error!(node = %node_name, port = comfy_port, "custom node install failed: comfyui not found");
            return Err("ComfyUI not found. Install ComfyUI first.".to_string());
        }
    };

    let custom_nodes_dir = comfy_dir.join("custom_nodes");
    let target_dir = custom_nodes_dir.join(&node_name);

    // Create custom_nodes dir if it doesn't exist
    if !custom_nodes_dir.exists() {
        fs::create_dir_all(&custom_nodes_dir)
            .map_err(|e| format!("Failed to create custom_nodes directory: {}", os_error::english(&e)))?;
    }

    // Bug N — same git probe as install_comfyui. Block on missing git, log
    // a soft hint when a non-native git is first on PATH.
    #[cfg(target_os = "windows")]
    {
        let probe = windows_git_probe();
        if probe == WindowsGitState::Missing {
            return Err(windows_git_install_hint(&probe).unwrap_or_default());
        }
        if probe == WindowsGitState::NonNative {
            if let Some(hint) = windows_git_install_hint(&probe) {
                println!("[Install] {}", hint);
            }
        }
    }

    // Linux setup stolpstein (BERICHT-5-APPIMAGE.md): fresh Debian 13 and
    // Fedora 43 cloud/desktop images ship no git at all. Probe before
    // spending any bytes on the clone/pull below.
    if let Some(hint) = super::git::git_download_preflight() {
        return Err(hint);
    }

    // #72 (bob, discussion 72): three silent failure modes lived here.
    //  1. A leftover non-repo dir (aborted clone, manual unzip) made `git pull`
    //     fail forever, and the failure came back as Ok(status="update_failed")
    //     — the UI treated it as success, so the install dialog looped with no
    //     error and video gen kept falling back to .webp.
    //  2. The exists/update path never installed requirements.txt, so a repo
    //     whose requirements failed once could never heal (ComfyUI keeps
    //     reporting IMPORT FAILED and the node never shows up).
    // Now: a non-repo leftover is moved aside (".disabled" so ComfyUI ignores
    // it) and re-cloned, a failed pull is a real Err, and requirements are
    // ensured on BOTH the clone and the update path.
    let mut fresh_clone = true;
    if target_dir.exists() {
        if target_dir.join(".git").exists() {
            println!("[Install] Custom node {} already exists, updating...", node_name);
            let mut cmd = crate::process_util::foreign_system_command("git");
            cmd.args(["pull"]).current_dir(&target_dir)
                .stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let output = cmd.output()
                .map_err(|e| format!("Git pull failed: {}", os_error::english(&e)))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!(node = %node_name, "custom node git pull failed");
                return Err(format!(
                    "Failed to update {} (git pull): {}\n\nIf this keeps failing, \
                     delete the folder {} and try the install again.",
                    node_name, stderr.trim(), target_dir.to_string_lossy()
                ));
            }
            fresh_clone = false;
        } else {
            // Not a git repo — pull can never succeed. Move it aside and re-clone.
            let moved_to = move_aside_broken_node_dir(&target_dir)?;
            println!(
                "[Install] Custom node {} folder exists but is not a git repo — moved aside to {}, re-cloning",
                node_name,
                moved_to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            );
        }
    }

    if fresh_clone {
        println!("[Install] Cloning custom node {} from {}", node_name, repo_url);
        let mut cmd = crate::process_util::foreign_system_command("git");
        cmd.args(["clone", &repo_url]).arg(&target_dir)
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output()
            .map_err(|e| format!("Git clone failed: {}", os_error::english(&e)))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(node = %node_name, "custom node clone failed");
            return Err(format!("Failed to clone {}: {}", node_name, stderr));
        }
    }

    // No constraints file here: this is a fresh clone (or update) of ONE
    // node against whatever the venv already has, not the post-repair
    // restore path where a downgrade of a just-verified core package is the
    // specific risk (Runde 6, Folgeposten a).
    install_node_requirements(&comfy_dir, &target_dir, &node_name, fallback_python, None)?;

    Ok(serde_json::json!({
        "status": if fresh_clone { "installed" } else { "updated" },
        "path": target_dir.to_string_lossy(),
    }))
}

/// Move a non-repo custom-node leftover out of the way so a fresh clone can
/// land. The ".disabled" suffix matches the ComfyUI(-Manager) convention, so
/// ComfyUI never tries to load the moved-aside folder as a node pack.
fn move_aside_broken_node_dir(target_dir: &std::path::Path) -> Result<PathBuf, String> {
    let base = target_dir.to_string_lossy().into_owned();
    let mut backup = PathBuf::from(format!("{}.broken.disabled", base));
    let mut n = 1;
    while backup.exists() {
        n += 1;
        backup = PathBuf::from(format!("{}.broken{}.disabled", base, n));
    }
    fs::rename(target_dir, &backup).map_err(|e| {
        format!(
            "The folder {} exists but is not a valid git checkout, and it could \
             not be moved aside: {}. Delete it manually and try again.",
            target_dir.display(),
            os_error::english(&e)
        )
    })?;
    Ok(backup)
}

/// Install a custom node's requirements.txt (when present) into the Python
/// that ComfyUI actually runs with. Shared by the clone AND the update path
/// of `install_custom_node` — #72 was partly caused by the update path
/// skipping this entirely.
///
/// Bug F (discovered during Arch live test on 2026-05-17): ComfyUI was
/// installed into a venv by the Bug E path, but this used to call pip against
/// `state.python_bin` (the system Python). On Arch / Debian 12+ / Fedora 38+
/// that hits PEP 668's `externally-managed-environment` and the requirements
/// install silently fails. Prefer the ComfyUI venv's Python (matches the
/// launcher in `process.rs::start_comfyui` and the installer in
/// `install_comfyui`) so requirements land in the same site-packages ComfyUI
/// actually imports from, and surface a useful error when pip fails.
pub(crate) fn install_node_requirements(
    comfy_dir: &std::path::Path,
    target_dir: &std::path::Path,
    node_name: &str,
    fallback_python: &str,
    constraints: Option<&std::path::Path>,
) -> Result<(), String> {
    let reqs = target_dir.join("requirements.txt");
    if !reqs.exists() {
        return Ok(());
    }
    // P3, dritte Stelle mit derselben Frage: ein venv ohne Interpreter ist
    // nicht "kein venv". Die Anforderungen des Knotens landeten sonst im
    // System-Python, aus dem dieses ComfyUI nie startet, und der Knoten fehlt
    // beim naechsten Lauf trotzdem.
    let python_bin = match crate::python::comfy_venv_state(comfy_dir) {
        crate::python::ComfyVenv::Usable(p) => p,
        crate::python::ComfyVenv::Broken { venv_dir, interpreter } => {
            return Err(crate::commands::process::comfy_broken_venv_message(&venv_dir, &interpreter));
        }
        crate::python::ComfyVenv::Absent => fallback_python.to_string(),
    };
    if python_bin.is_empty() {
        return Err(format!(
            "Custom node {} cloned, but cannot install requirements: \
             no Python available. Install Python first \
             (Settings → ComfyUI → Install Python).",
            node_name
        ));
    }
    println!("[Install] Installing requirements for {} via {}", node_name, python_bin);
    let run_pip = |extra: &[&str]| -> Result<std::process::Output, String> {
        let mut pip = python_command(&python_bin);
        pip.args(["-m", "pip", "install", "--no-input"]);
        // Runde 6, Folgeposten (a) (review Runde 5, F2): a node's own
        // requirements.txt must not be allowed to quietly downgrade the
        // core packages a repair just verified (`numpy<2`, an unpinned old
        // torch, ...). With `-c`, pip refuses to install anything that
        // conflicts with a constraint instead of silently changing it, so
        // THIS install fails, loudly, by name, through the ordinary
        // per-node failure path below.
        if let Some(c) = constraints {
            pip.arg("-c").arg(c);
        }
        pip.args(extra);
        pip.arg("-r").arg(&reqs);
        pip.stdout(Stdio::piped()).stderr(Stdio::piped());
        pip.output()
            .map_err(|e| format!("Failed to spawn pip for {} requirements: {}", node_name, os_error::english(&e)))
    };
    let pip_out = run_pip(&[])?;
    if !pip_out.status.success() {
        let stderr = String::from_utf8_lossy(&pip_out.stderr);
        let stdout = String::from_utf8_lossy(&pip_out.stdout);
        let combined = format!("{}{}", stdout, stderr);
        // python.org installs under Program Files have an admin-only
        // site-packages: the first node pack whose requirements pull a NEW
        // wheel dies with a permission error, while packs whose deps are
        // already present sail through (why RMBG/VHS installs passed and
        // controlnet_aux stranded the Motion install card, 2026-07-19).
        // Retry into the per-user site — the same interpreter imports from
        // there, no admin needed. The Windows twin of the PEP 668 --user
        // escape above; a venv Python never hits a permission error here,
        // and if the retry fails too we surface the original diagnosis.
        if is_permission_denied_pip_error(&combined) {
            println!(
                "[Install] {} requirements hit a permission error — retrying into the user site (--user)",
                node_name
            );
            if let Ok(user_out) = run_pip(&["--user"]) {
                if user_out.status.success() {
                    return Ok(());
                }
            }
        }
        // Reuse the install_comfyui diagnose path so PEP 668 +
        // friends produce actionable messages here too.
        let diagnosis = diagnose_pip_error(&combined);
        error!(node = %node_name, "custom node requirements install failed");
        return Err(format!(
            "Custom node {} is cloned, but its requirements install failed.\n\n{}",
            node_name, diagnosis
        ));
    }
    Ok(())
}


/// Runde 6, Folgeposten (a) (review Runde 5, F2): the core packages a
/// repair just spent four steps building and verifying, as a `pip freeze`
/// snapshot a caller can hand to [`install_node_requirements`] as a
/// constraints file so pip REFUSES to let a node's own requirements.txt
/// quietly change any of them.
const CORE_PACKAGES: [&str; 4] = ["torch", "torchvision", "torchaudio", "numpy"];

/// Write [`CORE_PACKAGES`]'s current, exact versions (from `pip freeze`
/// against `python_bin`) to a fresh temp file in pip's constraints format
/// (one `name==version` per line) and return its path. `None` when `pip
/// freeze` itself fails to run, or when none of the core packages turn out
/// to be installed. A ComfyUI venv should always have torch, but this must
/// never invent a pin rather than silently skip constraining.
///
/// The caller owns the returned file and is responsible for deleting it once
/// the node loop that uses it is done; this function only ever creates one.
pub(crate) fn write_core_package_constraints(python_bin: &str) -> Option<PathBuf> {
    let mut cmd = python_command(python_bin);
    cmd.args(["-m", "pip", "freeze"]).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let freeze = String::from_utf8_lossy(&out.stdout);
    let core_lines = core_constraint_lines(&freeze);
    if core_lines.is_empty() {
        return None;
    }
    let path = std::env::temp_dir().join(format!(
        "lu-node-constraints-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    fs::write(&path, core_lines.join("\n")).ok()?;
    Some(path)
}

/// Pure: the subset of a `pip freeze` listing that names one of
/// [`CORE_PACKAGES`], for exactly the reason every other network- or
/// process-touching function in this codebase splits its parsing out:
/// testable against a canned string, no pip and no venv required.
///
/// Runde 6, F14 (review Runde 6, Abschnitt 9): `pip freeze` prints a package
/// installed from a local wheel or a direct URL as a PEP 508 direct
/// reference, `torch @ file:///.../torch-2.7.0-cp312-cp312-linux_x86_64.whl`
/// rather than `torch==2.7.0`. The name-matching filter still finds "torch"
/// in that line (the split on `' '` catches the name before the `@` is ever
/// reached), so it used to sail into the constraints file unchanged. pip
/// refuses a `@` line in a CONSTRAINTS file outright ("links are not allowed
/// as constraints"), and that refusal is not per-package: it fails the whole
/// `-c <file>` argument, so EVERY custom node's own install would start
/// failing, not just the one node that happens to touch a core package. A
/// venv built the normal way, from the index, never produces this shape (see
/// `write_core_package_constraints`'s own doc: it only ever reads THIS
/// venv's `pip freeze` after this repair's own build), so this is a defensive
/// skip for a shape that should not occur today, not a shape this file
/// exercises against a real freeze.
fn core_constraint_lines(freeze: &str) -> Vec<&str> {
    freeze
        .lines()
        .filter(|line| {
            let name = line
                .split(['=', '@', ' ', '<', '>', '~', '!'])
                .next()
                .unwrap_or("")
                .to_lowercase();
            CORE_PACKAGES.contains(&name.as_str()) && !line.contains('@')
        })
        .collect()
}

/// What a custom-node dependency restore actually did, so the caller can
/// tell a customer which nodes came back, which did not, and whether the
/// user cancelled partway rather than every node simply having run.
pub(crate) struct NodeReinstallOutcome {
    /// Node folder names whose requirements installed cleanly.
    pub(crate) reinstalled: Vec<String>,
    /// Node folder name plus the reason, for every one that failed.
    pub(crate) failures: Vec<(String, String)>,
    /// True when the cancel flag was seen between nodes and the loop
    /// stopped early; `reinstalled`/`failures` only cover what ran before
    /// that point.
    pub(crate) cancelled: bool,
}

impl NodeReinstallOutcome {
    /// Runde 6, F13 (review Runde 6, Abschnitt 5): the second verification
    /// gate after the node loop used to run only when EVERY node succeeded
    /// (`failures.is_empty()`), so one unrelated node failure skipped the
    /// gate even though a DIFFERENT node had already installed something and
    /// could have quietly downgraded a core package. What decides whether
    /// there is anything new to re-verify is whether at least one node's
    /// requirements actually got installed, not whether every node did.
    pub(crate) fn needs_reverification(&self) -> bool {
        !self.reinstalled.is_empty()
    }
}

/// Runde 5 (review-engine.md Runde 4, Folgeposten): after the repair
/// rebuilds `ComfyUI/venv` from nothing, every EXISTING `custom_nodes/*`
/// folder's own `requirements.txt` (RMBG, VHS, controlnet_aux, whatever the
/// customer had cloned in) is gone from the fresh venv, unlike ComfyUI's own
/// core requirements, which the repair already reinstalls. The repair's own
/// log line and the "Repair environment" tooltip both say "custom nodes stay
/// untouched", true for the FOLDERS but not for what those nodes need to
/// import; without this, "untouched" is a promise the repair does not keep.
///
/// Reuses [`install_node_requirements`], the SAME function `install_custom_node`
/// itself calls (#72's rule: one function for every path that installs a
/// node's requirements, so a fix never lands in only one of them), nothing
/// here re-implements pip or PEP 668 handling.
///
/// One folder's failure never stops the rest: a customer with five nodes and
/// one broken one should get four working nodes back, not zero, and the
/// caller is told which one(s) failed so it can say so instead of silently
/// claiming success.
///
/// Runde 6, Folgeposten (a) and (b) (review Runde 5, F2/F3): `constraints`
/// (from [`write_core_package_constraints`]) is passed straight through to
/// every node's own install so none of them can quietly downgrade torch or
/// numpy; `cancel` is read BETWEEN nodes so a customer with twenty of them
/// can actually stop the run instead of the Cancel button doing nothing
/// (F3); and `on_progress` is called with each node's name before it starts,
/// so the log carries one line per node instead of a single blanket
/// sentence for the whole batch.
pub(crate) fn reinstall_all_node_requirements(
    comfy_dir: &std::path::Path,
    fallback_python: &str,
    constraints: Option<&std::path::Path>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
    mut on_progress: impl FnMut(&str),
) -> NodeReinstallOutcome {
    let nodes_dir = comfy_dir.join("custom_nodes");
    let Ok(entries) = fs::read_dir(&nodes_dir) else {
        return NodeReinstallOutcome { reinstalled: Vec::new(), failures: Vec::new(), cancelled: false };
    };
    let mut failures = Vec::new();
    let mut reinstalled = Vec::new();
    let mut names: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // The move-aside convention above: a folder ComfyUI itself never
            // loads must not be reinstalled into either, it is not a live
            // node. `__pycache__` is not a node folder; harmless to skip.
            if name.ends_with(".disabled") || name == "__pycache__" {
                None
            } else {
                Some((name, e.path()))
            }
        })
        .collect();
    // Deterministic order: a real folder listing order is filesystem- and
    // platform-dependent, and a customer-facing failure list that reorders
    // itself between runs reads as flaky even when the underlying cause is
    // stable.
    names.sort();
    for (name, target_dir) in names {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst)) {
            return NodeReinstallOutcome { reinstalled, failures, cancelled: true };
        }
        on_progress(&name);
        if let Err(e) = install_node_requirements(comfy_dir, &target_dir, &name, fallback_python, constraints) {
            error!(node = %name, error = %e, "custom node requirements could not be restored after a repair");
            failures.push((name, e));
        } else {
            reinstalled.push(name);
        }
    }
    NodeReinstallOutcome { reinstalled, failures, cancelled: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── install_custom_node helpers (#72 bob: VHS install loop) ─────────

    #[test]
    fn move_aside_renames_non_repo_dir_to_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let node_dir = tmp.path().join("ComfyUI-VideoHelperSuite");
        std::fs::create_dir(&node_dir).unwrap();
        std::fs::write(node_dir.join("leftover.txt"), "junk").unwrap();

        let moved = move_aside_broken_node_dir(&node_dir).unwrap();

        assert!(!node_dir.exists(), "original dir must be gone");
        assert!(moved.exists(), "moved-aside dir must exist");
        let name = moved.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.ends_with(".disabled"),
            "must end with .disabled so ComfyUI never loads it, got {name}"
        );
        assert!(moved.join("leftover.txt").exists(), "content preserved");
    }

    #[test]
    fn move_aside_picks_a_fresh_name_when_backup_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let node_dir = tmp.path().join("SomeNode");
        std::fs::create_dir(&node_dir).unwrap();
        // First backup slot already taken
        std::fs::create_dir(tmp.path().join("SomeNode.broken.disabled")).unwrap();

        let moved = move_aside_broken_node_dir(&node_dir).unwrap();

        assert!(!node_dir.exists());
        let name = moved.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "SomeNode.broken2.disabled");
    }

    #[test]
    fn requirements_install_is_a_noop_without_requirements_txt() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        let node = tmp.path().join("comfy/custom_nodes/NoReqs");
        std::fs::create_dir_all(&node).unwrap();

        // No requirements.txt → must succeed without ever spawning pip
        // (an empty fallback python would otherwise be an instant Err).
        assert!(install_node_requirements(&comfy, &node, "NoReqs", "", None).is_ok());
    }

    #[test]
    fn requirements_install_without_python_is_actionable() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        let node = tmp.path().join("comfy/custom_nodes/WithReqs");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::write(node.join("requirements.txt"), "imageio-ffmpeg").unwrap();

        let err = install_node_requirements(&comfy, &node, "WithReqs", "", None).unwrap_err();
        assert!(err.contains("no Python available"), "got: {err}");
    }

    // ── Runde 6, Folgeposten (a): core-package constraints (review Runde 5,
    // F2) ─────────────────────────────────────────────────────────────────

    #[test]
    fn core_constraint_lines_keeps_only_the_core_packages() {
        let freeze = "torch==2.7.0\n\
                      torchvision==0.22.0\n\
                      numpy==1.26.4\n\
                      Pillow==11.0.0\n\
                      comfyui-frontend-package==1.2.3\n\
                      torchaudio==2.7.0\n";
        let lines = core_constraint_lines(freeze);
        assert_eq!(lines, vec!["torch==2.7.0", "torchvision==0.22.0", "numpy==1.26.4", "torchaudio==2.7.0"]);
        // Negative control: neither Pillow nor comfyui-frontend-package,
        // both real ComfyUI-venv packages, may leak into the constraints.
        assert!(!lines.iter().any(|l| l.to_lowercase().starts_with("pillow")));
        assert!(!lines.iter().any(|l| l.to_lowercase().starts_with("comfyui")));
    }

    #[test]
    fn core_constraint_lines_is_empty_for_a_freeze_with_no_core_packages() {
        // Negativkontrolle: a venv that somehow has no torch at all must not
        // invent a pin; an empty result is what tells the caller not to
        // write a constraints file.
        assert!(core_constraint_lines("Pillow==11.0.0\nrequests==2.32.0\n").is_empty());
        assert!(core_constraint_lines("").is_empty());
    }

    #[test]
    fn core_constraint_lines_is_not_fooled_by_a_name_prefix() {
        // "torch" must not match "torchsde" or "torchdiffeq", real
        // dependencies in a ComfyUI venv that are not the core packages this
        // constraints file exists to protect.
        let freeze = "torchsde==0.2.6\ntorchdiffeq==0.2.4\ntorch==2.7.0\n";
        let lines = core_constraint_lines(freeze);
        assert_eq!(lines, vec!["torch==2.7.0"]);
    }

    /// Runde 6, F14 (review Runde 6, Abschnitt 9): a package installed from a
    /// local wheel or a direct URL freezes as a PEP 508 direct reference
    /// (`torch @ file:///...`). pip's own name-splitting still finds "torch"
    /// in that line, so without the `@` check this line would sail into the
    /// constraints file, and pip refuses a `@` line in a constraints file
    /// outright ("links are not allowed as constraints"), failing every
    /// node's install, not only the one that touches torch.
    #[test]
    fn a_direct_url_reference_line_is_skipped_even_though_its_name_matches() {
        let freeze = "torch @ file:///tmp/torch-2.7.0-cp312-cp312-linux_x86_64.whl\n\
                      numpy==1.26.4\n";
        let lines = core_constraint_lines(freeze);
        assert_eq!(lines, vec!["numpy==1.26.4"], "the @ line must not appear in the constraints at all: {lines:?}");
    }

    // ── permission-denied → --user retry (Motion install card, 2026-07-19) ──

    // ── Runde 6, Folgeposten (b): cancel + per-node progress ──────────────

    #[test]
    fn the_node_loop_stops_early_when_cancelled_and_reports_it() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        for name in ["AlphaNode", "BetaNode"] {
            std::fs::create_dir_all(comfy.join("custom_nodes").join(name)).unwrap();
            // No requirements.txt: a node that WOULD succeed instantly if
            // reached, so a green "cancelled" result here is only possible
            // because the loop actually stopped before reaching it.
        }
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut seen: Vec<String> = Vec::new();
        let outcome = reinstall_all_node_requirements(&comfy, "", None, Some(&cancel), |name| seen.push(name.to_string()));

        assert!(outcome.cancelled, "a pre-set cancel flag did not stop the loop");
        assert!(seen.is_empty(), "a node was started after cancel was already set: {seen:?}");
        assert!(outcome.reinstalled.is_empty());
        assert!(outcome.failures.is_empty());
    }

    #[test]
    fn a_negative_control_without_cancel_runs_every_node_and_reports_none_cancelled() {
        // Negativkontrolle for the test above: without a raised flag, every
        // node folder is visited and none is reported as cancelled.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("comfy");
        for name in ["AlphaNode", "BetaNode", "__pycache__", "GammaNode.disabled"] {
            std::fs::create_dir_all(comfy.join("custom_nodes").join(name)).unwrap();
        }
        let mut seen: Vec<String> = Vec::new();
        let outcome = reinstall_all_node_requirements(&comfy, "", None, None, |name| seen.push(name.to_string()));

        assert!(!outcome.cancelled);
        // Deterministic, sorted order; __pycache__ and the disabled node are
        // never real nodes and must not be visited at all.
        assert_eq!(seen, vec!["AlphaNode", "BetaNode"]);
        assert_eq!(outcome.reinstalled, vec!["AlphaNode", "BetaNode"]);
        assert!(outcome.failures.is_empty());
    }

    // ── Runde 6, F13: the second verification gate must run whenever
    // anything was actually installed, even if a DIFFERENT node failed ──────

    #[test]
    fn needs_reverification_is_true_even_when_one_node_also_failed() {
        // The exact F13 case: node A installed cleanly (and could have
        // downgraded a core package), node B failed for its own unrelated
        // reason. The old `failures.is_empty()` gate would have skipped
        // re-verification here solely because of node B, over damage node A
        // may have already done.
        let outcome = NodeReinstallOutcome {
            reinstalled: vec!["AlphaNode".to_string()],
            failures: vec![("BetaNode".to_string(), "pip exited 1".to_string())],
            cancelled: false,
        };
        assert!(outcome.needs_reverification());
    }

    #[test]
    fn needs_reverification_is_false_when_nothing_installed_even_with_failures() {
        // Negative control: every node failed outright, nothing was ever
        // installed, so there is nothing new for a second gate to catch.
        let outcome = NodeReinstallOutcome {
            reinstalled: Vec::new(),
            failures: vec![("BetaNode".to_string(), "pip exited 1".to_string())],
            cancelled: false,
        };
        assert!(!outcome.needs_reverification());
    }

    #[test]
    fn needs_reverification_is_true_on_a_clean_run() {
        let outcome = NodeReinstallOutcome {
            reinstalled: vec!["AlphaNode".to_string()],
            failures: Vec::new(),
            cancelled: false,
        };
        assert!(outcome.needs_reverification());
    }
}

/// Review Runde 2, B1: nothing may delete the Linux git preflight in
/// `install_custom_node_blocking` or move it after the pull or the clone it
/// is meant to guard, without a test going red. Same technique as
/// process_util.rs's `the_argv_matchers_share_one_refresh`.
#[cfg(test)]
mod git_preflight_call_site_guard {
    #[test]
    fn install_custom_node_checks_git_before_pull_and_before_clone() {
        let src = include_str!("custom_nodes.rs");
        let fn_start = src
            .find("fn install_custom_node_blocking(")
            .expect("install_custom_node_blocking is gone from custom_nodes.rs");
        let body = &src[fn_start..];

        let at_preflight = body.find("git_download_preflight()").expect(
            "install_custom_node_blocking no longer calls git_download_preflight(): \
             a fresh Debian 13 or Fedora 43 box without git would clone or pull \
             straight into a cryptic spawn error again",
        );
        let at_pull = body
            .find("\"pull\"")
            .expect("the git pull literal (update branch) is gone from install_custom_node_blocking");
        let at_clone = body
            .find("\"clone\"")
            .expect("the git clone literal (fresh install branch) is gone from install_custom_node_blocking");

        assert!(
            at_preflight < at_pull,
            "git_download_preflight() (byte {at_preflight}) must run before the \
             update pull (byte {at_pull}), not after"
        );
        assert!(
            at_preflight < at_clone,
            "git_download_preflight() (byte {at_preflight}) must run before the \
             fresh clone (byte {at_clone}), not after"
        );
    }
}
