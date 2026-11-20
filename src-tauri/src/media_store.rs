//! Where the media engines keep what the user downloaded, and the one move
//! that brings it there from where earlier builds put it.
//!
//! Until 3.0.6 the video models and the packs of the second image engine lay
//! under `os_paths::cache_dir()`. On a Mac that is `~/Library/Caches`, a
//! folder the system may empty when the disk runs short and that every
//! cleaning tool empties as a matter of routine: twenty gigabytes of download
//! gone without a word. They are the user's stock, not a cache, and on a Mac
//! they now live beside the engines under `os_paths::data_dir()`
//! (`~/Library/Application Support/<APP_DIR>`).
//!
//! | store | until 3.0.6 (and still on Windows and Linux) | on a Mac now |
//! |---|---|---|
//! | video models | `<cache_dir>/mlx-video/<id>` | `<data_dir>/mlx-video/models/<id>` |
//! | image packs  | `<cache_dir>/mflux/<id>`     | `<data_dir>/mlx/mflux/<id>` |
//!
//! What stays under `cache_dir()` on every system is what can be fetched or
//! computed again and that no model reads once it is installed: the hub's
//! chunk cache (`.hf-cache`) and the engine's own (`.mflux-cache`).
//!
//! Windows and Linux are left exactly as they were: there the two engines do
//! not run at all, and `cache_dir()` is not a folder the system clears.
//!
//! `os_paths::cache_dir()` is called from this file and from nowhere else. A
//! test below holds that, so that the next store does not start out in the
//! folder this one had to be moved out of.

use std::path::{Path, PathBuf};

/// One kind of stock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Store {
    /// The models of `commands::video`.
    Video,
    /// The packs of `commands::mlx`'s second engine.
    Mflux,
}

impl Store {
    pub(crate) const ALL: [Store; 2] = [Store::Video, Store::Mflux];

    /// Its folder under `cache_dir()`: the whole store until 3.0.6, the
    /// scratch of its downloads since.
    fn cache_name(self) -> &'static str {
        match self {
            Store::Video => "mlx-video",
            Store::Mflux => "mflux",
        }
    }

    /// Its folder under `data_dir()` on a Mac, beside the venv of its engine.
    fn stock_path(self) -> [&'static str; 2] {
        match self {
            Store::Video => ["mlx-video", "models"],
            Store::Mflux => ["mlx", "mflux"],
        }
    }
}

/// What lies in a store's folder without being stock: download scratch, and
/// the files the system and this module leave there. A folder that holds
/// nothing else has nothing to move and nothing to read.
const NOT_STOCK: [&str; 4] = [".hf-cache", ".mflux-cache", ".DS_Store", BACKUP_MARKER];

/// Scratch that a whole folder takes along when it moves, and that goes back.
const SCRATCH: [&str; 2] = [".hf-cache", ".mflux-cache"];

/// Folders that hold further entries of their own, one per repository.
/// Two of them are put together entry by entry.
const SHELVES: [&str; 2] = ["_encoders", "_loras"];

/// The two folders of the app everything here is derived from, and whether
/// the rule of the Mac applies. A value and not three calls, so that a test
/// can ask what Windows would do, and give a move a home of its own.
#[derive(Clone, Debug)]
pub(crate) struct Bases {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub macos: bool,
}

impl Bases {
    pub(crate) fn of_this_app() -> Self {
        Self { data: crate::os_paths::data_dir(), cache: crate::os_paths::cache_dir(), macos: cfg!(target_os = "macos") }
    }

    /// Where a store's download scratch lies, on every system. On a Mac this
    /// is also where the store itself lay until 3.0.6.
    pub(crate) fn scratch_root(&self, store: Store) -> PathBuf {
        self.cache.join(store.cache_name())
    }

    /// Where a store belongs.
    pub(crate) fn stock_root(&self, store: Store) -> PathBuf {
        if self.macos {
            let [engine, folder] = store.stock_path();
            self.data.join(engine).join(folder)
        } else {
            self.scratch_root(store)
        }
    }

    /// Where a store is read and written right now. That is where it belongs,
    /// except on a Mac whose stock is still in the old place and could not be
    /// moved: then the old place goes on being the store, whole, until a
    /// later start moves it. Never a part here and a part there.
    pub(crate) fn active_root(&self, store: Store) -> PathBuf {
        let stock = self.stock_root(store);
        let old = self.scratch_root(store);
        if self.macos && has_stock(&old) && !has_stock(&stock) {
            old
        } else {
            stock
        }
    }

    /// The folders that hold gigabytes of models that can be fetched again.
    /// The third is the hub cache of the first image engine, which has been
    /// under `data_dir()` from the start.
    fn model_folders(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = Store::ALL.iter().map(|s| self.stock_root(*s)).collect();
        dirs.push(self.data.join("mlx").join("cache"));
        dirs
    }
}

