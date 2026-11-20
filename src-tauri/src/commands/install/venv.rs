//! Der Python, in den LU installiert, und was sonst noch darin wohnt.
//!
//! Der geteilte Zustand ist ein Verzeichnis auf der Platte: `ComfyUI/venv`.
//! `resolve_lu_python` zeigt darauf, `create_comfyui_venv` legt es an,
//! `venv_site_packages` findet seine `site-packages` in beiden
//! Plattform-Layouts, und `detect_venv_passengers` liest ab, welche
//! LU-eigenen Pakete darin liegen, die ComfyUI nicht gehören.
//!
//! Genau diese Mitfahrer sind der Grund für die Naht. faster-whisper und
//! Piper landen in ComfyUIs venv, weil das "LUs Python" ist; die Reparatur
//! löscht dieses venv im Ganzen. Wer eines von beidem ändert, muss das
//! andere vor Augen haben, also stehen sie in einer Datei. `probe_python_site`
//! gehört dazu, weil es die Frage beantwortet, in was für einen Python pip
//! gerade schreibt: ein venv bekommt nie `--user` und nie
//! `--break-system-packages`, ein PEP-668-geschütztes System-Python ohne venv
//! bekommt beides.

use std::io::Read;
use std::path::{Path, PathBuf};
use crate::python::python_command;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tracing::warn;

use super::children::{wait_or_cancel, TrackedInstallerChild};
use super::pip::user_site_allowed;
use crate::os_error;
use crate::python::{venv_python_path, venv_python_path_named};
use crate::state::AppState;


// ── PEP 668 / venv helpers (Bug E — a user Arch externally-managed) ─────────

/// Python one-liner behind [`probe_python_site`]. Prints two flags, marker
/// and venv, e.g. `1 0`. The marker is looked up in `sysconfig`'s stdlib dir,
/// which inside a venv still points at the BASE interpreter's stdlib, so the
/// marker of a PEP 668 system Python is visible from a venv built on it.
/// pip itself skips the marker check inside a venv, so the venv flag has to
/// be read here too. `real_prefix` covers the old virtualenv package.
const PYTHON_SITE_PROBE: &str = "import os, sys, sysconfig; \
     d = sysconfig.get_path('stdlib'); \
     m = os.path.exists(os.path.join(d, 'EXTERNALLY-MANAGED')); \
     v = sys.prefix != getattr(sys, 'base_prefix', sys.prefix) or hasattr(sys, 'real_prefix'); \
     print(int(m), int(v))";

/// What [`PYTHON_SITE_PROBE`] found out about one interpreter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PythonSite {
    /// The `EXTERNALLY-MANAGED` marker sits in the (base) stdlib dir.
    pub(crate) externally_managed: bool,
    /// The interpreter is a venv (`sys.prefix != sys.base_prefix`).
    pub(crate) in_venv: bool,
}

impl PythonSite {
    /// True iff this is a PEP 668 protected SYSTEM Python (Arch Linux,
    /// Debian 12+, Fedora 38+, Ubuntu 23.04+ ship Python with an
    /// `EXTERNALLY-MANAGED` marker file in the stdlib dir, which makes
    /// `python -m pip install ...` exit with
    /// `error: externally-managed-environment` unless
    /// `--break-system-packages` is passed). The probe asks Python itself
    /// whether the marker exists, which is robust against distro-specific
    /// path layouts and avoids parsing locale dependent pip error strings.
    ///
    /// A venv is NEVER protected, even when it was built on a protected
    /// system Python (zzammerr, Ubuntu 24.04, 02.10.: the ComfyUI venv saw
    /// the base interpreter's marker, so the voice installs passed `--user`
    /// and pip answered "Can not perform a '--user' install. User
    /// site-packages are not visible in this virtualenv").
    pub(crate) fn pep668_protected(self) -> bool {
        self.externally_managed && !self.in_venv
    }

    /// Extra pip flags for an install into this interpreter. Empty for
    /// everything except a protected system Python, where the user-site
    /// install with the escape hatch is the only way pip will write. A venv
    /// gets neither flag: it needs no escape hatch, and pip refuses `--user`
    /// inside it (see [`user_site_allowed`]).
    pub(crate) fn pip_escape_args(self) -> Vec<&'static str> {
        if self.pep668_protected() && user_site_allowed(self.in_venv) {
            vec!["--break-system-packages", "--user"]
        } else {
            Vec::new()
        }
    }
}

/// Parse the probe's stdout (`"<marker> <venv>"`). `None` for anything else.
fn parse_python_site_probe(stdout: &str) -> Option<PythonSite> {
    let mut it = stdout.split_whitespace();
    let flag = |s: &str| match s {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    };
    let site = PythonSite {
        externally_managed: flag(it.next()?)?,
        in_venv: flag(it.next()?)?,
    };
    it.next().is_none().then_some(site)
}

/// Ask `python_bin` itself whether it is PEP 668 marked and whether it is a
/// venv. `None` on any probe error (Python missing, sysconfig broken, stdout
/// unparseable), which every caller reads as "not protected, not a venv".
/// That is the safe default: the install goes out as a plain `pip install`
/// exactly like on Windows / macOS / Debian 11.
pub(crate) fn probe_python_site(python_bin: &str) -> Option<PythonSite> {
    if python_bin.is_empty() {
        return None;
    }
    let mut cmd = python_command(python_bin);
    cmd.args(["-c", PYTHON_SITE_PROBE])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_python_site_probe(&String::from_utf8_lossy(&out.stdout))
}

/// True iff `python_bin` is a venv interpreter. `false` on any probe error.
pub(crate) fn is_venv_python(python_bin: &str) -> bool {
    probe_python_site(python_bin).is_some_and(|site| site.in_venv)
}

/// The pip flags to append for `python_bin`: one place for every installer
/// that targets "LU's Python", which is the ComfyUI venv when one exists and
/// the system Python otherwise. A failed probe gives no flags at all.
pub(crate) fn pip_escape_args_for(python_bin: &str) -> Vec<&'static str> {
    probe_python_site(python_bin)
        .map(PythonSite::pip_escape_args)
        .unwrap_or_default()
}

/// Create a venv inside `comfyui_dir/venv` using the system `python_bin`.
/// Returns the path to the venv's Python interpreter on success. On Arch
/// boxes that haven't installed the `python-virtualenv` package this can
/// fail with `No module named venv`, and we surface that with an actionable
/// hint pointing at the right pacman / apt invocation.
///
/// `cancel` is read every 200 ms while the child runs, and it has to be:
/// `python -m venv` pulls `ensurepip` in, which is tens of seconds on Windows.
/// P3 (04.09.): cancelling a repair took 76 seconds, and part of that was this
/// call being sat out to the end because it was a single blocking `output()`.
///
/// On a cancel the half-built venv is deleted again before `Err("cancelled")`
/// goes back. `resolve_comfyui_venv_python` asks only whether the interpreter
/// file exists, and `python -m venv` writes that file BEFORE it runs
/// `ensurepip`, so leaving the ruin behind would have autostart launching
/// ComfyUI out of an env with an empty site-packages.
/// Runde 6, B9: this always builds under the fixed name `venv`, never a
/// staging sibling. See [`retire_for_rebuild`]'s doc for why: a venv's own
/// scripts bake in the ABSOLUTE path it was built at, so a venv that is ever
/// going to live at `<comfyui_dir>/venv` has to be BUILT there, not built
/// somewhere else and renamed in afterwards. The repair calls
/// [`retire_for_rebuild`] first when an old venv is in the way, so this
/// always runs against an empty slot.
/// `python -m venv`'s own failure text, stdout and stderr merged into one
/// string, so the hint detection in [`create_comfyui_venv`] sees whichever
/// stream CPython actually chose for a given error (see that function's
/// comment on the `Stdio` setup for the ENG-14 field measurement behind this).
fn venv_failure_text(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

/// The generic sentence for a failed venv build that neither of the two
/// specific hints above recognized.
///
/// Never ends with an empty rest: `python -m venv` can exit non-zero having
/// printed nothing to either stream (killed by a signal before it could write
/// anything, or a distro whose failure mode is silent), and
/// "venv creation failed: " with nothing after the colon told the customer
/// nothing they could act on. The exit code is at least something to search
/// for when there is no text at all.
fn venv_creation_failed_message(combined_output: &str, exit_code: Option<i32>) -> String {
    let snippet: String = combined_output.chars().take(400).collect();
    if snippet.trim().is_empty() {
        return match exit_code {
            Some(code) => format!("venv creation failed with exit code {code} and no output."),
            None => {
                "venv creation failed: the process was terminated by a signal, with no output."
                    .to_string()
            }
        };
    }
    format!("venv creation failed: {snippet}")
}

pub fn create_comfyui_venv(
    comfyui_dir: &Path,
    python_bin: &str,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<PathBuf, String> {
    let venv_name = "venv";
    let venv_dir = comfyui_dir.join(venv_name);
    // venv is idempotent: re-running on an existing dir just no-ops, but be
    // explicit so the log reads cleanly.
    let venv_py_path = venv_python_path_named(comfyui_dir, venv_name);
    let already_existed = venv_dir.exists() && venv_py_path.exists();
    if already_existed {
        return Ok(venv_py_path);
    }

    let mut cmd = python_command(python_bin);
    cmd.args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
        // Both are read, and merged, before the hint below ever looks at the
        // text: measured on a real Ubuntu 22.04 box (E2E report, matrix point
        // 83 / ENG-14), CPython's own `ensurepip` failure, the exact sentence
        // that names `apt install python3.10-venv`, is written with `print()`,
        // which lands on STDOUT, while stderr stays empty. Reading stderr
        // alone (the old behaviour here) made the hint below never fire in
        // that case: the customer saw only "venv creation failed: " with
        // nothing after the colon.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not spawn `python -m venv`: {}", os_error::english(&e)))?;
    // Same registry every other installer child joins, so closing the app
    // mid-build does not leave venv and ensurepip resident.
    let _tracked = TrackedInstallerChild::register(child.id());

    // Drained next to the wait, not after it: a full pipe would stall the
    // child while the loop below thinks it is still working.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stdout_sink = stdout_buf.clone();
    let stderr_sink = stderr_buf.clone();
    let stdout_reader = std::thread::spawn(move || {
        if let Some(mut pipe) = stdout_pipe {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            if let Ok(mut slot) = stdout_sink.lock() {
                *slot = text;
            }
        }
    });
    let stderr_reader = std::thread::spawn(move || {
        if let Some(mut pipe) = stderr_pipe {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            if let Ok(mut slot) = stderr_sink.lock() {
                *slot = text;
            }
        }
    });

    let waited = wait_or_cancel(&mut child, cancel, "`python -m venv`");
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    let stdout = stdout_buf.lock().map(|b| b.clone()).unwrap_or_default();
    let stderr = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

    let exit_status = match waited {
        Ok(s) => s,
        Err(e) if e == "cancelled" => {
            let _ = std::fs::remove_dir_all(&venv_dir);
            return Err(e);
        }
        Err(e) => return Err(e),
    };

    if !exit_status.success() {
        let combined = venv_failure_text(&stdout, &stderr);
        let lower = combined.to_lowercase();
        // Most common Arch / minimal-Python failure: stdlib venv module
        // isn't available because the distro packages it separately.
        if lower.contains("no module named venv") || lower.contains("ensurepip") {
            return Err(format!(
                "Python's `venv` module is not available. Install it first:\n\
                 • Arch:   sudo pacman -S python-virtualenv\n\
                 • Debian/Ubuntu: sudo apt install python3-venv\n\
                 • Fedora: sudo dnf install python3-virtualenv\n\
                 Then retry the ComfyUI install.\n\n--- python output ---\n{}",
                combined.chars().take(400).collect::<String>()
            ));
        }
        return Err(venv_creation_failed_message(&combined, exit_status.code()));
    }

    let venv_py = venv_py_path;
    if !venv_py.exists() {
        return Err(format!(
            "venv was created at {} but no Python binary appeared at {}. \
             This usually means the venv module is broken. Try `sudo pacman -S python-virtualenv` (Arch) or the equivalent on your distro.",
            venv_dir.display(),
            venv_py.display()
        ));
    }
    Ok(venv_py)
}

// ── P3 (04.09.): the old venv is moved out of the way, not deleted in line ──

/// The prefix every set-aside venv carries.
///
/// It starts with `venv` on purpose so it sorts next to the real one for
/// anybody reading the folder, and it is NOT `venv` or `.venv`, which is the
/// whole point: `python.rs::resolve_comfyui_venv_python` looks at exactly
/// those two names, so a retired folder is invisible to the launcher, to
/// autostart and to `resolve_lu_python`.
pub(crate) const RETIRED_VENV_PREFIX: &str = "venv.lu-old-";

/// Runde 5, B7(c), superseded by Runde 6's B9 fix: the name a NEW venv used
/// to be built under while the old `venv` was still live. Nothing this LU
/// version writes carries this prefix any more (see [`retire_for_rebuild`]'s
/// doc for why that approach broke every console script's shebang), but
/// `sweep_retired_venvs` still recognizes and clears it, because a customer
/// upgrading FROM a version that used it can still have one sitting in their
/// ComfyUI folder from an interrupted repair.
pub(crate) const STAGING_VENV_PREFIX: &str = "venv.lu-new-";

/// Nanoseconds plus our own process id, so two runs (or a retired venv and a
/// discarded failed-build venv from the same rebuild) never land on the same
/// folder.
fn stamped_sibling_name(prefix: &str) -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}{}-{}", prefix, stamp, std::process::id())
}

/// Move `<comfy>/venv` out of the way and answer where it went.
///
/// Deleting it in line was the 76 seconds P3 measured: a venv holding PyTorch
/// is tens of thousands of files, `remove_dir_all` walks all of them in one
/// blocking call, and the cancel flag cannot be read inside it. The new name
/// is a sibling in the same parent, so it is on the same drive, so this is one
/// metadata operation no matter how much is inside. The deleting happens
/// afterwards on a worker thread, and the caller is free again the moment this
/// returns.
pub(crate) fn retire_venv(venv_dir: &Path) -> std::io::Result<PathBuf> {
    let parent = venv_dir.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the venv path has no parent directory to move it into",
        )
    })?;
    let retired = parent.join(stamped_sibling_name(RETIRED_VENV_PREFIX));
    std::fs::rename(venv_dir, &retired)?;
    Ok(retired)
}

/// Runde 6, BLOCKER B9 (review Runde 5): a venv is not relocatable. Every
/// console script's shebang (`venv/bin/pip`, `huggingface-cli`, `torchrun`,
/// every `Scripts\*.exe` launcher on Windows) and every `activate` script
/// bakes in the ABSOLUTE path the venv was BUILT at. Runde 5's build-then-
/// swap built the new venv under a staging name and then renamed the folder
/// to `venv` afterwards, a rename `create_comfyui_venv_named` itself never
/// does anything to fix up. Measured on this machine (see the Runde 6 report
/// in `bau/engine.md` for the exact transcript):
///
/// ```text
/// head -1 venv/bin/pip
///   #!/.../venvtest/venv.lu-new-123/bin/python3
/// venv/bin/pip --version
///   bad interpreter: /.../venv.lu-new-12: no such file or directory
/// ```
///
/// LU never noticed, because every one of ITS OWN pip calls goes through
/// `<python> -m pip` (`venv/bin/python` survives the rename fine, since its own
/// `pyvenv.cfg` only points at the BASE interpreter, never at itself), and
/// the last verification ran against the staging name, before the rename.
/// The customer notices the first time they `source venv/bin/activate` by
/// hand, which is exactly how the venv reasonably installs the requirements
/// a repair does not carry over (F2/#72's territory).
///
/// The fix is to never rename a BUILT venv into its final resting place at
/// all: [`retire_for_rebuild`] moves the OLD venv aside FIRST (a rename is
/// still fine there, since it is reversible back to the exact same name, so the
/// path it was originally built at is restored byte-for-byte the moment it
/// is renamed back), and the caller then builds the NEW venv directly under
/// the final `venv` name via [`create_comfyui_venv`], so its build path and
/// its resting path are the same string from the very first `python -m
/// venv` call. Nothing here renames a fully-built venv into a different
/// name than it was created with, ever again.
///
/// `retire_for_rebuild` alone is the "stilllegen" half B9 asks for; the
/// "auf jeden Fehlschlag zurueckrollen" half lives in the caller
/// (`comfy_repair.rs`'s `abort_and_restore`), because only the caller knows
/// whether the NEW venv got far enough to exist at all when a step fails.
pub(crate) fn retire_for_rebuild(venv_dir: &Path) -> Result<Option<PathBuf>, String> {
    if !venv_dir.exists() {
        return Ok(None);
    }
    retire_venv(venv_dir).map(Some).map_err(|e| windows_lock_aware_retire_error(venv_dir, &e))
}

/// Runde 6, B9: on Windows, a process still holding any file inside the old
/// venv open (a ComfyUI process, including one started OUTSIDE LU, exactly
/// the K14 shape this task is measured against) makes `retire_venv`'s
/// rename fail with `ERROR_ACCESS_DENIED` (raw code 5) or
/// `ERROR_SHARING_VIOLATION` (32). The rename itself is one atomic metadata
/// operation, so a failure here has not touched the old venv at all: there
/// is nothing to roll back, but "os error 5" is not a sentence a customer
/// can act on. This turns that specific pair of codes into the one thing
/// they actually need to do about it, and falls back to the general wording
/// for every other failure (permissions, a read-only filesystem, ...).
fn windows_lock_aware_retire_error(venv_dir: &Path, e: &std::io::Error) -> String {
    if cfg!(target_os = "windows") && matches!(e.raw_os_error(), Some(5) | Some(32)) {
        return format!(
            "Could not rebuild the environment: something is still using the existing venv \
             folder at {}. This usually means ComfyUI is still running, including a copy \
             started outside LU. Close ComfyUI first, then retry. Nothing was changed.",
            venv_dir.display(),
        );
    }
    venv_removal_error(venv_dir, e)
}

/// Runde 6, B9: the rollback half of the rebuild. Called on ANY failure from
/// the moment `retire_for_rebuild` has moved the old venv aside up to the
/// moment the new one passes verification: a failed build, a failed
/// download, a failed requirements install, a failed verification, or the
/// user cancelling at any of those points. `retired` is `None` when there
/// was no old venv to begin with (a first install), in which case there is
/// nothing to restore and only a half-built `venv` (if any) is cleared away.
///
/// The half-built `venv` is renamed to a throwaway sibling FIRST, a fast
/// metadata operation that frees the `venv` name immediately, the same
/// reasoning `retire_venv` itself documents for why a rename beats a
/// blocking delete, and only then deleted, on a background thread, so this
/// function returns as soon as the customer's old environment is back,
/// never after walking however many files PyTorch left behind.
///
/// A pure filesystem operation, deliberately not accepting a comfy_dir plus
/// hardcoded child names beyond the one directory it needs to place the
/// throwaway sibling in: this is what makes it directly testable with plain
/// temp directories instead of a real ComfyUI checkout.
pub(crate) fn restore_after_failed_rebuild(comfy_dir: &Path, venv_dir: &Path, retired: Option<PathBuf>) -> Result<(), String> {
    if venv_dir.exists() {
        let discard = comfy_dir.join(stamped_sibling_name("venv.lu-failed-"));
        std::fs::rename(venv_dir, &discard).map_err(|e| venv_removal_error(venv_dir, &e))?;
        std::thread::spawn(move || {
            if let Err(e) = std::fs::remove_dir_all(&discard) {
                warn!(error = %e, folder = %discard.display(), "a failed rebuild's half-built venv could not be deleted");
            }
        });
    }
    if let Some(retired) = retired {
        std::fs::rename(&retired, venv_dir).map_err(|e| {
            format!(
                "Your previous environment could not be restored: {}. It is still on disk at {}; \
                 rename that folder to \"venv\" manually to recover it.",
                venv_removal_error(&retired, &e),
                retired.display(),
            )
        })?;
    }
    Ok(())
}