/// Where `store` is read and written. See [`Bases::active_root`].
pub(crate) fn active_root(store: Store) -> PathBuf {
    Bases::of_this_app().active_root(store)
}

/// Where the download scratch of `store` lies. See [`Bases::scratch_root`].
pub(crate) fn scratch_root(store: Store) -> PathBuf {
    Bases::of_this_app().scratch_root(store)
}

/// The scratch folder for a store that was handed over as `root`: the app's
/// own when `root` is the app's store, `root` itself for any other folder
/// (a test's). On Windows and Linux the two are the same folder.
pub(crate) fn scratch_beside(root: &Path, store: Store) -> PathBuf {
    let bases = Bases::of_this_app();
    if root == bases.stock_root(store) || root == bases.scratch_root(store) {
        bases.scratch_root(store)
    } else {
        root.to_path_buf()
    }
}

fn has_stock(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().any(|e| !NOT_STOCK.iter().any(|name| e.file_name() == *name)))
        .unwrap_or(false)
}

// ── The move ──────────────────────────────────────────────────────────

/// What became of one store at this start.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Nothing in the old place, or no old place on this system.
    Nothing,
    /// The folder moved as one. `links` of its links named the old place and
    /// name the new one now.
    Moved { links: usize },
    /// There was stock in both places. `moved` went over, `left` have a
    /// namesake in the new place and stay where they are, unread.
    Merged { moved: Vec<String>, left: Vec<String>, links: usize },
    /// An install or a generation of this app is running.
    Busy,
    /// A process names the old place on its command line: the download or
    /// the generation of another instance, or of the real run.
    InUse,
    /// The rename was refused (another volume, no permission). Everything is
    /// where it was, and is read from there.
    Failed(String),
}

/// Move the stock under `old` to `new`, by rename and by nothing else: on one
/// volume that is immediate, and across two it is refused and nothing has
/// happened. No file is ever copied and none is ever deleted here.
pub(crate) fn move_store(old: &Path, new: &Path, busy: bool, in_use: &dyn Fn(&Path) -> bool) -> Outcome {
    if old == new || !has_stock(old) {
        return Outcome::Nothing;
    }
    if busy {
        return Outcome::Busy;
    }
    // A link may have been written with either spelling of the old place.
    let old_real = std::fs::canonicalize(old).unwrap_or_else(|_| old.to_path_buf());
    if in_use(old) || (old_real != old && in_use(&old_real)) {
        return Outcome::InUse;
    }
    if let Some(parent) = new.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Outcome::Failed(crate::os_error::english(&e));
        }
    }
    // An empty folder in the new place is in nobody's way. `remove_dir`
    // takes an empty one and refuses any other.
    let _ = std::fs::remove_dir(new);
    if new.exists() {
        return merge(old, &old_real, new);
    }
    if let Err(e) = std::fs::rename(old, new) {
        return Outcome::Failed(crate::os_error::english(&e));
    }
    // The scratch came along and belongs where it was. Should it not go
    // back, it is a few megabytes that nothing reads.
    for name in SCRATCH {
        if new.join(name).exists() && std::fs::create_dir_all(old).is_ok() {
            let _ = std::fs::rename(new.join(name), old.join(name));
        }
    }
    Outcome::Moved { links: repair_links(new, &[old, &old_real], new) }
}

/// Both places hold stock. What the new one lacks goes over. If one rename
/// is refused, the ones before it are taken back, so the store is never
/// split by a failure.
fn merge(old: &Path, old_real: &Path, new: &Path) -> Outcome {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut left: Vec<String> = Vec::new();
    let mut failed = None;
    'entries: for name in stock_names(old) {
        let (from, to) = (old.join(&name), new.join(&name));
        if !to.exists() {
            match std::fs::rename(&from, &to) {
                Ok(()) => moved.push((from, to)),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        } else if SHELVES.contains(&name.as_str()) && from.is_dir() && to.is_dir() {
            for inner in stock_names(&from) {
                let (from, to) = (from.join(&inner), to.join(&inner));
                if to.exists() {
                    left.push(format!("{name}/{inner}"));
                    continue;
                }
                match std::fs::rename(&from, &to) {
                    Ok(()) => moved.push((from, to)),
                    Err(e) => {
                        failed = Some(e);
                        break 'entries;
                    }
                }
            }
        } else {
            left.push(name);
        }
    }
    if let Some(e) = failed {
        for (from, to) in moved.iter().rev() {
            if let Err(back) = std::fs::rename(to, from) {
                tracing::error!(target: "media_store", "could not take {} back to {}: {}", to.display(), from.display(), crate::os_error::english(&back));
            }
        }
        return Outcome::Failed(crate::os_error::english(&e));
    }
    let links = moved.iter().map(|(_, to)| repair_links(to, &[old, old_real], new)).sum();
    // With a slash on every system, as the names in `left` are written: on
    // Windows the path itself says `_encoders\a--old`.
    let name_of = |path: &PathBuf| {
        let inside = path.strip_prefix(new).unwrap_or(path);
        inside.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
    };
    Outcome::Merged { moved: moved.iter().map(|(_, to)| name_of(to)).collect(), left, links }
}