/// Runde 6, B9: after the new venv (built directly at `venv`, see
/// [`retire_for_rebuild`]'s doc) has PASSED verification, the retired old
/// one is no longer needed. Deleted on a background thread, the same
/// reasoning as the old `swap_in_new_venv`'s deletion, followed by a sweep
/// for any OTHER leftover a previous, interrupted run left behind.
pub(crate) fn finish_rebuild(comfy_dir: &Path, retired: Option<PathBuf>) {
    let sweep_dir = comfy_dir.to_path_buf();
    std::thread::spawn(move || {
        if let Some(retired) = retired {
            if let Err(e) = std::fs::remove_dir_all(&retired) {
                warn!(error = %e, folder = %retired.display(), "the retired venv could not be deleted");
            }
        }
        sweep_retired_venvs(&sweep_dir);
    });
}

/// Runde 6, B9, "Wiederanlauf": if a previous rebuild died between
/// `retire_for_rebuild` and the new venv passing verification (a crash, a
/// power loss, the process being killed), the customer's ComfyUI folder can
/// be left with a `venv.lu-old-*` sibling and NO working `venv` at all
/// (`restore_after_failed_rebuild` never got to run). Runde 6, F12 (review
/// Runde 6): called at the START of every entry point that reads or writes
/// this venv, not only Repair, where it was originally called alone. Install
/// (both the existing-venv and the fresh-venv branch) and Update read
/// `comfy_venv_state`/`venv_python_path` just as directly, and used to read
/// an orphaned rebuild as "no venv" and fall back to the system Python,
/// walking right past a several-gigabyte recoverable folder instead of
/// adopting it back. Called before anything else touches the folder: if
/// there is already a usable venv, this does nothing at all. If there is
/// not, but a retired one exists, the NEWEST retired folder (the one this
/// run's own interrupted attempt would have made) is restored to `venv`
/// before the run continues; any OLDER retired or abandoned staging folder
/// is swept away rather than restored, since it is a leftover from a run
/// even earlier than the crash this is recovering from.
pub(crate) fn restore_orphaned_venv_if_needed(comfy_dir: &Path) {
    if venv_python_path(comfy_dir).exists() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(comfy_dir) else {
        return;
    };
    let mut retired: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with(RETIRED_VENV_PREFIX) || !path.is_dir() {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    if !retired.is_empty() {
        retired.sort_by_key(|(t, _)| *t);
        if let Some((_, newest)) = retired.pop() {
            let venv_dir = comfy_dir.join("venv");
            if let Err(e) = std::fs::rename(&newest, &venv_dir) {
                warn!(error = %e, folder = %newest.display(), "could not restore an orphaned venv left by an interrupted rebuild");
            }
        }
        // Anything older is not restorable to a meaningful state: swept,
        // not adopted.
        for (_, leftover) in retired {
            let _ = std::fs::remove_dir_all(&leftover);
        }
    }
    // Always swept, even when there was no retired folder at all: a
    // customer upgrading FROM the Runde 5 staging approach can still have a
    // `venv.lu-new-*` leftover with nothing to restore it FROM, and that
    // must not be left sitting there just because this run found no
    // RETIRED_VENV_PREFIX folder to act on.
    sweep_retired_venvs(comfy_dir);
}

/// Delete whatever [`retire_venv`] OR an interrupted staging build left
/// lying around.
///
/// Quietly, over tracing only: these are folders nobody is looking for, and a
/// failure to clear one must not colour a repair the user is watching. Every
/// repair runs it on the same worker that deletes its own retired folder, and
/// after that one, so an app that died between a rename and the end of its
/// delete does not keep the space forever and two deleters never meet on the
/// same tree.
///
/// Only names carrying [`RETIRED_VENV_PREFIX`] or [`STAGING_VENV_PREFIX`] are
/// touched. This runs inside the user's ComfyUI folder, next to models,
/// outputs and custom nodes, so the match being too eager is the one way
/// this could destroy something.
pub(crate) fn sweep_retired_venvs(comfy_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(comfy_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ephemeral = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n.starts_with(RETIRED_VENV_PREFIX) || n.starts_with(STAGING_VENV_PREFIX)
        });
        if !ephemeral || !path.is_dir() {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(&path) {
            warn!(error = %e, folder = %path.display(), "a retired or staging venv could not be swept");
        }
    }
}

// ── OI-3: the repair must not silently uninstall Voice ──────────────────────

/// A package LU installs into the ComfyUI venv that is NOT ComfyUI's.
///
/// `resolve_lu_python` sends faster-whisper (STT) and Piper (TTS) into
/// `ComfyUI/venv` whenever one exists, because that is "LU's Python". The
/// repair then deletes that venv wholesale and rebuilds it with PyTorch and
/// ComfyUI's requirements — and nothing else. Two features the user paid
/// bandwidth for disappear as a side effect of a repair they did not ask for
/// (the Create tab fires `repair_comfyui_env` automatically after a ComfyUI
/// startup crash), with not one log line connecting the two. What the user
/// experiences is "Voice just stopped".
///
/// Keeping them out of the venv was the other option and it is worse: LU
/// would have to maintain a second interpreter, and the TTS synthesizer and
/// whisper server both start with whatever `resolve_lu_python` returns, so
/// they would then be started from an env they were not installed into. The
/// venv stays the one Python; the repair takes responsibility for refilling it.
pub(crate) struct VenvPassenger {
    /// The import-name directory as it appears inside `site-packages`.
    pub marker: &'static str,
    /// What to hand pip.
    pub pip_name: &'static str,
    /// What the user calls the feature.
    pub label: &'static str,
}

pub(crate) const VENV_PASSENGERS: [VenvPassenger; 2] = [
    VenvPassenger { marker: "faster_whisper", pip_name: "faster-whisper", label: "Voice input (faster-whisper)" },
    VenvPassenger { marker: "piper", pip_name: "piper-tts", label: "Neural voice output (Piper TTS)" },
];

/// Every `site-packages` a venv can have, across both platform layouts.
/// Pure path math — enumerated rather than guessed, because the Unix minor
/// version (`lib/python3.12`) is whatever built the env.
pub(crate) fn venv_site_packages(venv_dir: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Windows: <venv>/Lib/site-packages
    candidates.push(venv_dir.join("Lib").join("site-packages"));
    // Unix: <venv>/lib/python3.X/site-packages (and lib64 on some distros)
    for lib_name in ["lib", "lib64"] {
        let lib = venv_dir.join(lib_name);
        candidates.push(lib.join("site-packages"));
        if let Ok(entries) = std::fs::read_dir(&lib) {
            for e in entries.flatten() {
                candidates.push(e.path().join("site-packages"));
            }
        }
    }

    // Both probes hit the same directory on a case-insensitive filesystem
    // (macOS, Windows), where `Lib` and `lib` are one directory. Dedupe by
    // canonical path so a caller counting the result gets the number of real
    // site-packages, not the number of spellings that reached them.
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for c in candidates {
        if !c.is_dir() {
            continue;
        }
        let key = std::fs::canonicalize(&c).unwrap_or_else(|_| c.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(c);
    }
    out
}

/// Which LU-owned passengers are in this venv right now. Read BEFORE the venv
/// is deleted; the result is what the repair has to put back.
pub(crate) fn detect_venv_passengers(venv_dir: &Path) -> Vec<&'static VenvPassenger> {
    let site_dirs = venv_site_packages(venv_dir);
    VENV_PASSENGERS
        .iter()
        .filter(|p| site_dirs.iter().any(|d| d.join(p.marker).exists()))
        .collect()
}

// ── Piper neural TTS installer (2026-06-06 — local neural TTS) ──────────

/// Resolve the Python LU's tooling uses: the ComfyUI venv when present, else
/// the resolved system Python. Shared by the faster-whisper + Piper-TTS
/// installers and the TTS synthesizer so they all target the same interpreter.
pub fn resolve_lu_python(state: &AppState) -> String {
    let comfy_dir: Option<PathBuf> = {
        let p = state.comfy_path.lock().unwrap().clone();
        p.map(PathBuf::from)
            .or_else(|| crate::commands::process::find_comfyui_path().map(PathBuf::from))
    };
    let venv_python = comfy_dir
        .as_deref()
        .and_then(crate::python::resolve_comfyui_venv_python);
    if let Some(v) = venv_python {
        return v;
    }
    // System Python: use the cached resolution, but if it's empty/stale —
    // Python may have been installed AFTER launch (Bug B8) — re-resolve once and
    // refresh the cache so install_tts/install_whisper don't wrongly report "no
    // Python found" until the next restart.
    let cached = state.python_bin.lock().map(|g| g.clone()).unwrap_or_default();
    if crate::python::is_real_python(&cached) {
        return cached;
    }
    let resolved = crate::python::get_python_bin();
    if crate::python::is_real_python(&resolved) {
        if let Ok(mut slot) = state.python_bin.lock() {
            *slot = resolved.clone();
        }
    }
    resolved
}