fn stock_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    names.retain(|name| !NOT_STOCK.contains(&name.as_str()));
    names.sort();
    names
}

/// Point every link under `tree` that names a path under one of `old_roots`
/// at the same path under `new_root`, and return how many there were. A
/// relative link moved with its target and is left alone, and so is an
/// absolute one that leads somewhere else.
fn repair_links(tree: &Path, old_roots: &[&Path], new_root: &Path) -> usize {
    let mut repaired = 0;
    // `walkdir` does not follow links unless told to, so a link to a folder
    // is an entry here and not a way out of the tree.
    for entry in walkdir::WalkDir::new(tree).into_iter().filter_map(Result::ok).filter(|e| e.path_is_symlink()) {
        let Ok(target) = std::fs::read_link(entry.path()) else { continue };
        let Some(rest) = old_roots.iter().find_map(|old| target.strip_prefix(old).ok()) else { continue };
        if !target.is_absolute() {
            continue;
        }
        match relink(entry.path(), &new_root.join(rest)) {
            Ok(()) => repaired += 1,
            // `relink` answers in English already (`os_error::english`).
            Err(why) => tracing::warn!(target: "media_store", "the link {} still names the old folder: {why}", entry.path().display()),
        }
    }
    repaired
}

#[cfg(unix)]
fn relink(link: &Path, target: &Path) -> Result<(), String> {
    // Beside the old link first and then over it, so there is no moment in
    // which a failure has left no link at all.
    let mut name = link.file_name().unwrap_or_default().to_os_string();
    name.push(".lu-relink");
    let fresh = link.with_file_name(name);
    let _ = std::fs::remove_file(&fresh);
    std::os::unix::fs::symlink(target, &fresh).map_err(|e| crate::os_error::english(&e))?;
    std::fs::rename(&fresh, link).map_err(|e| {
        let _ = std::fs::remove_file(&fresh);
        crate::os_error::english(&e)
    })
}

#[cfg(not(unix))]
fn relink(_link: &Path, _target: &Path) -> Result<(), String> {
    // No store moves on this system, so there is no link to repair.
    Ok(())
}

/// Whether a process other than this one names `dir` on its command line.
/// The hub downloads carry their target folder there, and the generations
/// their model folder, so this sees the work of a second instance too.
fn named_by_a_process(dir: &Path) -> bool {
    let needle = dir.to_string_lossy().to_string();
    let me = std::process::id();
    let table = crate::process_util::process_table_with_cmdlines();
    table
        .processes()
        .iter()
        .any(|(pid, process)| pid.as_u32() != me && crate::process_util::cmdline_of(process).iter().any(|arg| arg.contains(&needle)))
}

// ── Time Machine ──────────────────────────────────────────────────────

/// Written into a folder once it has been kept out of backups, so it is done
/// once. A user who takes the exclusion off again keeps it off.
const BACKUP_MARKER: &str = ".lu-backup-excluded";

/// Keep a folder of models out of Time Machine: they are tens of gigabytes
/// that the Model Manager fetches again, and a backup disk fills up on them.
/// Does nothing on other systems, for a folder that is not there, and for
/// one that was marked before. Returns whether the folder is marked.
pub(crate) fn keep_out_of_backups(dir: &Path) -> bool {
    if !cfg!(target_os = "macos") || !dir.is_dir() {
        return false;
    }
    let marker = dir.join(BACKUP_MARKER);
    if marker.exists() {
        return true;
    }
    match set_backup_exclusion(dir) {
        Ok(()) => std::fs::write(&marker, b"").is_ok(),
        // `set_backup_exclusion` answers in English already (`os_error::english`).
        Err(why) => {
            tracing::warn!(target: "media_store", "could not keep {} out of Time Machine: {why}", dir.display());
            false
        }
    }
}

/// The attribute `tmutil addexclusion` writes, with the value it writes: the
/// binary property list of the string `com.apple.backupd`. It travels with
/// the folder when that is renamed.
#[cfg(target_os = "macos")]
const BACKUP_ATTRIBUTE: &std::ffi::CStr = c"com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_VALUE: &[u8] = b"bplist00\x5f\x10\x11com.apple.backupd\x08\x00\x00\x00\x00\x00\x00\x01\x01\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x1c";