/// The card the user reads when Repair environment cannot delete the old venv.
///
/// A15, Windows Nachlauf 02.09.: this exact sentence carried the German
/// "Der Prozess kann nicht auf die Datei zugreifen, da sie von einem anderen
/// Prozess verwendet wird. (os error 32)" into an English app, because it
/// rendered the `io::Error` itself and Windows answers FormatMessageW in the
/// system language. Split out of the caller so the wording is testable without
/// a locked folder, and without Windows.
pub(crate) fn venv_removal_error(venv_dir: &Path, e: &std::io::Error) -> String {
    format!(
        "Could not remove the old venv at {}: {}. Close anything using it and retry.",
        venv_dir.display(),
        os_error::io_english(e)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── OI-3: the repair must not silently uninstall Voice ────────────────
    //
    // `resolve_lu_python` puts faster-whisper and Piper into ComfyUI's venv,
    // and `repair_comfyui_env` deletes that venv — automatically, after a
    // ComfyUI startup crash the user did not connect to Voice at all.
    // Detection is pure path work, so it is fully testable; the reinstall
    // itself is a pip run and needs a real network.

    fn venv_with_packages(names: &[&str], layout: &str) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let site = match layout {
            "windows" => tmp.path().join("venv").join("Lib").join("site-packages"),
            _ => tmp
                .path()
                .join("venv")
                .join("lib")
                .join("python3.12")
                .join("site-packages"),
        };
        std::fs::create_dir_all(&site).unwrap();
        for n in names {
            std::fs::create_dir_all(site.join(n)).unwrap();
        }
        tmp
    }

    #[test]
    fn both_voice_packages_are_seen_in_a_unix_venv() {
        let tmp = venv_with_packages(&["faster_whisper", "piper", "torch"], "unix");
        let found = detect_venv_passengers(&tmp.path().join("venv"));
        let names: Vec<&str> = found.iter().map(|p| p.pip_name).collect();
        assert_eq!(names, vec!["faster-whisper", "piper-tts"]);
    }

    #[test]
    fn both_voice_packages_are_seen_in_a_windows_venv() {
        // The layout LU's own Windows installs use, checked from a Unix box.
        let tmp = venv_with_packages(&["faster_whisper", "piper"], "windows");
        let found = detect_venv_passengers(&tmp.path().join("venv"));
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn a_venv_without_voice_has_nothing_to_reinstall() {
        // Negative control: a plain ComfyUI venv must not trigger the extra
        // pip runs, or every repair would install Piper on machines that
        // never had it.
        let tmp = venv_with_packages(&["torch", "torchvision"], "unix");
        assert!(detect_venv_passengers(&tmp.path().join("venv")).is_empty());
        // And a venv that does not exist at all reads as empty, not an error:
        // the repair runs on installs that never had one.
        let missing = tempfile::tempdir().unwrap();
        assert!(detect_venv_passengers(&missing.path().join("venv")).is_empty());
    }

    #[test]
    fn only_the_whisper_half_is_detected_when_only_it_is_installed() {
        let tmp = venv_with_packages(&["faster_whisper"], "unix");
        let found = detect_venv_passengers(&tmp.path().join("venv"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pip_name, "faster-whisper");
        assert!(found[0].label.to_lowercase().contains("voice"));
    }

    #[test]
    fn site_packages_are_found_in_both_layouts_and_nowhere_else() {
        let unix = venv_with_packages(&[], "unix");
        assert_eq!(venv_site_packages(&unix.path().join("venv")).len(), 1);
        let win = venv_with_packages(&[], "windows");
        assert_eq!(venv_site_packages(&win.path().join("venv")).len(), 1);
        // A directory that is not a venv has none.
        let plain = tempfile::tempdir().unwrap();
        assert!(venv_site_packages(plain.path()).is_empty());
    }

    // ── Bug E (a user — Arch PEP 668 externally-managed) ─────────────────
    //
    // The detection function spawns a Python subprocess, so we can't unit
    // test it without a Python install. We DO test the safety guarantees:
    // empty `python_bin` returns false (regression-safe default), and the
    // diagnose path surfaces a useful hint when the marker error reaches
    // the user despite the auto-venv path.

    const SYSTEM_PLAIN: PythonSite = PythonSite { externally_managed: false, in_venv: false };
    const SYSTEM_MARKED: PythonSite = PythonSite { externally_managed: true, in_venv: false };
    const VENV_ON_MARKED: PythonSite = PythonSite { externally_managed: true, in_venv: true };
    const VENV_ON_PLAIN: PythonSite = PythonSite { externally_managed: false, in_venv: true };

    #[test]
    fn only_a_marked_system_python_is_pep668_protected() {
        assert!(SYSTEM_MARKED.pep668_protected(), "Ubuntu 24.04 /usr/bin/python3");
        assert!(!VENV_ON_MARKED.pep668_protected(), "ComfyUI venv on Ubuntu 24.04");
        assert!(!SYSTEM_PLAIN.pep668_protected(), "Windows, macOS, old distros");
        assert!(!VENV_ON_PLAIN.pep668_protected(), "ComfyUI venv on Windows or macOS");
    }

    #[test]
    fn pip_escape_args_per_case() {
        // No ComfyUI venv on Ubuntu 24.04, Debian 12, Arch, Fedora 38+.
        assert_eq!(
            SYSTEM_MARKED.pip_escape_args(),
            vec!["--break-system-packages", "--user"]
        );
        // zzammerr: the ComfyUI venv on Ubuntu 24.04. pip refuses `--user`
        // in a venv, so neither flag may appear.
        assert!(VENV_ON_MARKED.pip_escape_args().is_empty());
        // Windows and macOS, with and without a venv: unchanged, no flags.
        assert!(SYSTEM_PLAIN.pip_escape_args().is_empty());
        assert!(VENV_ON_PLAIN.pip_escape_args().is_empty());
    }

    #[test]
    fn no_case_ever_passes_user_into_a_venv() {
        for externally_managed in [false, true] {
            let site = PythonSite { externally_managed, in_venv: true };
            let args = site.pip_escape_args();
            assert!(!args.contains(&"--user"), "{site:?}");
            assert!(!args.contains(&"--break-system-packages"), "{site:?}");
        }
    }

    #[test]
    fn parse_python_site_probe_reads_both_flags() {
        assert_eq!(parse_python_site_probe("1 0\n"), Some(SYSTEM_MARKED));
        assert_eq!(parse_python_site_probe("1 1\r\n"), Some(VENV_ON_MARKED));
        assert_eq!(parse_python_site_probe("0 0\n"), Some(SYSTEM_PLAIN));
        assert_eq!(parse_python_site_probe("0 1"), Some(VENV_ON_PLAIN));
    }

    #[test]
    fn parse_python_site_probe_rejects_anything_else() {
        for junk in ["", "1", "YES", "NO", "garbage", "1 2", "True False", "1 0 1"] {
            assert_eq!(parse_python_site_probe(junk), None, "{junk:?}");
        }
    }

    #[test]
    fn probe_script_asks_for_marker_and_venv() {
        assert!(PYTHON_SITE_PROBE.contains("EXTERNALLY-MANAGED"));
        assert!(PYTHON_SITE_PROBE.contains("base_prefix"));
        assert!(PYTHON_SITE_PROBE.contains("real_prefix"));
    }

    #[test]
    fn a_failed_probe_gives_no_flags_and_no_venv() {
        for bin in ["", "/definitely/not/a/real/python-9.99"] {
            assert_eq!(probe_python_site(bin), None, "{bin:?}");
            assert!(pip_escape_args_for(bin).is_empty(), "{bin:?}");
            assert!(!is_venv_python(bin), "{bin:?}");
        }
    }

    /// A stand-in interpreter that answers every call with one fixed line,
    /// the way [`PYTHON_SITE_PROBE`] would on that kind of Python.
    fn write_fake_python_answering(dir: &std::path::Path, name: &str, answer: &str) -> String {
        #[cfg(not(windows))]
        {
            let path = dir.join(format!("{name}.sh"));
            crate::test_support::write_script(&path, format!("#!/bin/sh\necho {answer}\n"));
            path.to_string_lossy().to_string()
        }
        #[cfg(windows)]
        {
            let path = dir.join(format!("{name}.bat"));
            std::fs::write(&path, format!("@echo off\r\necho {answer}\r\n")).unwrap();
            path.to_string_lossy().to_string()
        }
    }

    #[test]
    fn a_venv_on_a_protected_base_installs_without_user_or_escape_hatch() {
        // zzammerr, Ubuntu 24.04: the target is the ComfyUI venv, the marker
        // of /usr/lib/python3.12 shines through, and the install must still
        // go out as a plain `pip install`.
        let dir = tempfile::tempdir().unwrap();
        let venv = write_fake_python_answering(dir.path(), "fake-venv-python", "1 1");
        assert_eq!(probe_python_site(&venv), Some(VENV_ON_MARKED));
        assert!(pip_escape_args_for(&venv).is_empty());
        assert!(is_venv_python(&venv));
    }

    #[test]
    fn a_protected_system_python_installs_into_the_user_site() {
        // No ComfyUI venv (never installed, or python3-venv is missing):
        // the user site with the escape hatch is the only way in.
        let dir = tempfile::tempdir().unwrap();
        let system = write_fake_python_answering(dir.path(), "fake-system-python", "1 0");
        assert_eq!(probe_python_site(&system), Some(SYSTEM_MARKED));
        assert_eq!(
            pip_escape_args_for(&system),
            vec!["--break-system-packages", "--user"]
        );
        assert!(!is_venv_python(&system));
    }

    // ── ENG-14 (matrix point 83): `python -m venv`'s hint reaches stdout ───
    //
    // Real transcript, e2e/linux/BERICHT-4.md, Punkt 83: on a fresh Ubuntu
    // 22.04 with `python3-venv` missing, `python3 -m venv <dir>` writes its
    // "apt install python3.10-venv" hint to STDOUT and exits 1 with stderr
    // completely empty. `create_comfyui_venv` used to read only stderr, so
    // the hint below (`lower.contains("ensurepip")`) never matched in that
    // exact, measured case, and the customer saw the bare
    // "venv creation failed: " sentence with nothing after the colon.

    /// The exact text from the field measurement, word for word.
    const ENG14_REAL_UBUNTU_STDOUT: &str = "The virtual environment was not created successfully because ensurepip is\nnot available. On Debian/Ubuntu systems, you need to install the\npython3-venv package using the following command.\n\n    apt install python3.10-venv\n";

    #[test]
    fn venv_failure_text_merges_stdout_and_stderr() {
        assert_eq!(venv_failure_text("out", "err"), "out\nerr");
        // The ENG-14 shape: the hint is entirely on stdout, stderr is empty.
        assert_eq!(venv_failure_text(ENG14_REAL_UBUNTU_STDOUT, ""), ENG14_REAL_UBUNTU_STDOUT.trim());
        // The old shape this file always handled: only stderr has text.
        assert_eq!(venv_failure_text("", "boom"), "boom");
        // Negative control: nothing on either stream merges to nothing.
        assert_eq!(venv_failure_text("", ""), "");
    }

    #[test]
    fn venv_creation_failed_message_never_ends_on_an_empty_colon() {
        // The other half of ENG-14: a process that exits non-zero with
        // literally nothing on either stream must still tell the customer
        // something they can act on, not "venv creation failed: ".
        let msg = venv_creation_failed_message("", Some(1));
        assert!(msg.contains("exit code 1"), "{msg}");
        assert!(!msg.trim_end().ends_with(':'), "{msg}");

        // A signal kill (no exit code at all) gets its own honest sentence,
        // still never a bare colon.
        let msg = venv_creation_failed_message("", None);
        assert!(msg.contains("terminated by a signal"), "{msg}");
        assert!(!msg.trim_end().ends_with(':'), "{msg}");

        // Negative control: real output is passed through unchanged, not
        // replaced by the fallback wording.
        let msg = venv_creation_failed_message("ERROR: something broke", Some(1));
        assert_eq!(msg, "venv creation failed: ERROR: something broke");
    }

    /// The body of `create_comfyui_venv`, source lines only.
    ///
    /// Same pattern as `remote.rs`'s `shutdown_body` (KF-1's guard): the two
    /// process tests that would actually catch a regression here
    /// (`eng14_real_env_create_comfyui_venv_against_system_python3` and
    /// `a_venv_failure_with_no_output_at_all_still_names_the_exit_code`) are
    /// both `#[ignore]`'d for the `installer_children_test_lock` reason
    /// documented above, so neither runs in a normal `cargo test`. Without a
    /// standardly-running guard, reverting the one line this whole fix turns
    /// on (`.stdout(Stdio::piped())` back to `.stdout(Stdio::null())`) would
    /// leave every test green and quietly reintroduce ENG-14.
    fn create_comfyui_venv_body() -> String {
        let this_file = include_str!("venv.rs");
        let from = this_file
            .find("pub fn create_comfyui_venv")
            .expect("venv.rs no longer has create_comfyui_venv");
        let body = &this_file[from..];
        let to = body
            .find("\n// ── P3 (04.09.)")
            .expect("venv.rs no longer follows create_comfyui_venv with the P3 retire section");
        body[..to].to_string()
    }

    /// ENG-14's actual regression shape: `Stdio::null()` on stdout instead of
    /// `Stdio::piped()`. The negative control this test answers to is
    /// literal: comment the fix line back to `.stdout(Stdio::null())` (the
    /// state this file was in before commit 09d2c2c5) and this is the ONE
    /// test, of the whole standard suite, that turns red. Before the fix,
    /// `cargo test --bins commands::install::venv::` still reported "32
    /// passed" with the same count as after, because the two tests that
    /// would have caught it are `#[ignore]`'d; with this guard added, the
    /// same reverted line instead fails right here.
    #[test]
    fn create_comfyui_venv_still_pipes_stdout_instead_of_nulling_it() {
        let body = create_comfyui_venv_body();
        assert!(
            body.contains(".stdout(Stdio::piped())"),
            "create_comfyui_venv no longer pipes stdout for `python -m venv`. \
             ENG-14 (matrix point 83): CPython's own ensurepip/venv-module hint, the \
             sentence naming `apt install python3.10-venv`, lands on STDOUT, not \
             stderr, measured live on Ubuntu 22.04. Reading only stderr makes the \
             hint below never fire and the customer sees a bare \
             \"venv creation failed: \" with nothing after the colon."
        );
        assert!(
            !body.contains(".stdout(Stdio::null())"),
            "create_comfyui_venv discards stdout again (`.stdout(Stdio::null())`); \
             see the message above for why that reintroduces ENG-14."
        );
    }

    /// A fake `python3` that ignores its arguments and reproduces exactly
    /// what the real Ubuntu 22.04 box did: the hint on stdout, nothing on
    /// stderr, exit code 1. `create_comfyui_venv` never gets far enough to
    /// look at the venv directory it was asked to build, so this stands in
    /// for the real `python3 -m venv` call end to end.
    #[cfg(not(windows))]
    fn write_fake_python_eng14_stdout_only(dir: &std::path::Path) -> String {
        let path = dir.join("fake-python-eng14.sh");
        crate::test_support::write_script(
            &path,
            format!(
                "#!/bin/sh\ncat <<'EOF'\n{}EOF\nexit 1\n",
                ENG14_REAL_UBUNTU_STDOUT
            ),
        );
        path.to_string_lossy().to_string()
    }

    #[cfg(windows)]
    fn write_fake_python_eng14_stdout_only(dir: &std::path::Path) -> String {
        let path = dir.join("fake-python-eng14.bat");
        // cmd's `echo` cannot carry embedded newlines cleanly; one `echo` per
        // line reproduces the same stdout-only, empty-stderr, exit-1 shape.
        std::fs::write(
            &path,
            "@echo off\r\n\
             echo The virtual environment was not created successfully because ensurepip is\r\n\
             echo not available. On Debian/Ubuntu systems, you need to install the\r\n\
             echo python3-venv package using the following command.\r\n\
             echo(\r\n\
             echo     apt install python3.10-venv\r\n\
             exit /b 1\r\n",
        )
        .unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    #[ignore]
    fn eng14_real_env_create_comfyui_venv_against_system_python3() {
        // The negative control this whole fix answers to: BEFORE it, this
        // test failed because the returned message did not contain
        // "python3-venv" at all (only the bare "venv creation failed: "),
        // since the hint text lived on stdout and only stderr was read.
        //
        // `#[ignore]` for the same reason as `a_venv_nobody_cancels_is_still_built_and_found`
        // below: this registers a real tracked child, and `installer_children_test_lock`
        // only protects against the tests IN THIS FILE that cooperate by
        // taking it. It cannot protect against every OTHER test in the whole
        // binary whose `AppState` drop reaches `shutdown_subprocesses` ->
        // `kill_installer_children`, which SIGKILLs every tracked pid,
        // this fake python's included, process-wide. Under
        // `cargo test --all-targets` that happens often enough to turn the
        // very assertions this test exists for into a false "terminated by a
        // signal, with no output" failure that has nothing to do with ENG-14.
        //
        // Run with: cargo test --bins -- --ignored eng14_real_env
        let _installer_children_guard = crate::commands::install::installer_children_test_lock();
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let fake_python = write_fake_python_eng14_stdout_only(tmp.path());

        let err = create_comfyui_venv(&comfy, &fake_python, None)
            .expect_err("a python3 that always fails must not report success");

        assert!(err.contains("python3-venv"), "the apt hint did not reach the message: {err}");
        assert!(err.contains("apt install python3.10-venv"), "the exact command was lost: {err}");
        assert!(err.contains("ensurepip"), "the wording lost its cause: {err}");
        // The half-built venv folder venv itself never creates (the fake
        // python never touches disk) must not be left behind either.
        assert!(!comfy.join("venv").exists());
    }

    #[test]
    #[ignore]
    fn a_venv_failure_with_no_output_at_all_still_names_the_exit_code() {
        // Negative control on the other axis: a python that fails SILENTLY
        // (neither stream has a word on it) must not fall back to the bare
        // "venv creation failed: " colon either.
        //
        // `#[ignore]` for the same reason as the test above: a real tracked
        // child, vulnerable to any other test's `AppState` drop sweeping it
        // away process-wide.
        //
        // Run with: cargo test --bins -- --ignored a_venv_failure_with_no_output
        let _installer_children_guard = crate::commands::install::installer_children_test_lock();
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        #[cfg(not(windows))]
        let fake_python = {
            let path = tmp.path().join("fake-python-silent.sh");
            crate::test_support::write_script(&path, "#!/bin/sh\nexit 3\n");
            path.to_string_lossy().to_string()
        };
        #[cfg(windows)]
        let fake_python = {
            let path = tmp.path().join("fake-python-silent.bat");
            std::fs::write(&path, "@echo off\r\nexit /b 3\r\n").unwrap();
            path.to_string_lossy().to_string()
        };

        let err = create_comfyui_venv(&comfy, &fake_python, None)
            .expect_err("a python3 that always fails must not report success");

        assert!(err.contains("exit code 3"), "{err}");
        assert!(!err.trim_end().ends_with(':'), "{err}");
    }

    // ── Bug E — LIVE integration test ──────────────────────────────────────
    //
    // Runs against a real Python install with a real EXTERNALLY-MANAGED
    // marker planted in its stdlib. Requires the caller to point
    // `LU_PEP668_TEST_PYTHON` env var at a Python whose stdlib is writable
    // (typically a temp copy of system Python — see
    // `LU-E2E-Test-Kit/scripts/pep668_live_test.ps1` for the setup helper).
    //
    // Skipped by default via `#[ignore]` because:
    // 1. needs a real, modifiable Python install (not safe to mutate the
    //    system Python's stdlib — wedges every pip command on the box).
    // 2. writes to the filesystem and spawns 4-5 Python subprocesses.
    //
    // Run with: `cargo test --release --bins -- --ignored pep668_e2e_live`

    #[test]
    #[ignore]
    fn pep668_e2e_live_detect_and_create_venv() {
        let fake_python = std::env::var("LU_PEP668_TEST_PYTHON")
            .expect("set LU_PEP668_TEST_PYTHON to the fake-python path before running");
        assert!(
            std::path::Path::new(&fake_python).exists(),
            "LU_PEP668_TEST_PYTHON does not exist: {}",
            fake_python
        );

        // The helper script must have planted the marker BEFORE this test
        // runs. If it didn't, the detection should return false — that's
        // also informative, so we don't fail outright here; we just print
        // and check the more interesting assertions.

        // ── Phase 1: PEP 668 detection ──
        let detected = probe_python_site(&fake_python).is_some_and(PythonSite::pep668_protected);
        assert!(
            detected,
            "probe_python_site({}) saw no protected Python. Was the EXTERNALLY-MANAGED \
             marker planted in this Python's stdlib?",
            fake_python
        );
        println!("[live E2E] ✓ probe_python_site detected the marker");

        // ── Phase 2: create_comfyui_venv ──
        let comfy_root = std::env::temp_dir().join("lu-pep668-live-comfyui");
        let _ = std::fs::remove_dir_all(&comfy_root);
        std::fs::create_dir_all(&comfy_root).expect("temp dir create");

        let venv_py = create_comfyui_venv(&comfy_root, &fake_python, None)
            .expect("create_comfyui_venv should succeed against fake python");

        assert!(venv_py.exists(), "venv python at {} should exist", venv_py.display());
        assert!(venv_py.starts_with(&comfy_root), "venv python should be inside comfy dir");
        println!("[live E2E] ✓ create_comfyui_venv produced {}", venv_py.display());

        // ── Phase 3: nested venv's pip should be UNBLOCKED ──
        // The venv has its own site-packages, so PEP 668 doesn't apply to
        // it — this is the whole point of the fix. Verify pip install
        // works inside the nested venv. We use `--dry-run` so we don't
        // actually download anything heavy; the test is whether pip
        // refuses or proceeds.
        let pip_out = std::process::Command::new(venv_py.to_string_lossy().as_ref())
            .args(["-m", "pip", "install", "--dry-run", "--no-input", "pip"])
            .output()
            .expect("nested venv pip should spawn");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&pip_out.stdout),
            String::from_utf8_lossy(&pip_out.stderr)
        );
        assert!(
            !combined.to_lowercase().contains("externally-managed"),
            "nested venv pip was STILL blocked — PEP 668 leaked through. \
             Output:\n{}",
            combined
        );
        assert!(pip_out.status.success(), "nested venv pip exit code != 0:\n{}", combined);
        println!("[live E2E] ✓ nested venv pip runs without PEP 668 block");

        // ── Phase 4: idempotency — second create_comfyui_venv must no-op ──
        let venv_py_again = create_comfyui_venv(&comfy_root, &fake_python, None)
            .expect("second create_comfyui_venv should idempotently return existing venv");
        assert_eq!(venv_py, venv_py_again);
        println!("[live E2E] ✓ create_comfyui_venv is idempotent");

        // Cleanup
        let _ = std::fs::remove_dir_all(&comfy_root);
        println!("[live E2E] ALL ASSERTIONS PASSED");
    }

    /// What code 32 reads as on the machine the test runs on. Windows means
    /// ERROR_SHARING_VIOLATION, which is the code from the box; every unix
    /// errno 32 is EPIPE. Both answers are ours, and neither is read off the
    /// operating system.
    #[cfg(windows)]
    const VENV_BUSY: &str = "the file is in use by another process (os error 32)";

    #[cfg(not(windows))]
    const VENV_BUSY: &str = "broken pipe (os error 32)";

    #[test]
    fn a_venv_held_by_another_process_is_reported_in_our_words() {
        let dir = PathBuf::from("C:\\Users\\alice\\ComfyUI\\venv");
        let e = std::io::Error::from_raw_os_error(32);
        let msg = venv_removal_error(&dir, &e);
        assert_eq!(
            msg,
            format!(
                "Could not remove the old venv at {}: {}. Close anything using it and retry.",
                dir.display(),
                VENV_BUSY
            )
        );
        // The finding itself: on the German box this sentence carried
        // "Der Prozess kann nicht auf die Datei zugreifen ...". Whatever this
        // machine's language calls code 32, that wording is not in here.
        assert!(!msg.contains(&e.to_string()), "the system wording survived: {msg}");
        assert!(msg.is_ascii(), "a localised message would not be ascii: {msg}");
    }

    /// Negative control: an error Rust worded itself is already English, and
    /// rewriting it would only lose the detail it carries.
    #[test]
    fn a_venv_failure_rust_worded_itself_is_passed_through_unchanged() {
        let e = std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the venv path is not a directory",
        );
        let msg = venv_removal_error(Path::new("/tmp/ComfyUI/venv"), &e);
        assert!(msg.contains("the venv path is not a directory"), "got: {msg}");
        assert!(msg.starts_with("Could not remove the old venv at /tmp/ComfyUI/venv: "), "got: {msg}");
    }

    // ── P3 (04.09.): cancelling a repair took 76 seconds ──────────────────
    //
    // Two blocking calls with no way out sat between the click and the stop:
    // `remove_dir_all` over a venv holding PyTorch, and `python -m venv`.
    // These pin the first half. The second half is `wait_or_cancel` in
    // children.rs, which is where its own tests live.

    /// A folder tree with `dirs` subfolders holding `per_dir` files each.
    fn tree_with_files(root: &Path, dirs: usize, per_dir: usize) {
        for d in 0..dirs {
            let sub = root.join(format!("pkg{d}"));
            std::fs::create_dir_all(&sub).unwrap();
            for f in 0..per_dir {
                std::fs::write(sub.join(format!("mod{f}.py")), b"x").unwrap();
            }
        }
    }

    #[test]
    fn retire_venv_moves_the_folder_instead_of_emptying_it() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv = comfy.join("venv");
        tree_with_files(&venv, 3, 4);
        std::fs::write(venv.join("pyvenv.cfg"), b"home = /usr").unwrap();

        let retired = retire_venv(&venv).expect("the venv could not be set aside");

        assert!(!venv.exists(), "the old venv is still at its old name");
        assert!(retired.is_dir(), "the retired folder is not there: {}", retired.display());
        assert_eq!(retired.parent(), Some(comfy.as_path()), "it left the ComfyUI folder");
        assert!(
            retired
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(RETIRED_VENV_PREFIX)),
            "the retired folder does not carry the prefix: {}",
            retired.display()
        );
        // The whole point: nothing was walked, so nothing was lost. This is
        // what separates a rename from a delete, and it is what makes it fast.
        assert!(retired.join("pyvenv.cfg").exists(), "the contents were emptied out");
        for d in 0..3 {
            for f in 0..4 {
                let file = retired.join(format!("pkg{d}")).join(format!("mod{f}.py"));
                assert!(file.exists(), "a file did not survive: {}", file.display());
            }
        }
    }

    #[test]
    fn retiring_a_venv_is_orders_of_magnitude_faster_than_deleting_it() {
        // Self-calibrating rather than a fixed millisecond budget, so it says
        // the same thing on a fast NVMe and on a tired laptop drive: a delete
        // pays per file, a rename does not.
        let tmp = tempfile::tempdir().unwrap();
        let to_delete = tmp.path().join("delete-me").join("venv");
        let to_retire = tmp.path().join("retire-me").join("venv");
        tree_with_files(&to_delete, 40, 100);
        tree_with_files(&to_retire, 40, 100);

        let t0 = std::time::Instant::now();
        std::fs::remove_dir_all(&to_delete).unwrap();
        let deleting = t0.elapsed();

        let t1 = std::time::Instant::now();
        retire_venv(&to_retire).expect("the venv could not be set aside");
        let retiring = t1.elapsed();

        assert!(
            retiring * 10 < deleting,
            "setting aside took {retiring:?} against a delete of {deleting:?}. If the delete \
             itself was too quick to measure, the tree is too small: raise the file count."
        );
        // And in absolute terms, because the promise to the user is a number:
        // the cancel budget is five seconds and this step must not eat it.
        assert!(retiring < std::time::Duration::from_millis(250), "took {retiring:?}");
    }

    #[test]
    fn a_retired_venv_is_invisible_to_everything_that_looks_for_one() {
        // The reason the delete may run in the background at all. If the
        // launcher could still find the folder, a half-deleted venv would be
        // offered to `start_comfyui` and autostart as a working environment.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv = comfy.join("venv");
        let site = venv.join("lib").join("python3.12").join("site-packages");
        std::fs::create_dir_all(site.join("faster_whisper")).unwrap();
        let interpreter = venv_python_path(&comfy);
        std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
        std::fs::write(&interpreter, b"#!/bin/sh\n").unwrap();

        // Before: both finders see it, so the assertions below mean something.
        assert!(crate::python::resolve_comfyui_venv_python(&comfy).is_some());
        assert_eq!(detect_venv_passengers(&venv).len(), 1);

        retire_venv(&venv).expect("the venv could not be set aside");

        assert!(
            crate::python::resolve_comfyui_venv_python(&comfy).is_none(),
            "the launcher still offers a venv that is on its way to the bin"
        );
        assert!(
            detect_venv_passengers(&venv).is_empty(),
            "the passenger scan still reads the retired venv"
        );
    }

    #[test]
    fn the_sweep_takes_only_the_retired_folders() {
        // This runs inside the user's ComfyUI folder. A pattern one character
        // too short takes models with it, so the folders that must SURVIVE
        // are the point of this test.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        for keep in ["venv", "models", "custom_nodes", "output"] {
            std::fs::create_dir_all(comfy.join(keep)).unwrap();
        }
        std::fs::write(comfy.join("requirements.txt"), b"torch\n").unwrap();
        let gone = [
            comfy.join(format!("{RETIRED_VENV_PREFIX}1")),
            comfy.join(format!("{RETIRED_VENV_PREFIX}2")),
        ];
        for g in &gone {
            tree_with_files(g, 2, 2);
        }

        sweep_retired_venvs(&comfy);

        for g in &gone {
            assert!(!g.exists(), "a retired venv survived the sweep: {}", g.display());
        }
        for keep in ["venv", "models", "custom_nodes", "output"] {
            assert!(comfy.join(keep).is_dir(), "the sweep took {keep}");
        }
        assert!(comfy.join("requirements.txt").exists(), "the sweep took requirements.txt");
    }

    #[test]
    fn the_sweep_also_takes_abandoned_staging_folders() {
        // B7(c): a staging venv an interrupted repair never got to swap in is
        // exactly as much of a leftover as a retired one, and the widened
        // sweep is what keeps it from sitting there forever. Same shape as
        // the retired-folder test above, on purpose: one prefix's coverage
        // must not silently stand in for the other's.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        for keep in ["venv", "models", "custom_nodes"] {
            std::fs::create_dir_all(comfy.join(keep)).unwrap();
        }
        let gone = comfy.join(format!("{STAGING_VENV_PREFIX}1"));
        tree_with_files(&gone, 2, 2);

        sweep_retired_venvs(&comfy);

        assert!(!gone.exists(), "an abandoned staging venv survived the sweep: {}", gone.display());
        for keep in ["venv", "models", "custom_nodes"] {
            assert!(comfy.join(keep).is_dir(), "the sweep took {keep}");
        }
    }

    // ── Runde 6, BLOCKER B9: retire-then-build-at-final-name ───────────────
    //
    // Attrappen fuer die vom Auftrag verlangten Faelle: Erfolg,
    // Fehlschlag im Bau, Fehlschlag in der Pruefung, Abbruch, Wiederanlauf,
    // Umbenennen scheitert. Jede benutzt zwei simple Marker-Verzeichnisse
    // statt echter venvs, so wie die Runde-5-Tests es schon taten; der reale
    // Beweis mit echtem `python3 -m venv` steht getrennt unten.

    fn marked_dir(path: &Path, marker: &str) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("marker.txt"), marker.as_bytes()).unwrap();
    }

    fn retired_siblings(comfy: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(comfy)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(RETIRED_VENV_PREFIX))
            })
            .collect()
    }

    #[test]
    fn retire_for_rebuild_moves_the_old_venv_aside_and_frees_the_name() {
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "old");

        let retired = retire_for_rebuild(&venv_dir).expect("retire failed").expect("an old venv should have been reported");

        assert!(!venv_dir.exists(), "venv is still there after retiring");
        assert_eq!(std::fs::read(retired.join("marker.txt")).unwrap(), b"old");
    }

    #[test]
    fn retire_for_rebuild_reports_nothing_when_there_is_no_old_venv() {
        // A first install: nothing to retire, and nothing must be invented.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        assert_eq!(retire_for_rebuild(&venv_dir).unwrap(), None);
    }

    #[test]
    fn erfolg_the_new_venv_stays_and_the_retired_old_one_is_swept_away() {
        // Der Erfolgsfall: retire, "bauen" (Attrappe: der Aufrufer legt die
        // neue venv direkt unter dem finalen Namen an), dann finish_rebuild.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "old");

        let retired = retire_for_rebuild(&venv_dir).unwrap();
        marked_dir(&venv_dir, "new"); // built directly at the final name
        finish_rebuild(&comfy, retired);

        // The delete runs on a background thread; give it a moment, the same
        // way the rest of this file's swap tests always treated deletion as
        // best-effort rather than synchronous.
        for _ in 0..50 {
            if retired_siblings(&comfy).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(std::fs::read(venv_dir.join("marker.txt")).unwrap(), b"new");
        assert!(retired_siblings(&comfy).is_empty(), "the retired old venv was not cleared away");
    }

    #[test]
    fn fehlschlag_im_bau_restores_the_old_venv_when_the_new_one_never_got_built() {
        // Der Bau selbst schlaegt fehl (z. B. `python -m venv` scheitert und
        // raeumt sich, wie create_comfyui_venv es tut, selbst wieder ab): am
        // finalen Pfad liegt gar nichts, nur die stillgelegte alte venv.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "old");

        let retired = retire_for_rebuild(&venv_dir).unwrap();
        assert!(!venv_dir.exists(), "sanity: retiring did not clear the name");
        // The build never produced anything at venv_dir at all.

        restore_after_failed_rebuild(&comfy, &venv_dir, retired).expect("restore failed");

        assert_eq!(std::fs::read(venv_dir.join("marker.txt")).unwrap(), b"old");
        assert!(retired_siblings(&comfy).is_empty(), "a retired sibling is still lying around after the restore");
    }

    #[test]
    fn fehlschlag_in_der_pruefung_discards_the_half_built_venv_and_restores_the_old_one() {
        // Der Bau selbst lief durch, aber `verify_and_heal_environment`
        // scheitert danach: am finalen Pfad liegt eine halb-fertige neue
        // venv, die verworfen werden muss, waehrend die alte zurueckkommt.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "old");

        let retired = retire_for_rebuild(&venv_dir).unwrap();
        marked_dir(&venv_dir, "half-built-new");

        restore_after_failed_rebuild(&comfy, &venv_dir, retired).expect("restore failed");

        assert_eq!(
            std::fs::read(venv_dir.join("marker.txt")).unwrap(),
            b"old",
            "the customer was left with the broken new venv instead of the working old one"
        );
        // The half-built venv is discarded on a background thread; give it a
        // moment, same convention as the success test above.
        for _ in 0..50 {
            let leftover_discard = std::fs::read_dir(&comfy)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_str().is_some_and(|n| n.starts_with("venv.lu-failed-")));
            if !leftover_discard {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            std::fs::read_dir(&comfy)
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_str().is_some_and(|n| n.starts_with("venv.lu-failed-"))),
            "the discarded half-built venv is still on disk"
        );
    }

    #[test]
    fn abbruch_durch_den_nutzer_rolls_back_exactly_like_any_other_failure() {
        // Ein Abbruch durch den Nutzer ist am Dateisystem nicht von einem
        // Fehlschlag zu unterscheiden: beide rufen `restore_after_failed_rebuild`
        // an genau derselben Stelle auf. Dieser Test haelt fest, dass ein
        // Abbruch WAEHREND des Baus (halb-fertige neue venv liegt schon da)
        // genauso sauber zurueckrollt wie ein regulaerer Fehlschlag.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "old");

        let retired = retire_for_rebuild(&venv_dir).unwrap();
        marked_dir(&venv_dir, "half-built-when-cancelled");

        restore_after_failed_rebuild(&comfy, &venv_dir, retired).expect("restore after cancel failed");

        assert_eq!(std::fs::read(venv_dir.join("marker.txt")).unwrap(), b"old");
    }

    #[test]
    fn restore_after_failed_rebuild_with_no_retired_venv_just_clears_the_half_built_one() {
        // Negativkontrolle: ein Fehlschlag bei der ALLERERSTEN Installation
        // (keine alte venv vorhanden, `retired` also `None`) darf nichts
        // erfinden; es bleibt schlicht kein `venv` uebrig.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "half-built-first-install");

        restore_after_failed_rebuild(&comfy, &venv_dir, None).expect("restore failed");

        assert!(!venv_dir.exists(), "a first-install failure invented an old venv to restore");
    }

    #[test]
    fn wiederanlauf_restores_the_newest_retired_venv_when_no_valid_venv_exists() {
        // B9 "Wiederanlauf": ein Absturz zwischen retire_for_rebuild und dem
        // Verifikationstor laesst eine stillgelegte alte venv und KEIN
        // brauchbares `venv` zurueck. Der naechste Start von Repair/Install
        // muss die alte zuerst wiederherstellen, nicht danebenstehen.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        let older = comfy.join(format!("{RETIRED_VENV_PREFIX}1"));
        let newer = comfy.join(format!("{RETIRED_VENV_PREFIX}2"));
        marked_dir(&older, "even-older-crash-leftover");
        std::thread::sleep(std::time::Duration::from_millis(10));
        marked_dir(&newer, "the-one-this-crash-retired");

        restore_orphaned_venv_if_needed(&comfy);

        assert_eq!(
            std::fs::read(comfy.join("venv").join("marker.txt")).unwrap(),
            b"the-one-this-crash-retired",
            "the newest retired venv (the one this crash actually retired) was not restored"
        );
        assert!(!older.exists(), "an older, unrelated retired venv was left instead of swept");
        assert!(!newer.exists(), "the retired folder is still there after being restored");
    }

    #[test]
    fn wiederanlauf_does_nothing_when_a_valid_venv_already_exists() {
        // Negativkontrolle: ein GESUNDER Nutzer darf davon nichts merken. Ein
        // brauchbares `venv` (mit Interpreter-Datei) neben einer retirierten
        // venv ist der normale Zustand kurz vor deren Hintergrund-Loeschung,
        // kein Absturz, und darf nicht angefasst werden.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        marked_dir(&venv_dir, "healthy-current-venv");
        let interpreter = venv_python_path(&comfy);
        std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
        std::fs::write(&interpreter, b"#!/bin/sh\n").unwrap();
        let leftover = comfy.join(format!("{RETIRED_VENV_PREFIX}1"));
        marked_dir(&leftover, "awaiting background deletion");

        restore_orphaned_venv_if_needed(&comfy);

        assert_eq!(std::fs::read(venv_dir.join("marker.txt")).unwrap(), b"healthy-current-venv");
        // Whether the leftover survives this particular call is not the
        // point (its own background delete handles that); the point is that
        // `venv` itself must be completely untouched.
    }

    #[test]
    fn wiederanlauf_sweeps_an_abandoned_staging_folder_from_an_older_lu_version() {
        // Ein Kunde, der von einer aelteren LU-Version mit dem
        // Staging-Ansatz (Runde 5) aktualisiert, kann noch einen
        // `venv.lu-new-*`-Ordner liegen haben. Der neue Wiederanlauf muss
        // ihn wegraeumen statt ihn stehen zu lassen.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();
        let abandoned = comfy.join(format!("{STAGING_VENV_PREFIX}1"));
        marked_dir(&abandoned, "old-lu-version-staging-leftover");

        restore_orphaned_venv_if_needed(&comfy);

        assert!(!abandoned.exists(), "an old staging leftover from before this fix survived");
        assert!(!comfy.join("venv").exists(), "a staging leftover must never be adopted as venv");
    }

    /// Umbenennen scheitert: what code 5 (Windows ERROR_ACCESS_DENIED, the
    /// exact code a held-open ComfyUI process produces) and code 32 (Windows
    /// ERROR_SHARING_VIOLATION) turn into. Runs on every platform because the
    /// function's own `cfg!(target_os = "windows")` check is exercised either
    /// way: off this platform it must fall through to the generic wording
    /// instead of claiming a Windows-only cause.
    #[test]
    fn a_locked_old_venv_gets_a_close_comfyui_message_on_windows_only() {
        let dir = PathBuf::from("C:\\Users\\alice\\ComfyUI\\venv");
        for code in [5, 32] {
            let e = std::io::Error::from_raw_os_error(code);
            let msg = windows_lock_aware_retire_error(&dir, &e);
            if cfg!(target_os = "windows") {
                assert!(msg.contains("Close ComfyUI first"), "code {code}: {msg}");
                assert!(msg.contains("Nothing was changed"), "code {code}: {msg}");
            } else {
                assert!(!msg.contains("Close ComfyUI first"), "code {code} on a non-Windows box: {msg}");
            }
        }
    }

    /// Negative control: an unrelated failure (permissions, a missing
    /// folder) must not get the "close ComfyUI" wording on any platform.
    #[test]
    fn an_unrelated_retire_failure_keeps_the_generic_wording() {
        let dir = PathBuf::from("/tmp/ComfyUI/venv");
        let e = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "permission denied");
        let msg = windows_lock_aware_retire_error(&dir, &e);
        assert!(!msg.contains("Close ComfyUI first"), "{msg}");
        assert!(msg.contains("Could not remove the old venv"), "{msg}");
    }

    #[test]
    fn restoring_a_retired_venv_that_vanished_underneath_us_fails_loudly_instead_of_silently() {
        // Umbenennen scheitert, zweite Form: `retired` existiert laut Aufruf,
        // ist aber tatsaechlich weg (etwa von Hand geloescht zwischen dem
        // Retire und dem Restore). Der Aufrufer darf nie glauben, die alte
        // venv sei zurueck, wenn sie es nicht ist.
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        let venv_dir = comfy.join("venv");
        let phantom_retired = comfy.join(format!("{RETIRED_VENV_PREFIX}vanished"));
        // phantom_retired is deliberately never created.
        std::fs::create_dir_all(&comfy).unwrap();

        let err = restore_after_failed_rebuild(&comfy, &venv_dir, Some(phantom_retired))
            .expect_err("restoring a vanished retired venv must not silently succeed");
        assert!(!err.is_empty());
        assert!(!venv_dir.exists(), "a venv was invented out of nothing");
    }

    /// Runde 6, B9's real proof: an ACTUAL `python3 -m venv`, not a marker
    /// directory. Builds an "old" venv, retires it, builds the new one
    /// directly at the final name the way the fixed `repair_comfyui_env`
    /// now does, and reads `bin/pip`'s shebang back. Before this fix it
    /// would have named a staging folder that no longer existed; after it,
    /// it must name the FINAL path, because that is the only path the new
    /// venv was ever built at.
    #[test]
    #[ignore]
    fn a_rebuilt_venvs_scripts_point_at_the_final_path_not_a_staging_name() {
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live venv checks");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();

        let _old_py = create_comfyui_venv(&comfy, &python, None).expect("the 'old' venv build failed");
        let venv_dir = comfy.join("venv");
        let retired = retire_for_rebuild(&venv_dir).expect("retire failed");

        let new_py = create_comfyui_venv(&comfy, &python, None).expect("the new venv build failed");
        assert_eq!(new_py, venv_python_path(&comfy), "the new venv was not built at the final path");

        #[cfg(not(windows))]
        {
            let pip_path = venv_dir.join("bin").join("pip");
            let shebang = std::fs::read_to_string(&pip_path).expect("bin/pip is missing");
            let final_venv = venv_dir.to_string_lossy().into_owned();
            assert!(
                shebang.contains(&final_venv),
                "bin/pip's shebang does not name the final venv path.\nshebang: {shebang}\nfinal path: {final_venv}"
            );
            let activate = std::fs::read_to_string(venv_dir.join("bin").join("activate")).expect("bin/activate is missing");
            assert!(
                activate.contains(&final_venv),
                "activate's VIRTUAL_ENV does not name the final venv path"
            );
            // And the working end-to-end proof, not just the text: pip itself runs.
            let out = std::process::Command::new(pip_path).arg("--version").output().expect("pip did not even spawn");
            assert!(out.status.success(), "bin/pip does not run: {}", String::from_utf8_lossy(&out.stderr));
        }

        finish_rebuild(&comfy, retired);
    }

    #[test]
    fn creating_a_venv_gives_up_on_a_raised_flag_and_leaves_no_ruin() {
        // Runde 2 Nachlauf: this registers a real tracked child, however
        // briefly, and `state::shutdown_tests` calls the real process-wide
        // `kill_installer_children` under the parallel harness. See
        // `installer_children_test_lock`'s doc comment.
        let _installer_children_guard = crate::commands::install::installer_children_test_lock();
        // The flag is raised before the call, so the outcome is the same on
        // every machine. That the loop keeps reading it WHILE the child runs
        // is the other half, and that is pinned deterministically in
        // children.rs against a child that sleeps two minutes; racing a real
        // `python -m venv` here would only be flaky.
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live venv checks");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        // Half a venv, the way a killed `python -m venv` leaves one: a folder
        // with something in it and no interpreter yet. Planted rather than
        // raced for, because the child dies too fast to build one reliably.
        let half_built = comfy.join("venv").join("lib");
        std::fs::create_dir_all(&half_built).unwrap();
        std::fs::write(half_built.join("half-written"), b"x").unwrap();

        let flag = Arc::new(AtomicBool::new(true));
        let out = create_comfyui_venv(&comfy, &python, Some(&flag));

        assert_eq!(out.err().as_deref(), Some("cancelled"));
        // A cancel that leaves the shell behind is worse than no cancel:
        // `resolve_comfyui_venv_python` asks only whether `venv/bin/python`
        // exists, `python -m venv` writes that file BEFORE the slow part, and
        // autostart would then launch ComfyUI out of an empty env.
        assert!(
            !comfy.join("venv").exists(),
            "the cancelled build left its half-finished venv behind"
        );
        assert!(
            crate::python::resolve_comfyui_venv_python(&comfy).is_none(),
            "the cancelled build left a startable ruin behind"
        );
    }

    #[test]
    #[ignore]
    fn a_venv_nobody_cancels_is_still_built_and_found() {
        // The control that has to stay green: a `create_comfyui_venv` that
        // always answered "cancelled" would pass every test above while
        // killing Repair and Install outright.
        //
        // `#[ignore]` for a reason that is about the product, not about this
        // test. The venv child now joins `INSTALLER_CHILDREN`, and
        // `kill_installer_children` walks that whole registry. Every dropped
        // `AppState` runs `shutdown_subprocesses`, which calls it, and this
        // test binary builds dozens of `AppState`s in parallel with this
        // test. The child then dies mid-build and the run reads as
        // "venv creation failed: " with empty stderr. Correct behaviour on a
        // real quit, unrunnable next to a hundred simulated ones.
        //
        // The everyday guard against "always cancelled" is
        // `a_child_left_alone_still_runs_to_its_own_end` in children.rs, which
        // drives the same wait loop with no registry and no Python.
        //
        // Run with: cargo test --bins -- --ignored --test-threads=1 a_venv_nobody_cancels
        let Some(python) = probe_python() else {
            eprintln!("no usable Python on this box, skipping the live venv checks");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let comfy = tmp.path().join("ComfyUI");
        std::fs::create_dir_all(&comfy).unwrap();

        let down = Arc::new(AtomicBool::new(false));
        let venv_py = create_comfyui_venv(&comfy, &python, Some(&down))
            .expect("a venv nobody cancelled was not built");

        assert!(venv_py.exists(), "no interpreter at {}", venv_py.display());
        assert_eq!(
            crate::python::resolve_comfyui_venv_python(&comfy).as_deref(),
            Some(venv_py.to_string_lossy().as_ref()),
            "the launcher does not find the venv that was just built"
        );
        // And a second call is still a no-op rather than a rebuild.
        assert_eq!(
            create_comfyui_venv(&comfy, &python, None).expect("second call"),
            venv_py
        );
    }

    /// The interpreter to run the two live checks against, or nothing.
    fn probe_python() -> Option<String> {
        let bin = crate::python::get_python_bin();
        (!bin.is_empty() && crate::python::is_real_python(&bin)).then_some(bin)
    }

}