#[cfg(target_os = "macos")]
fn set_backup_exclusion(dir: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // SAFETY: both strings end in a zero byte and outlive the call, and the
    // value is passed with its own length.
    let rc = unsafe { libc::setxattr(path.as_ptr(), BACKUP_ATTRIBUTE.as_ptr(), BACKUP_VALUE.as_ptr().cast(), BACKUP_VALUE.len(), 0, 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(crate::os_error::english(&std::io::Error::last_os_error()))
    }
}

#[cfg(not(target_os = "macos"))]
fn set_backup_exclusion(_dir: &Path) -> Result<(), String> {
    Ok(())
}

// ── At the start of the app ───────────────────────────────────────────

/// Bring the stock of earlier builds to where it belongs, and keep the model
/// folders out of backups. Once at the start of the app, before a command
/// can read a model folder, and at the start of the real run.
///
/// `busy` says whether an install or a generation of this app is running on
/// a store. At the start of the app none is, and the answer is asked for all
/// the same: this must not become the function that moved a folder from
/// under a download because somebody called it later.
pub(crate) fn settle(busy: &dyn Fn(Store) -> bool) {
    let bases = Bases::of_this_app();
    if bases.macos {
        for store in Store::ALL {
            let (old, new) = (bases.scratch_root(store), bases.stock_root(store));
            report(store, &old, &new, &move_store(&old, &new, busy(store), &named_by_a_process));
        }
    }
    for dir in bases.model_folders() {
        keep_out_of_backups(&dir);
    }
}

/// [`settle`] with the app's own slots.
pub(crate) fn settle_at_start(state: &crate::state::AppState) {
    settle(&|store| busy_in(state, store));
}

/// Whether this app is installing into a store or generating from it. The
/// second image engine generates in a process of its own, which
/// [`named_by_a_process`] sees.
fn busy_in(state: &crate::state::AppState, store: Store) -> bool {
    match store {
        Store::Video => {
            state.install_video_model().is_running()
                || state.install_mlx_video().is_running()
                || state.video_process().lock().map(|child| child.is_some()).unwrap_or(true)
        }
        Store::Mflux => state.install_mlx_image_model().is_running(),
    }
}

fn report(store: Store, old: &Path, new: &Path, outcome: &Outcome) {
    let (old, new) = (old.display(), new.display());
    match outcome {
        Outcome::Nothing => {}
        Outcome::Moved { links } => {
            tracing::info!(target: "media_store", "moved the {store:?} models from {old} to {new} ({links} link(s) repaired)")
        }
        Outcome::Merged { moved, left, links } => {
            tracing::info!(target: "media_store", "moved {} of the {store:?} models from {old} to {new} ({links} link(s) repaired)", moved.len());
            if !left.is_empty() {
                tracing::warn!(target: "media_store", "{} is in both {old} and {new}; the copy in {old} is not read and was left alone", left.join(", "));
            }
        }
        Outcome::Busy => {
            tracing::warn!(target: "media_store", "the {store:?} models stay in {old} for now: an install or a generation is running")
        }
        Outcome::InUse => {
            tracing::warn!(target: "media_store", "the {store:?} models stay in {old} for now: a running process is using that folder")
        }
        Outcome::Failed(why) => {
            tracing::warn!(target: "media_store", "the {store:?} models could not be moved from {old} to {new} and are read from {old}: {why}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(path: PathBuf) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    /// A home of the test's own, laid out like a Mac's.
    fn mac(tag: &str) -> (crate::os_paths::TestDir, Bases) {
        let home = crate::os_paths::test_dir(tag);
        let bases = Bases {
            data: home.join("Library").join("Application Support").join(crate::app_identity::APP_DIR),
            cache: home.join("Library").join("Caches").join(crate::app_identity::APP_DIR),
            macos: true,
        };
        (home, bases)
    }

    fn idle(_: &Path) -> bool {
        false
    }

    fn settle_in(bases: &Bases, store: Store) -> Outcome {
        move_store(&bases.scratch_root(store), &bases.stock_root(store), false, &idle)
    }

    // ── Where ─────────────────────────────────────────────────────────

    #[test]
    fn on_a_mac_the_stock_is_under_the_data_folder_and_the_scratch_under_the_cache() {
        let (_home, bases) = mac("store-where-mac");
        assert_eq!(bases.stock_root(Store::Video), bases.data.join("mlx-video").join("models"));
        assert_eq!(bases.stock_root(Store::Mflux), bases.data.join("mlx").join("mflux"));
        for store in Store::ALL {
            assert!(bases.stock_root(store).starts_with(&bases.data));
            assert!(!bases.stock_root(store).starts_with(&bases.cache));
            assert!(bases.scratch_root(store).starts_with(&bases.cache));
            assert_eq!(bases.active_root(store), bases.stock_root(store), "an empty Mac starts in the new place");
        }
    }

    #[test]
    fn windows_and_linux_keep_the_folders_they_had() {
        let (_home, mut bases) = mac("store-where-other");
        bases.macos = false;
        assert_eq!(bases.stock_root(Store::Video), bases.cache.join("mlx-video"));
        assert_eq!(bases.stock_root(Store::Mflux), bases.cache.join("mflux"));
        for store in Store::ALL {
            let root = bases.stock_root(store);
            assert_eq!(bases.scratch_root(store), root);
            put(root.join("some-model").join("model.safetensors"));
            assert_eq!(bases.active_root(store), root);
            // Old place and new place are one folder: there is nothing to move.
            assert_eq!(move_store(&bases.scratch_root(store), &root, false, &idle), Outcome::Nothing);
            assert!(root.join("some-model").join("model.safetensors").is_file());
        }
    }

    /// The app's own folders, on the system the test runs on.
    #[test]
    fn the_app_follows_the_rule_of_its_system() {
        let (data, cache) = (crate::os_paths::data_dir(), crate::os_paths::cache_dir());
        for (store, on_mac, elsewhere) in [
            (Store::Video, data.join("mlx-video").join("models"), cache.join("mlx-video")),
            (Store::Mflux, data.join("mlx").join("mflux"), cache.join("mflux")),
        ] {
            let stock = Bases::of_this_app().stock_root(store);
            assert_eq!(stock, if cfg!(target_os = "macos") { on_mac } else { elsewhere });
            assert_eq!(scratch_root(store), cache.join(store.cache_name()));
            assert_eq!(scratch_beside(&stock, store), scratch_root(store));
        }
        let other = Path::new("some").join("folder");
        assert_eq!(scratch_beside(&other, Store::Mflux), other);
    }

    // ── The move ──────────────────────────────────────────────────────

    /// The owner's Mac on 09.10.2026, as empty files: a converted model, a
    /// download that was stopped, a pack, and the scratch of both.
    fn owners_mac(bases: &Bases) -> Vec<(Store, &'static str)> {
        let files = vec![
            (Store::Video, "wan21-t2v-1.3b/mlx/model.safetensors"),
            (Store::Video, "wan21-t2v-1.3b/.lu-converted"),
            (Store::Video, "ltx-2.3-q4/.lu-installing"),
            (Store::Video, "ltx-2.3-q4/connector.safetensors"),
            (Store::Video, "ltx-2.3-q4/.cache/huggingface/download/transformer.safetensors.incomplete"),
            (Store::Mflux, "qwen-image-2.1-4bit/transformer/0.safetensors"),
            (Store::Mflux, "qwen-image-2.1-4bit/.lu-pack.json"),
        ];
        for (store, file) in &files {
            put(bases.scratch_root(*store).join(file));
        }
        put(bases.scratch_root(Store::Video).join(".hf-cache").join("xet").join("chunk"));
        put(bases.scratch_root(Store::Video).join(".hf-cache").join("hub").join("models--x").join("refs").join("main"));
        put(bases.scratch_root(Store::Mflux).join(".hf-cache").join("xet").join("chunk"));
        files
    }

    #[test]
    fn the_stock_of_an_earlier_build_moves_and_its_scratch_stays() {
        let (_home, bases) = mac("store-move");
        let files = owners_mac(&bases);
        for store in Store::ALL {
            assert_eq!(bases.active_root(store), bases.scratch_root(store), "before the move the old place is the store");
            assert_eq!(settle_in(&bases, store), Outcome::Moved { links: 0 });
            assert_eq!(bases.active_root(store), bases.stock_root(store));
            assert!(!has_stock(&bases.scratch_root(store)), "stock was left in the cache");
            assert!(bases.scratch_root(store).join(".hf-cache").join("xet").join("chunk").is_file(), "the chunk cache did not stay");
            assert!(!bases.stock_root(store).join(".hf-cache").exists(), "the chunk cache moved in with the models");
        }
        for (store, file) in files {
            assert!(bases.stock_root(store).join(file).is_file(), "{file} did not arrive");
        }
        // A second start finds nothing to do and breaks nothing.
        for store in Store::ALL {
            assert_eq!(settle_in(&bases, store), Outcome::Nothing);
        }
        assert!(bases.stock_root(Store::Video).join("wan21-t2v-1.3b").join("mlx").join("model.safetensors").is_file());
    }

    #[test]
    fn nothing_moves_while_this_app_is_at_work_on_the_store() {
        let (_home, bases) = mac("store-busy");
        let files = owners_mac(&bases);
        let state = std::mem::ManuallyDrop::new(crate::state::AppState::new());
        assert!(!busy_in(&state, Store::Video) && !busy_in(&state, Store::Mflux));

        let video = state.install_video_model();
        assert!(video.try_start());
        assert!(busy_in(&state, Store::Video), "a running model install does not count as busy");
        assert!(!busy_in(&state, Store::Mflux), "one store's install holds the other back");
        let image = state.install_mlx_image_model();
        assert!(image.try_start());
        assert!(busy_in(&state, Store::Mflux));

        for store in Store::ALL {
            let (old, new) = (bases.scratch_root(store), bases.stock_root(store));
            assert_eq!(move_store(&old, &new, busy_in(&state, store), &idle), Outcome::Busy);
            assert!(!new.exists());
            assert_eq!(bases.active_root(store), old, "the store is not read where it is");
        }
        for (store, file) in &files {
            assert!(bases.scratch_root(*store).join(file).is_file(), "{file} moved from under the install");
        }

        video.complete("done");
        image.complete("done");
        let engine = state.install_mlx_video();
        assert!(engine.try_start());
        assert!(busy_in(&state, Store::Video), "a running engine install does not count as busy");
        engine.complete("done");
        for store in Store::ALL {
            assert!(!busy_in(&state, store));
            assert_eq!(move_store(&bases.scratch_root(store), &bases.stock_root(store), busy_in(&state, store), &idle), Outcome::Moved { links: 0 });
        }
    }

    #[test]
    fn nothing_moves_while_a_process_names_the_folder() {
        let (_home, bases) = mac("store-in-use");
        owners_mac(&bases);
        let (old, new) = (bases.scratch_root(Store::Mflux), bases.stock_root(Store::Mflux));
        let asked = std::cell::RefCell::new(Vec::new());
        let named = |dir: &Path| {
            asked.borrow_mut().push(dir.to_path_buf());
            true
        };
        assert_eq!(move_store(&old, &new, false, &named), Outcome::InUse);
        assert_eq!(asked.borrow()[0], old);
        assert!(old.join("qwen-image-2.1-4bit").join("transformer").join("0.safetensors").is_file() && !new.exists());
    }

    /// The real check, against a real process: one that carries the folder
    /// on its command line the way a hub download does.
    #[cfg(unix)]
    #[test]
    fn a_running_process_that_names_the_folder_is_seen() {
        let (_home, bases) = mac("store-process");
        let old = bases.scratch_root(Store::Video);
        put(old.join("some-model").join("model.safetensors"));
        assert!(!named_by_a_process(&old));
        let mut child = std::process::Command::new("/bin/sh")
            // Two commands, so the shell stays and does not become `sleep`.
            .args(["-c", "sleep 30; true", "lu-store-test"])
            .arg(old.join("some-model"))
            .spawn()
            .unwrap();
        let seen = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            named_by_a_process(&old)
        });
        let outcome = move_store(&old, &bases.stock_root(Store::Video), false, &named_by_a_process);
        let _ = child.kill();
        let _ = child.wait();
        assert!(seen, "the process was not found by the folder on its command line");
        assert_eq!(outcome, Outcome::InUse);
        assert!(old.join("some-model").join("model.safetensors").is_file());
    }

    #[test]
    fn a_refused_rename_leaves_everything_where_it_was_and_readable() {
        let (_home, bases) = mac("store-refused");
        let files = owners_mac(&bases);
        // A file where the parent of the new place has to be: the rename
        // cannot happen, as it cannot across two volumes.
        put(bases.data.join("mlx-video"));
        let outcome = settle_in(&bases, Store::Video);
        assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
        assert_eq!(bases.active_root(Store::Video), bases.scratch_root(Store::Video));
        for (store, file) in files {
            assert!(bases.scratch_root(store).join(file).is_file(), "{file} is gone");
        }
    }

    #[test]
    fn stock_in_both_places_is_put_together_and_nothing_is_overwritten() {
        let (_home, bases) = mac("store-merge");
        let (old, new) = (bases.scratch_root(Store::Video), bases.stock_root(Store::Video));
        put(old.join("only-old").join("model.safetensors"));
        put(old.join("in-both").join("old.safetensors"));
        put(old.join("_encoders").join("a--old").join("config.json"));
        put(old.join("_encoders").join("a--both").join("old.json"));
        put(old.join(".hf-cache").join("xet").join("chunk"));
        put(new.join("in-both").join("new.safetensors"));
        put(new.join("_encoders").join("a--both").join("new.json"));

        let outcome = settle_in(&bases, Store::Video);
        assert_eq!(
            outcome,
            Outcome::Merged {
                moved: vec!["_encoders/a--old".to_string(), "only-old".to_string()],
                left: vec!["_encoders/a--both".to_string(), "in-both".to_string()],
                links: 0
            }
        );
        assert!(new.join("only-old").join("model.safetensors").is_file());
        assert!(new.join("_encoders").join("a--old").join("config.json").is_file());
        // Both copies of a name that is in both are whole and apart.
        assert!(new.join("in-both").join("new.safetensors").is_file() && !new.join("in-both").join("old.safetensors").exists());
        assert!(old.join("in-both").join("old.safetensors").is_file());
        assert!(old.join("_encoders").join("a--both").join("old.json").is_file());
        assert!(new.join("_encoders").join("a--both").join("new.json").is_file());
        assert!(old.join(".hf-cache").join("xet").join("chunk").is_file());
        assert_eq!(bases.active_root(Store::Video), new);
    }

    #[cfg(unix)]
    #[test]
    fn a_merge_that_fails_half_way_takes_back_what_it_moved() {
        use std::os::unix::fs::PermissionsExt;
        let (_home, bases) = mac("store-merge-back");
        let (old, new) = (bases.scratch_root(Store::Video), bases.stock_root(Store::Video));
        put(old.join("a-model").join("model.safetensors"));
        put(old.join("_encoders").join("b--enc").join("config.json"));
        // The shelf in the new place cannot be written to, the folder can.
        // The names go over in order: `0-model` moves, then the encoder is
        // refused, and `a-model` is never reached.
        put(old.join("0-model").join("model.safetensors"));
        put(new.join("_encoders").join("other").join("config.json"));
        put(new.join("z-model").join("model.safetensors"));
        let shelf = new.join("_encoders");
        std::fs::set_permissions(&shelf, std::fs::Permissions::from_mode(0o555)).unwrap();
        let outcome = settle_in(&bases, Store::Video);
        std::fs::set_permissions(&shelf, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
        assert!(old.join("0-model").join("model.safetensors").is_file(), "what had moved was not taken back");
        assert!(old.join("a-model").join("model.safetensors").is_file());
        assert!(old.join("_encoders").join("b--enc").join("config.json").is_file());
        assert!(!new.join("0-model").exists() && !new.join("a-model").exists());
    }

    // ── Links ─────────────────────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn links_that_named_the_old_place_name_the_new_one_and_the_others_are_left_alone() {
        use std::os::unix::fs::symlink;
        let (home, bases) = mac("store-links");
        let (old, new) = (bases.scratch_root(Store::Mflux), bases.stock_root(Store::Mflux));
        let blob = old.join("pack").join("blobs").join("abc");
        put(blob.clone());
        let outside = home.join("elsewhere").join("ffmpeg");
        put(outside.clone());
        let snapshot = old.join("pack").join("snapshots").join("rev");
        std::fs::create_dir_all(&snapshot).unwrap();
        // The way the hub links a snapshot to its blob: relative.
        symlink(Path::new("..").join("..").join("blobs").join("abc"), snapshot.join("relative.safetensors")).unwrap();
        // Absolute into the store, by the path as given and by its real one
        // (under a test the temp folder is itself behind a link on a Mac).
        symlink(&blob, snapshot.join("absolute.safetensors")).unwrap();
        let real_blob = std::fs::canonicalize(&blob).unwrap();
        symlink(&real_blob, snapshot.join("absolute-real.safetensors")).unwrap();
        // Absolute to a folder inside the store, and absolute out of it.
        symlink(old.join("pack").join("blobs"), old.join("pack").join("blobs-link")).unwrap();
        symlink(&outside, old.join("pack").join("ffmpeg")).unwrap();

        assert_eq!(settle_in(&bases, Store::Mflux), Outcome::Moved { links: 3 });

        let snapshot = new.join("pack").join("snapshots").join("rev");
        let new_blob = new.join("pack").join("blobs").join("abc");
        assert_eq!(std::fs::read_link(snapshot.join("relative.safetensors")).unwrap(), Path::new("..").join("..").join("blobs").join("abc"));
        assert_eq!(std::fs::read_link(snapshot.join("absolute.safetensors")).unwrap(), new_blob);
        assert_eq!(std::fs::read_link(snapshot.join("absolute-real.safetensors")).unwrap(), new_blob);
        assert_eq!(std::fs::read_link(new.join("pack").join("blobs-link")).unwrap(), new.join("pack").join("blobs"));
        assert_eq!(std::fs::read_link(new.join("pack").join("ffmpeg")).unwrap(), outside);
        // Every link leads to a file that is there.
        for link in ["relative.safetensors", "absolute.safetensors", "absolute-real.safetensors"] {
            assert!(snapshot.join(link).is_file(), "{link} is broken");
        }
        assert!(new.join("pack").join("blobs-link").join("abc").is_file());
        assert!(new.join("pack").join("ffmpeg").is_file());
        assert!(!walkdir::WalkDir::new(&new).into_iter().flatten().any(|e| e.file_name().to_string_lossy().ends_with(".lu-relink")));
    }

    // ── Time Machine ──────────────────────────────────────────────────

    #[cfg(target_os = "macos")]
    fn backup_attribute_of(dir: &Path) -> Option<Vec<u8>> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).unwrap();
        let mut value = vec![0u8; 256];
        // SAFETY: the buffer is as long as the length that is passed.
        let n = unsafe { libc::getxattr(path.as_ptr(), BACKUP_ATTRIBUTE.as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
        (n >= 0).then(|| value[..n as usize].to_vec())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_model_folder_is_kept_out_of_time_machine_once_and_stays_so_when_it_moves() {
        let (_home, bases) = mac("store-backup");
        owners_mac(&bases);
        let old = bases.scratch_root(Store::Video);
        assert!(!keep_out_of_backups(&bases.stock_root(Store::Video)), "a folder that is not there was marked");
        assert_eq!(backup_attribute_of(&old), None);
        assert!(keep_out_of_backups(&old));
        assert_eq!(backup_attribute_of(&old).as_deref(), Some(BACKUP_VALUE));
        // What `tmutil addexclusion` writes is the 61 bytes of this list.
        assert_eq!(BACKUP_VALUE.len(), 61);
        assert!(BACKUP_VALUE.starts_with(b"bplist00") && BACKUP_VALUE.windows(17).any(|w| w == b"com.apple.backupd"));

        // The attribute and the marker go with the folder, and the marker is
        // not taken for a model.
        assert_eq!(settle_in(&bases, Store::Video), Outcome::Moved { links: 0 });
        let new = bases.stock_root(Store::Video);
        assert_eq!(backup_attribute_of(&new).as_deref(), Some(BACKUP_VALUE));
        assert!(new.join(BACKUP_MARKER).is_file());
        assert!(!has_stock(&old));

        // Taken off by the user: it stays off.
        let path = std::ffi::CString::new(new.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: both strings end in a zero byte and outlive the call.
        assert_eq!(unsafe { libc::removexattr(path.as_ptr(), BACKUP_ATTRIBUTE.as_ptr(), 0) }, 0);
        assert!(keep_out_of_backups(&new));
        assert_eq!(backup_attribute_of(&new), None);
    }

    #[test]
    fn a_folder_with_nothing_but_scratch_and_the_marker_holds_no_stock() {
        let (_home, bases) = mac("store-empty");
        let old = bases.scratch_root(Store::Mflux);
        for name in NOT_STOCK {
            put(old.join(name).join("x"));
        }
        assert!(!has_stock(&old));
        assert_eq!(settle_in(&bases, Store::Mflux), Outcome::Nothing);
        assert!(!bases.stock_root(Store::Mflux).exists());
        assert!(SCRATCH.iter().all(|name| NOT_STOCK.contains(name)));
    }

    // ── The guard ─────────────────────────────────────────────────────

    /// The cache folder of the system is asked for in `os_paths` and used
    /// here. A model, a pack, a LoRA or an output that is put under it
    /// anywhere else is deleted by the next cleaning tool on a Mac. What is
    /// download scratch goes through `scratch_root` above; what the user
    /// would miss goes under `os_paths::data_dir()`.
    #[test]
    fn no_other_file_reaches_for_the_cache_folder() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let allowed = ["os_paths.rs", "media_store.rs"];
        // A line that names the folder without keeping anything in it. The
        // agent's file tools list the app's own folders as closed to the
        // agent, and the cache folder is one of them.
        let named_only = [("commands/filesystem.rs", "crate::os_paths::cache_dir(),")];
        let call = ["cache", "_dir("].concat();
        let mut found: Vec<String> = Vec::new();
        let mut files = 0;
        for entry in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
        {
            files += 1;
            let name = entry.path().strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
            if allowed.contains(&name.as_str()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            for (n, line) in text.lines().enumerate() {
                let code = line.trim_start();
                if code.starts_with("//") {
                    continue;
                }
                // The call itself, not a function whose name ends in it.
                let calls = code.match_indices(&call).any(|(at, _)| !code[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_'));
                if calls && !named_only.contains(&(name.as_str(), code.trim_end())) {
                    found.push(format!("{name}:{}: {}", n + 1, code));
                }
            }
        }
        assert!(files > 50, "the sources were not found under {}", src.display());
        assert!(
            found.is_empty(),
            "the cache folder is used outside media_store. On a Mac it is emptied by the system and by cleaning tools: \
             models and other things the user would miss belong under os_paths::data_dir(), download scratch goes \
             through media_store::scratch_root:\n  {}",
            found.join("\n  ")
        );
    }
}
