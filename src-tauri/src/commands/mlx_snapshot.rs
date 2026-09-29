//! What a finished MLX image model looks like on disk, and how to repair one
//! that is not finished.
//!
//! The image lane pulls diffusers-layout repos with
//! `huggingface_hub.snapshot_download` into our own HF_HOME, so a model lands
//! as `cache/hub/models--org--name/snapshots/<commit>/...` with the weights
//! symlinked out of `blobs/`. Two things then have to be true before the row
//! may say "Installed": the pipeline the manifest describes has to be on disk,
//! and every file of it has to be the file the hub actually serves.
//!
//! Both used to be guessed. The download set was a hand-written
//! `allow_patterns` list per catalog entry, and the completeness check only
//! asked whether *some* non-empty `.safetensors` sat in each component folder.
//! GitHub 127 (suyashnatural, 2026-09-09) is what that costs: his entry asked
//! for `text_encoder/*fp16*`, `UnfilteredAI/NSFW-gen-v2` ships no fp16 text
//! encoder at all, the pattern matched nothing, the download reported success
//! at exactly the size the catalog promised, and the install then died with
//! "the model snapshot is incomplete" naming no file. The pattern had been
//! copied from the RealVisXL entry, whose repo does carry fp16 encoders.
//!
//! So both answers now come from the repo itself. The hub's file listing says
//! which weights exist, in which precision variants, at which byte size and
//! (for LFS files) under which sha256; `model_index.json` says which
//! components the pipeline needs. Everything here works on those two lists,
//! stays offline-capable when the listing cannot be fetched, and never names
//! an absolute path in anything a user reads.

use std::path::{Path, PathBuf};

/// One file as the hub lists it for a repo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoFile {
    /// Repo-relative, forward slashes, exactly as the hub spells it.
    pub path: String,
    pub size: u64,
    /// Content digest, for LFS-backed files only. The small JSON and text
    /// files are plain git blobs whose `oid` is a sha1 over a git header, not
    /// a sha256 over the content, so they carry `None` and are checked by
    /// size alone.
    pub sha256: Option<String>,
}

impl RepoFile {
    fn dir(&self) -> Option<&str> {
        self.path.rsplit_once('/').map(|(d, _)| d)
    }

    fn name(&self) -> &str {
        self.path.rsplit_once('/').map_or(self.path.as_str(), |(_, n)| n)
    }
}

/// `GET /api/models/<repo>/tree/<rev>?recursive=true` into [`RepoFile`]s.
///
/// Directories and anything without a usable path or size are dropped rather
/// than rejected: a new field on the hub must not take the image lane down.
pub(crate) fn parse_repo_listing(raw: &str) -> Result<Vec<RepoFile>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "the hub returned a file listing we cannot read".to_string())?;
    let array = value
        .as_array()
        .ok_or_else(|| "the hub returned a file listing we cannot read".to_string())?;
    let mut out = Vec::new();
    for item in array {
        if item.get("type").and_then(|t| t.as_str()) != Some("file") {
            continue;
        }
        let Some(path) = item.get("path").and_then(|p| p.as_str()) else {
            continue;
        };
        if !is_safe_repo_path(path) {
            continue;
        }
        let lfs = item.get("lfs");
        // An LFS entry states the real size; the outer `size` of a
        // pointer-backed file agrees with it, but trust the LFS block first.
        let size = lfs
            .and_then(|l| l.get("size"))
            .or_else(|| item.get("size"))
            .and_then(|s| s.as_u64());
        let Some(size) = size else { continue };
        let sha256 = lfs
            .and_then(|l| l.get("oid").or_else(|| l.get("sha256")))
            .and_then(|o| o.as_str())
            .filter(|o| is_sha256(o))
            .map(|o| o.to_ascii_lowercase());
        out.push(RepoFile { path: path.to_string(), size, sha256 });
    }
    if out.is_empty() {
        return Err("the hub listed no files for this repository".into());
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Repo paths we are willing to join onto a local directory. Rejects
/// traversal, absolute paths, platform separators, control characters and
/// alternate-stream syntax before anything touches the filesystem.
fn is_safe_repo_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 512 || path.starts_with('/') {
        return false;
    }
    path.split('/').all(is_safe_segment)
}

fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.trim() == segment
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// What `model_index.json` declares, split by what each component has to
/// carry on disk.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Manifest {
    /// Components that hold weights: unet, transformer, vae, text encoders.
    pub weights: Vec<String>,
    /// Tokenizer components. They carry no weights, but they do have to carry
    /// one of several interchangeable vocabulary files.
    pub tokenizers: Vec<String>,
    /// Schedulers and processors: a config file and nothing else.
    pub configs: Vec<String>,
}

impl Manifest {
    fn components(&self) -> impl Iterator<Item = &String> {
        self.weights.iter().chain(self.tokenizers.iter()).chain(self.configs.iter())
    }
}

/// Read the pipeline manifest. `[null, null]` stubs (feature_extractor,
/// safety_checker on SD1.5 repos), scalar flags and plain nulls are not
/// components and are skipped, or every complete install would read as broken.
pub(crate) fn parse_model_index(raw: &str) -> Result<Manifest, String> {
    let json: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "model_index.json contains invalid JSON".to_string())?;
    let map = json
        .as_object()
        .ok_or_else(|| "model_index.json must contain an object".to_string())?;
    let mut manifest = Manifest::default();
    for (component, class) in map
        .iter()
        .filter(|(k, _)| !k.starts_with('_'))
        .filter_map(|(k, v)| v.get(1).and_then(|c| c.as_str()).map(|class| (k, class)))
    {
        if !is_safe_segment(component) {
            return Err("model_index.json contains an invalid component path".into());
        }
        if class.contains("Tokenizer") {
            manifest.tokenizers.push(component.clone());
        } else if class.contains("Scheduler")
            || class.contains("Processor")
            || class.contains("FeatureExtractor")
        {
            manifest.configs.push(component.clone());
        } else {
            manifest.weights.push(component.clone());
        }
    }
    manifest.weights.sort();
    manifest.tokenizers.sort();
    manifest.configs.sort();
    Ok(manifest)
}

/// One precision family of one component's weights: `model.fp16.safetensors`
/// alone, or every shard of `diffusion_pytorch_model-0000N-of-0000M`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WeightSet {
    pub variant: Option<String>,
    pub files: Vec<RepoFile>,
    pub bytes: u64,
}

/// `diffusion_pytorch_model-00001-of-00002` is one shard of one family; the
/// family is what the name says without that suffix.
fn strip_shard(stem: &str) -> &str {
    let five_digits = |s: &str| s.len() == 5 && s.bytes().all(|b| b.is_ascii_digit());
    let Some((head, total)) = stem.rsplit_once("-of-") else {
        return stem;
    };
    match head.rsplit_once('-') {
        Some((base, index)) if five_digits(total) && five_digits(index) && !base.is_empty() => base,
        _ => stem,
    }
}

/// Split `model.fp16-00001-of-00002.safetensors` into ("model", Some("fp16")).
/// A name without a dotted middle segment is the plain, full-precision family.
pub(crate) fn weights_family(name: &str) -> Option<(String, Option<String>)> {
    let (stem, ext) = name.rsplit_once('.')?;
    if ext != "safetensors" && ext != "bin" {
        return None;
    }
    // Shard suffix first: it sits between the variant and the extension.
    let stem = strip_shard(stem);
    match stem.rsplit_once('.') {
        Some((base, variant)) if !base.is_empty() && !variant.is_empty() => {
            Some((base.to_string(), Some(variant.to_string())))
        }
        _ => Some((stem.to_string(), None)),
    }
}

/// Every weights family the repo offers for one component.
pub(crate) fn weight_sets(files: &[RepoFile], component: &str) -> Vec<WeightSet> {
    let mut grouped: Vec<(String, Option<String>, Vec<RepoFile>)> = Vec::new();
    for file in files.iter().filter(|f| f.dir() == Some(component)) {
        let Some((base, variant)) = weights_family(file.name()) else {
            continue;
        };
        match grouped.iter_mut().find(|(b, v, _)| *b == base && *v == variant) {
            Some((_, _, list)) => list.push(file.clone()),
            None => grouped.push((base, variant, vec![file.clone()])),
        }
    }
    grouped
        .into_iter()
        .map(|(_, variant, mut list)| {
            list.sort_by(|a, b| a.path.cmp(&b.path));
            let bytes = list.iter().map(|f| f.size).sum();
            WeightSet { variant, files: list, bytes }
        })
        .collect()
}

/// The family to install for one component.
///
/// The requested variant wins when the repo has it; otherwise the plain family
/// does; otherwise the smallest family there is. That fallback is the whole
/// point: a repo may ship an fp16 unet and a full-precision text encoder, and
/// demanding fp16 everywhere leaves that component with no weights at all.
pub(crate) fn pick_weight_set(files: &[RepoFile], component: &str, prefer: Option<&str>) -> Option<WeightSet> {
    let sets = weight_sets(files, component);
    if let Some(want) = prefer {
        if let Some(hit) = sets.iter().find(|s| s.variant.as_deref() == Some(want)) {
            return Some(hit.clone());
        }
    }
    if let Some(plain) = sets.iter().find(|s| s.variant.is_none()) {
        return Some(plain.clone());
    }
    sets.into_iter().min_by_key(|s| s.bytes)
}

/// The exact file list to hand `snapshot_download` as `allow_patterns`, plus
/// what it will cost. Nothing is guessed: every entry is a path the hub listed.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DownloadPlan {
    pub files: Vec<RepoFile>,
    pub bytes: u64,
    /// Components the repo has no weights for at all. The install can still
    /// run, but the audit afterwards will name them.
    pub without_weights: Vec<String>,
}

/// What a component needs beside its weights: the config, the tokenizer
/// vocabulary, the shard index, a chat template. Named by shape rather than by
/// a list of extensions, because the list is exactly the kind of guess this
/// module exists to remove - Qwen-Image ships `tokenizer/chat_template.jinja`
/// and an 11 MB `tokenizer.json`, neither of which an extension list written
/// for SDXL would have contained.
const SUPPORT_FILE_CAP: u64 = 64_000_000;

fn is_support_file(file: &RepoFile) -> bool {
    weights_family(file.name()).is_none() && file.size <= SUPPORT_FILE_CAP
}

pub(crate) fn plan_download(
    files: &[RepoFile],
    manifest: &Manifest,
    prefer_variant: Option<&str>,
) -> DownloadPlan {
    let mut plan = DownloadPlan::default();
    match files.iter().find(|f| f.path == "model_index.json") {
        Some(index) => plan.files.push(index.clone()),
        // The listing must still name this file; if it does not, ask for it
        // by path so `allow_patterns` cannot skip the one file the pipeline
        // needs to even start.
        None => plan.files.push(RepoFile {
            path: "model_index.json".into(),
            size: 0,
            sha256: None,
        }),
    }
    for component in manifest.components() {
        for support in files
            .iter()
            .filter(|f| f.dir() == Some(component.as_str()) && is_support_file(f))
        {
            plan.files.push(support.clone());
        }
    }
    for component in &manifest.weights {
        match pick_weight_set(files, component, prefer_variant) {
            Some(set) => plan.files.extend(set.files),
            None => plan.without_weights.push(component.clone()),
        }
    }
    plan.files.sort_by(|a, b| a.path.cmp(&b.path));
    plan.files.dedup_by(|a, b| a.path == b.path);
    plan.bytes = plan.files.iter().map(|f| f.size).sum();
    plan
}

/// Why one file of a snapshot cannot be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Defect {
    /// Not on disk at all.
    Missing,
    /// There, but the filesystem will not hand it over. A snapshot entry is a
    /// symlink into `blobs/`; when the blob is gone the link stays behind and
    /// reads as this.
    Unreadable,
    /// Zero bytes: a torn write or a create that never got its content.
    Empty,
    /// An unfinished transfer. Up to huggingface_hub 1.17 that was a
    /// `<name>.incomplete` beside the target; from 1.18 (PR 4306, which
    /// removed cross-run resume to stop concurrent writers poisoning one
    /// shared partial) it is `blobs/<sha256>.<8 hex>.incomplete`, which no
    /// later run can ever pick up again. Both shapes count, and the blob form
    /// is the one that names the file it belongs to: that blob prefix is the
    /// LFS digest the hub lists for it.
    Partial,
    /// macOS only: an iCloud placeholder. The file reports its full length and
    /// holds none of the bytes, so a size check waves it through. Eviction is
    /// time-based, and a model cache that has not been opened in weeks is
    /// exactly what gets evicted.
    Evicted,
    /// A Git LFS pointer: the ~130 byte text stand-in that a clone without
    /// git-lfs, or a `GIT_LFS_SKIP_SMUDGE` checkout, leaves where the weights
    /// belong. It is a valid, non-empty file, which is exactly why a size-free
    /// check waves it through.
    LfsPointer,
    /// The right name, the wrong length. A resumed transfer that appended to a
    /// stale partial ends up here.
    WrongSize { found: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotDefect {
    /// Snapshot-relative path, never an absolute one: this text reaches the UI.
    pub path: String,
    pub defect: Defect,
    pub expected_size: Option<u64>,
    pub sha256: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SnapshotReport {
    /// Something that stops the audit before it can look at files, such as a
    /// manifest that is not there when we also have no listing to repair from.
    pub blocker: Option<String>,
    pub defects: Vec<SnapshotDefect>,
}

impl SnapshotReport {
    pub fn is_complete(&self) -> bool {
        self.blocker.is_none() && self.defects.is_empty()
    }
}

/// A tokenizer folder is complete when it carries one of these. Repos differ:
/// SDXL ships `vocab.json` plus `merges.txt`, Llama-style repos ship
/// `tokenizer.model` and no `tokenizer.json`, newer ones ship only
/// `tokenizer.json`. Demanding a fixed list fails most of them.
const TOKENIZER_ALTERNATIVES: &[&str] =
    &["tokenizer.json", "tokenizer.model", "vocab.json", "vocab.txt", "spiece.model"];

fn looks_like_lfs_pointer(path: &Path, len: u64) -> bool {
    // A pointer is three short lines. Anything past a kilobyte is content.
    if len == 0 || len > 1024 {
        return false;
    }
    let Ok(head) = std::fs::read(path) else {
        return false;
    };
    head.starts_with(b"version https://git-lfs")
}

/// `SF_DATALESS`. Apple documents the flag as internal and refuses to let user
/// space set or clear it, so the constant is carried here rather than read
/// from a crate.
///
/// Nur macOS: das Flag steht in `st_flags`, und an `st_flags` kommt allein
/// `std::os::macos::fs::MetadataExt`. Ohne dieses `cfg` bleiben Konstante und
/// Pruefung auf Linux und Windows uebrig, wo sie niemand lesen kann, und
/// `-D warnings` macht aus dem toten Posten einen Fehler.
#[cfg(target_os = "macos")]
const SF_DATALESS: u32 = 0x4000_0000;

#[cfg(target_os = "macos")]
fn is_dataless(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

#[cfg(target_os = "macos")]
fn evicted(meta: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    is_dataless(meta.st_flags())
}

#[cfg(not(target_os = "macos"))]
fn evicted(_meta: &std::fs::Metadata) -> bool {
    false
}

/// `blobs/<digest>.<something>.incomplete` for one digest: the unfinished
/// transfer of exactly this file, left behind by a run that was killed.
///
/// The snapshot sits at `<repo>/snapshots/<commit>`, so the blob store is two
/// levels up. When the cache lives on a volume without symlinks the blob store
/// is empty and this simply finds nothing.
fn orphaned_partials(snap: &Path, sha256: &str) -> Vec<PathBuf> {
    let Some(blobs) = snap.parent().and_then(|p| p.parent()).map(|p| p.join("blobs")) else {
        return Vec::new();
    };
    std::fs::read_dir(blobs)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry.file_name().to_str().is_some_and(|name| {
                name.starts_with(sha256) && name.ends_with(".incomplete")
            })
        })
        .map(|entry| entry.path())
        .collect()
}

/// Look at one file the snapshot is supposed to contain.
fn inspect(full: &Path, expected: Option<&RepoFile>) -> Option<Defect> {
    // huggingface_hub parks unfinished bytes beside the target under the very
    // same name plus `.incomplete`, so the suffix is appended, not substituted.
    if partial_beside(full).exists() {
        return Some(Defect::Partial);
    }
    let meta = match std::fs::metadata(full) {
        Ok(m) => m,
        // A symlink whose blob was deleted still answers symlink_metadata.
        Err(_) => {
            return Some(if std::fs::symlink_metadata(full).is_ok() {
                Defect::Unreadable
            } else {
                Defect::Missing
            })
        }
    };
    if !meta.is_file() {
        return Some(Defect::Unreadable);
    }
    if meta.len() == 0 {
        return Some(Defect::Empty);
    }
    if evicted(&meta) {
        return Some(Defect::Evicted);
    }
    if looks_like_lfs_pointer(full, meta.len()) {
        return Some(Defect::LfsPointer);
    }
    match expected {
        Some(file) if file.size != meta.len() => Some(Defect::WrongSize { found: meta.len() }),
        _ => None,
    }
}

fn partial_beside(full: &Path) -> PathBuf {
    PathBuf::from(format!("{}.incomplete", full.to_string_lossy()))
}

fn listed<'a>(files: Option<&'a [RepoFile]>, path: &str) -> Option<&'a RepoFile> {
    files?.iter().find(|f| f.path == path)
}

fn defect_for(path: &str, defect: Defect, expected: Option<&RepoFile>) -> SnapshotDefect {
    SnapshotDefect {
        path: path.to_string(),
        defect,
        expected_size: expected.map(|f| f.size),
        sha256: expected.and_then(|f| f.sha256.clone()),
    }
}

/// Audit one snapshot directory.
///
/// With a hub listing the audit knows the exact file names, their sizes and
/// their digests. Without one (offline, a gated repo, the hub down) it falls
/// back to what the snapshot itself states: the manifest names the components,
/// each component has to hold at least one usable weights file, and each file
/// still has to survive the empty/pointer/partial checks. The row on the
/// Models page is drawn from the offline form, so it never waits on a network
/// call.
pub(crate) fn audit_snapshot(
    snap: &Path,
    files: Option<&[RepoFile]>,
    prefer_variant: Option<&str>,
) -> SnapshotReport {
    let mut report = SnapshotReport::default();
    let index_path = snap.join("model_index.json");
    let raw = match std::fs::read_to_string(&index_path) {
        Ok(raw) => raw,
        Err(_) => {
            match listed(files, "model_index.json") {
                // Repairable: the hub can hand it back.
                Some(file) => {
                    report.defects.push(defect_for(
                        "model_index.json",
                        inspect(&index_path, Some(file)).unwrap_or(Defect::Missing),
                        Some(file),
                    ));
                    return report;
                }
                None => {
                    report.blocker = Some("model_index.json is missing or unreadable".into());
                    return report;
                }
            }
        }
    };
    let manifest = match parse_model_index(&raw) {
        Ok(m) => m,
        Err(e) => {
            report.blocker = Some(e);
            return report;
        }
    };

    for component in manifest.components() {
        let dir = snap.join(component);
        let carries_weights = manifest.weights.contains(component);
        let required: Vec<RepoFile> = match files {
            // With the listing the required set is simply what the repo has
            // for this component: its small files, plus the weights family we
            // picked for it.
            Some(all) => {
                let mut want: Vec<RepoFile> = all
                    .iter()
                    .filter(|f| f.dir() == Some(component.as_str()) && is_support_file(f))
                    .cloned()
                    .collect();
                if carries_weights {
                    match pick_weight_set(all, component, prefer_variant) {
                        Some(set) => want.extend(set.files),
                        None => report.defects.push(no_weights(component)),
                    }
                }
                want
            }
            // Offline the snapshot has to speak for itself: the shard index on
            // disk when there is one, otherwise every weights file present.
            None => {
                if manifest.tokenizers.contains(component) && !holds_a_tokenizer(&dir) {
                    report.defects.push(SnapshotDefect {
                        path: format!("{component}/ (one of {})", TOKENIZER_ALTERNATIVES.join(", ")),
                        defect: Defect::Missing,
                        expected_size: None,
                        sha256: None,
                    });
                }
                let local = if carries_weights { local_weight_files(&dir) } else { Vec::new() };
                if carries_weights && local.is_empty() {
                    report.defects.push(no_weights(component));
                }
                // Everything the folder holds is still checked for the shapes
                // a size-free look used to wave through.
                let mut want: Vec<String> = std::fs::read_dir(&dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .filter(|n| is_safe_segment(n))
                    .collect();
                want.extend(local);
                want.sort();
                want.dedup();
                want
                    .into_iter()
                    .map(|name| RepoFile { path: format!("{component}/{name}"), size: 0, sha256: None })
                    .collect()
            }
        };
        for file in &required {
            let expected = listed(files, &file.path);
            let mut defect = inspect(&snap.join(&file.path), expected);
            if defect == Some(Defect::Missing) {
                // A file that is absent while its unfinished transfer is still
                // sitting in the blob store is not simply missing, and saying
                // which of the two it is decides whether a retry can help.
                if let Some(sha) = expected.and_then(|f| f.sha256.as_deref()) {
                    if !orphaned_partials(snap, sha).is_empty() {
                        defect = Some(Defect::Partial);
                    }
                }
            }
            if let Some(defect) = defect {
                report.defects.push(defect_for(&file.path, defect, expected));
            }
        }
    }

    report.defects.sort_by(|a, b| a.path.cmp(&b.path));
    report.defects.dedup_by(|a, b| a.path == b.path);
    report
}

/// Weights files a component folder holds right now: the ones a local shard
/// index names, or every weights file in the folder when there is no index.
/// One of the interchangeable vocabulary files, which is all a tokenizer
/// folder owes us.
fn holds_a_tokenizer(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .any(|n| TOKENIZER_ALTERNATIVES.contains(&n.as_str()))
}

fn no_weights(component: &str) -> SnapshotDefect {
    SnapshotDefect {
        path: format!("{component}/"),
        defect: Defect::Missing,
        expected_size: None,
        sha256: None,
    }
}

fn local_weight_files(dir: &Path) -> Vec<String> {
    let names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    if let Some(index) = names.iter().find(|n| n.ends_with(".safetensors.index.json")) {
        if let Ok(raw) = std::fs::read_to_string(dir.join(index)) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                let mut shards: Vec<String> = json
                    .get("weight_map")
                    .and_then(|m| m.as_object())
                    .into_iter()
                    .flatten()
                    .filter_map(|(_, v)| v.as_str().map(str::to_string))
                    .filter(|s| is_safe_segment(s))
                    .collect();
                shards.sort();
                shards.dedup();
                if !shards.is_empty() {
                    return shards;
                }
            }
        }
    }
    let mut weights: Vec<String> = names
        .into_iter()
        .filter(|n| weights_family(n).is_some())
        .collect();
    weights.sort();
    weights
}

/// One file to fetch again, and whether something broken has to go first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repair {
    pub path: String,
    /// False for a file that is simply absent. A file that verifies is never
    /// in this list at all, so nothing that is usable is ever deleted.
    pub delete_first: bool,
    pub sha256: Option<String>,
    pub expected_size: u64,
}

/// Split an audit into what can be fetched again and what cannot.
///
/// Only a defect the hub listing named is repairable: without a size and a
/// path there is no request to make and no way to tell success from the same
/// failure repeated.
pub(crate) fn repair_plan(defects: &[SnapshotDefect]) -> (Vec<Repair>, Vec<SnapshotDefect>) {
    let mut repairs = Vec::new();
    let mut stuck = Vec::new();
    for defect in defects {
        match defect.expected_size {
            Some(size) if is_safe_repo_path(&defect.path) => repairs.push(Repair {
                path: defect.path.clone(),
                delete_first: defect.defect != Defect::Missing,
                sha256: defect.sha256.clone(),
                expected_size: size,
            }),
            _ => stuck.push(defect.clone()),
        }
    }
    (repairs, stuck)
}

/// Die Groessenangabe fuer Nutzertexte, in 1024er-Schritten.
///
/// Dieselbe Zaehlweise wie `formatBytes` in `src/lib/formatters.ts`, denn im
/// Kasten "Live install output" steht diese Zeile neben dem Fortschritt
/// derselben Datei. Mit 1000er-Schritten meldete der Log "pulling ... (8.6 GB)",
/// waehrend der Balken darunter 8.0 GB derselben Bytes zeigte.
pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} bytes");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

fn describe_one(defect: &SnapshotDefect) -> String {
    let what = match &defect.defect {
        Defect::Missing => "is missing".to_string(),
        Defect::Unreadable => "cannot be read".to_string(),
        Defect::Empty => "is empty".to_string(),
        Defect::Partial => "is still a partial download".to_string(),
        Defect::Evicted => "has been evicted to iCloud and holds no data locally".to_string(),
        Defect::LfsPointer => "is a Git LFS pointer, not the weights".to_string(),
        Defect::WrongSize { found } => format!("is {} on disk", human_bytes(*found)),
    };
    match defect.expected_size {
        Some(size) => format!("{} {} (expected {})", defect.path, what, human_bytes(size)),
        None => format!("{} {}", defect.path, what),
    }
}

/// The sentence the installer shows. Names every file it can, with the size
/// the hub states for it, and never an absolute path.
pub(crate) fn describe(report: &SnapshotReport) -> String {
    if let Some(blocker) = &report.blocker {
        return blocker.clone();
    }
    if report.defects.is_empty() {
        return "no files are missing".into();
    }
    const SHOWN: usize = 6;
    let mut parts: Vec<String> = report.defects.iter().take(SHOWN).map(describe_one).collect();
    if report.defects.len() > SHOWN {
        parts.push(format!("and {} more", report.defects.len() - SHOWN));
    }
    parts.join(", ")
}

/// sha256 over a file, streamed so a 10 GB shard does not go through memory.
pub(crate) fn sha256_of(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("open: {}", crate::os_error::english(&e)))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("read: {}", crate::os_error::english(&e)))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Remove a broken snapshot entry so the next fetch cannot be answered from
/// the cache that produced it.
///
/// A snapshot entry is a symlink into `blobs/`; deleting the link alone leaves
/// the corrupt blob behind and `hf_hub_download` relinks it, which repairs
/// nothing. The blob goes too, but only when it really sits inside the cache
/// root we own.
/// Throw away the unfinished transfers of one digest. They cannot be resumed
/// (each carries a name unique to the run that made it), `hf cache rm` does
/// not touch them, and leaving one behind means the next attempt starts beside
/// it rather than replacing it.
pub(crate) fn drop_orphaned_partials(snap: &Path, sha256: &str) -> usize {
    let mut dropped = 0;
    for path in orphaned_partials(snap, sha256) {
        if std::fs::remove_file(&path).is_ok() {
            dropped += 1;
        }
    }
    dropped
}

pub(crate) fn drop_broken_file(snap: &Path, cache_root: &Path, relative: &str) -> Result<(), String> {
    if !is_safe_repo_path(relative) {
        return Err("refusing an unsafe repository path".into());
    }
    let full = snap.join(relative);
    if let Ok(target) = std::fs::read_link(&full) {
        let blob = if target.is_absolute() {
            target
        } else {
            full.parent().map(|p| p.join(&target)).unwrap_or(target)
        };
        // Both sides canonicalised: on macOS the cache root arrives as
        // /var/... and the link resolves to /private/var/..., and an
        // uncompared prefix would spare every corrupt blob.
        if let (Ok(blob), Ok(root)) = (blob.canonicalize(), cache_root.canonicalize()) {
            if blob.starts_with(&root) {
                let _ = std::fs::remove_file(&blob);
            }
        }
    }
    let _ = std::fs::remove_file(&full);
    let _ = std::fs::remove_file(partial_beside(&full));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from the live listing of `UnfilteredAI/NSFW-gen-v2`, read from
    /// the hub on 2026-09-11. The shape that matters: fp16 weights for unet
    /// and vae, plain weights only for both text encoders.
    const NSFW_GEN_V2_LISTING: &str = r#"[
      {"type":"directory","path":"unet","size":0},
      {"type":"file","path":"model_index.json","size":685},
      {"type":"file","path":"scheduler/scheduler_config.json","size":488},
      {"type":"file","path":"text_encoder/config.json","size":560},
      {"type":"file","path":"text_encoder/model.safetensors","size":492265168,
       "lfs":{"oid":"34439351fe0077bb6c1b0da495d3dab27d3af52e4bd5c1bfe9ac8a0948d84907","size":492265168}},
      {"type":"file","path":"text_encoder_2/config.json","size":570},
      {"type":"file","path":"text_encoder_2/model.safetensors","size":2778702264,
       "lfs":{"oid":"57f964333dc51d4d02c32badee08103befc93ac769bc257c71c8f49d691167e9","size":2778702264}},
      {"type":"file","path":"tokenizer/merges.txt","size":524619},
      {"type":"file","path":"tokenizer/vocab.json","size":1059962},
      {"type":"file","path":"tokenizer_2/merges.txt","size":524619},
      {"type":"file","path":"tokenizer_2/vocab.json","size":1059962},
      {"type":"file","path":"unet/config.json","size":1729},
      {"type":"file","path":"unet/diffusion_pytorch_model.fp16.safetensors","size":5135149760,
       "lfs":{"oid":"3a223ea0680080ba251db390b9983646eb7ec857586799e6bdf7a4b0da1e67c9","size":5135149760}},
      {"type":"file","path":"unet/diffusion_pytorch_model.safetensors","size":10270077736,
       "lfs":{"oid":"a50b5114d61fc01cbf52a31b29d51e7a347bc6f681f10bfa53eed39077ac1ba4","size":10270077736}},
      {"type":"file","path":"vae/config.json","size":607},
      {"type":"file","path":"vae/diffusion_pytorch_model.fp16.safetensors","size":167335342,
       "lfs":{"oid":"bcb60880a46b63dea58e9bc591abe15f8350bde47b405f9c38f4be70c6161e68","size":167335342}},
      {"type":"file","path":"vae/diffusion_pytorch_model.safetensors","size":334643268,
       "lfs":{"oid":"e8aef7b00195ec3fa8caaa3434e7516eff7d658e1d30eafc9ad6b0e66e9e827e","size":334643268}}
    ]"#;

    /// The manifest shape of the SDXL repos in the catalog, read from the hub
    /// on 2026-09-11: an empty component is a `[null, null]` pair, never a
    /// plain null.
    const SDXL_MANIFEST: &str = r#"{
      "_class_name": "StableDiffusionXLPipeline",
      "feature_extractor": [null, null],
      "requires_safety_checker": true,
      "image_encoder": [null, null],
      "scheduler": ["diffusers", "EulerDiscreteScheduler"],
      "text_encoder": ["transformers", "CLIPTextModel"],
      "text_encoder_2": ["transformers", "CLIPTextModelWithProjection"],
      "tokenizer": ["transformers", "CLIPTokenizer"],
      "tokenizer_2": ["transformers", "CLIPTokenizer"],
      "unet": ["diffusers", "UNet2DConditionModel"],
      "vae": ["diffusers", "AutoencoderKL"]
    }"#;

    const QWEN_MANIFEST: &str = r#"{"text_encoder":["transformers","Qwen2_5_VLForConditionalGeneration"],
       "tokenizer":["transformers","Qwen2Tokenizer"],
       "vae":["diffusers","AutoencoderKLQwenImage"]}"#;

    /// Trailing whitespace is still valid JSON, and it is the only way a
    /// fixture can carry the exact byte length the hub states for a file.
    fn pad(raw: &str, len: usize) -> String {
        assert!(raw.len() <= len, "fixture manifest is longer than {len} bytes");
        format!("{raw}{}", " ".repeat(len - raw.len()))
    }

    fn listing() -> Vec<RepoFile> {
        parse_repo_listing(NSFW_GEN_V2_LISTING).unwrap()
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// A file that reports the length the hub states without occupying the
    /// disk: a fixture cannot hold five real gigabytes of unet.
    fn write_sized(path: &Path, len: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(path).unwrap().set_len(len).unwrap();
    }

    /// The snapshot the reporter ended up with: the manifest and every config,
    /// the two fp16 components, and two text encoder folders that hold nothing
    /// but a config because `text_encoder/*fp16*` matched no file in this repo.
    fn github_127_snapshot(snap: &Path) {
        // Padded to the 685 bytes the listing states for it; trailing space
        // is still valid JSON and a fixture cannot reproduce the real file.
        write(&snap.join("model_index.json"), pad(SDXL_MANIFEST, 685).as_bytes());
        write_sized(&snap.join("scheduler/scheduler_config.json"), 488);
        write_sized(&snap.join("text_encoder/config.json"), 560);
        write_sized(&snap.join("text_encoder_2/config.json"), 570);
        for dir in ["tokenizer", "tokenizer_2"] {
            write_sized(&snap.join(dir).join("vocab.json"), 1059962);
            write_sized(&snap.join(dir).join("merges.txt"), 524619);
        }
        write_sized(&snap.join("unet/config.json"), 1729);
        write_sized(&snap.join("unet/diffusion_pytorch_model.fp16.safetensors"), 5135149760);
        write_sized(&snap.join("vae/config.json"), 607);
        write_sized(&snap.join("vae/diffusion_pytorch_model.fp16.safetensors"), 167335342);
    }

    #[test]
    fn listing_keeps_files_with_their_lfs_digest_and_drops_directories() {
        let files = listing();
        assert!(files.iter().all(|f| f.size > 0));
        assert!(!files.iter().any(|f| f.path == "unet"), "directories are not files");
        let unet = files
            .iter()
            .find(|f| f.path == "unet/diffusion_pytorch_model.fp16.safetensors")
            .unwrap();
        assert_eq!(unet.size, 5135149760);
        assert_eq!(
            unet.sha256.as_deref(),
            Some("3a223ea0680080ba251db390b9983646eb7ec857586799e6bdf7a4b0da1e67c9")
        );
        // A plain git blob has no content digest we can check.
        let config = files.iter().find(|f| f.path == "unet/config.json").unwrap();
        assert_eq!(config.sha256, None);
    }

    #[test]
    fn listing_refuses_garbage_and_paths_that_climb_out() {
        assert!(parse_repo_listing("not json").is_err());
        assert!(parse_repo_listing("{}").is_err());
        assert!(parse_repo_listing("[]").is_err());
        let hostile = r#"[
          {"type":"file","path":"../escape.safetensors","size":1},
          {"type":"file","path":"/etc/passwd","size":1},
          {"type":"file","path":"a/../../b","size":1},
          {"type":"file","path":"good.json","size":2}
        ]"#;
        let files = parse_repo_listing(hostile).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "good.json");
    }

    #[test]
    fn weights_families_split_variant_and_shards() {
        assert_eq!(
            weights_family("model.fp16.safetensors"),
            Some(("model".into(), Some("fp16".into())))
        );
        assert_eq!(
            weights_family("diffusion_pytorch_model.safetensors"),
            Some(("diffusion_pytorch_model".into(), None))
        );
        assert_eq!(
            weights_family("diffusion_pytorch_model-00001-of-00002.safetensors"),
            Some(("diffusion_pytorch_model".into(), None))
        );
        assert_eq!(
            weights_family("model.fp16-00002-of-00002.safetensors"),
            Some(("model".into(), Some("fp16".into())))
        );
        assert_eq!(weights_family("pytorch_model.bin"), Some(("pytorch_model".into(), None)));
        assert_eq!(weights_family("config.json"), None);
        assert_eq!(weights_family("model.safetensors.index.json"), None);
    }

    /// The bug itself, before any file is on disk: asking for fp16 in a repo
    /// that has no fp16 text encoder must fall back to the weights it does
    /// have instead of selecting nothing.
    #[test]
    fn a_missing_variant_falls_back_to_the_weights_the_repo_has() {
        let files = listing();
        let unet = pick_weight_set(&files, "unet", Some("fp16")).unwrap();
        assert_eq!(unet.variant.as_deref(), Some("fp16"));
        assert_eq!(unet.bytes, 5135149760);

        let encoder = pick_weight_set(&files, "text_encoder", Some("fp16")).unwrap();
        assert_eq!(encoder.variant, None, "no fp16 encoder exists, take the plain one");
        assert_eq!(encoder.files[0].path, "text_encoder/model.safetensors");

        // Without a preference the plain family wins outright.
        assert_eq!(pick_weight_set(&files, "unet", None).unwrap().bytes, 10270077736);
        assert!(pick_weight_set(&files, "scheduler", Some("fp16")).is_none());
    }

    /// Only a `[library, class]` pair is a component. Everything else in a
    /// manifest has to be skipped instead of becoming a folder the audit then
    /// reports as missing: the `[null, null]` stub the four SDXL and SD1.5
    /// repos of the catalog use for an empty component, a scalar flag, and a
    /// plain null, which no catalog repo carries (hub, 2026-09-11) but which
    /// is legal JSON a custom repo may still hand us.
    #[test]
    fn only_library_class_pairs_become_components() {
        let manifest = parse_model_index(
            r#"{
              "_class_name": "StableDiffusionPipeline",
              "_diffusers_version": "0.38.0",
              "feature_extractor": [null, null],
              "image_encoder": [null, null],
              "requires_safety_checker": true,
              "safety_checker": null,
              "scheduler": ["diffusers", "EulerDiscreteScheduler"],
              "text_encoder": ["transformers", "CLIPTextModel"],
              "tokenizer": ["transformers", "CLIPTokenizer"],
              "unet": ["diffusers", "UNet2DConditionModel"],
              "vae": ["diffusers", "AutoencoderKL"]
            }"#,
        )
        .unwrap();
        assert_eq!(manifest.weights, ["text_encoder", "unet", "vae"]);
        assert_eq!(manifest.tokenizers, ["tokenizer"]);
        assert_eq!(manifest.configs, ["scheduler"]);
    }

    #[test]
    fn the_download_plan_covers_every_component_and_prices_itself() {
        let manifest = parse_model_index(SDXL_MANIFEST).unwrap();
        assert_eq!(manifest.weights, ["text_encoder", "text_encoder_2", "unet", "vae"]);
        assert_eq!(manifest.tokenizers, ["tokenizer", "tokenizer_2"]);
        assert_eq!(manifest.configs, ["scheduler"]);

        let plan = plan_download(&listing(), &manifest, Some("fp16"));
        let names: Vec<&str> = plan.files.iter().map(|f| f.path.as_str()).collect();
        assert!(plan.without_weights.is_empty());
        assert!(names.contains(&"model_index.json"));
        assert!(names.contains(&"text_encoder/model.safetensors"));
        assert!(names.contains(&"text_encoder_2/model.safetensors"));
        assert!(names.contains(&"unet/diffusion_pytorch_model.fp16.safetensors"));
        assert!(names.contains(&"vae/diffusion_pytorch_model.fp16.safetensors"));
        assert!(names.contains(&"tokenizer/vocab.json"));
        assert!(names.contains(&"scheduler/scheduler_config.json"));
        // The full-precision duplicates stay on the hub.
        assert!(!names.contains(&"unet/diffusion_pytorch_model.safetensors"));
        assert!(!names.contains(&"vae/diffusion_pytorch_model.safetensors"));
        // 8.57 GB of weights and configs, which is not the 5.3 GB the old
        // pattern set pulled and the catalog still promised.
        assert_eq!(plan.bytes, 8576626335);
    }

    #[test]
    fn the_download_plan_still_asks_for_model_index_when_the_listing_omits_it() {
        let files: Vec<RepoFile> = listing()
            .into_iter()
            .filter(|f| f.path != "model_index.json")
            .collect();
        let manifest = parse_model_index(SDXL_MANIFEST).unwrap();
        let plan = plan_download(&files, &manifest, Some("fp16"));
        assert!(
            plan.files.iter().any(|f| f.path == "model_index.json"),
            "allow_patterns must name model_index.json even when the listing forgot it"
        );
    }

    /// Qwen-Image and Z-Image: a nine-shard transformer, a four-shard text
    /// encoder, an 11 MB tokenizer.json and a chat template. Every shard of a
    /// family has to be required together, and none of the support files may
    /// be dropped for having an extension nobody thought of.
    #[test]
    fn a_sharded_repo_keeps_every_shard_and_every_support_file() {
        let raw = r#"[
          {"type":"file","path":"model_index.json","size":443},
          {"type":"file","path":"text_encoder/config.json","size":3217},
          {"type":"file","path":"text_encoder/model-00001-of-00002.safetensors","size":4968243304,
           "lfs":{"oid":"d725335e4ea2399be706469e4b8807716a8fa64bd03468252e9f7acf2415fee4","size":4968243304}},
          {"type":"file","path":"text_encoder/model-00002-of-00002.safetensors","size":1691924384,
           "lfs":{"oid":"5dd068336d14d45ffb43cef374d286cc6ba9d8741b028f90a7d040d847961f4a","size":1691924384}},
          {"type":"file","path":"text_encoder/model.safetensors.index.json","size":57655},
          {"type":"file","path":"tokenizer/chat_template.jinja","size":2427},
          {"type":"file","path":"tokenizer/tokenizer.json","size":11422654},
          {"type":"file","path":"vae/config.json","size":730},
          {"type":"file","path":"vae/diffusion_pytorch_model.safetensors","size":253806966,
           "lfs":{"oid":"0c8bc8b758c649abef9ea407b95408389a3b2f610d0d10fcb054fe171d0a8344","size":253806966}}
        ]"#;
        let files = parse_repo_listing(raw).unwrap();
        let manifest = parse_model_index(QWEN_MANIFEST).unwrap();
        let plan = plan_download(&files, &manifest, None);
        let names: Vec<&str> = plan.files.iter().map(|f| f.path.as_str()).collect();
        assert!(names.contains(&"text_encoder/model-00001-of-00002.safetensors"));
        assert!(names.contains(&"text_encoder/model-00002-of-00002.safetensors"));
        assert!(names.contains(&"text_encoder/model.safetensors.index.json"));
        assert!(names.contains(&"tokenizer/chat_template.jinja"), "{names:?}");
        assert!(names.contains(&"tokenizer/tokenizer.json"));
        assert_eq!(plan.without_weights, ["vae"; 0], "every weights component resolved");

        // One shard short is not installed, and the audit says which shard.
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        for file in &plan.files {
            write_sized(&snap.join(&file.path), file.size);
        }
        write(&snap.join("model_index.json"), pad(QWEN_MANIFEST, 443).as_bytes());
        assert!(audit_snapshot(snap, Some(&files), None).is_complete());
        std::fs::remove_file(snap.join("text_encoder/model-00002-of-00002.safetensors")).unwrap();
        let report = audit_snapshot(snap, Some(&files), None);
        assert!(
            describe(&report).contains("text_encoder/model-00002-of-00002.safetensors is missing (expected 1.6 GB)"),
            "{}",
            describe(&report)
        );
    }

    #[test]
    fn a_complete_single_shard_snapshot_passes_with_and_without_the_listing() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        github_127_snapshot(snap);
        // Complete it the way the repaired plan would.
        write_sized(&snap.join("text_encoder/model.safetensors"), 492265168);
        write_sized(&snap.join("text_encoder_2/model.safetensors"), 2778702264);
        let offline = audit_snapshot(snap, None, Some("fp16"));
        assert!(offline.is_complete(), "offline audit: {}", describe(&offline));
        let online = audit_snapshot(snap, Some(&listing()), Some("fp16"));
        assert!(online.is_complete(), "audit against the listing: {}", describe(&online));
    }

    #[test]
    fn a_complete_sharded_snapshot_passes_from_its_own_index() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        write(
            &snap.join("model_index.json"),
            br#"{"unet":["diffusers","UNet2DConditionModel"]}"#,
        );
        write(
            &snap.join("unet/diffusion_pytorch_model.safetensors.index.json"),
            br#"{"weight_map":{"a":"diffusion_pytorch_model-00001-of-00002.safetensors",
                 "b":"diffusion_pytorch_model-00002-of-00002.safetensors"}}"#,
        );
        write(&snap.join("unet/diffusion_pytorch_model-00001-of-00002.safetensors"), b"one");
        assert!(!audit_snapshot(snap, None, None).is_complete(), "one shard of two");
        let report = audit_snapshot(snap, None, None);
        assert!(
            describe(&report).contains("diffusion_pytorch_model-00002-of-00002.safetensors"),
            "{}",
            describe(&report)
        );
        write(&snap.join("unet/diffusion_pytorch_model-00002-of-00002.safetensors"), b"two");
        assert!(audit_snapshot(snap, None, None).is_complete());
    }

    /// GitHub 127, suyashnatural, 2026-09-09.
    #[test]
    fn github_127_names_the_missing_file_and_offers_to_fetch_it() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        github_127_snapshot(snap);
        let files = listing();

        let report = audit_snapshot(snap, Some(&files), Some("fp16"));
        assert!(!report.is_complete());
        let text = describe(&report);
        assert!(text.contains("text_encoder/model.safetensors is missing (expected 469.5 MB)"), "{text}");
        assert!(text.contains("text_encoder_2/model.safetensors is missing (expected 2.6 GB)"), "{text}");
        assert!(!text.contains(snap.to_str().unwrap()), "no private paths in UI text");

        let (repairs, stuck) = repair_plan(&report.defects);
        assert!(stuck.is_empty());
        let paths: Vec<&str> = repairs.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["text_encoder/model.safetensors", "text_encoder_2/model.safetensors"]);
        assert!(repairs.iter().all(|r| !r.delete_first), "nothing on disk to delete");
        assert!(repairs.iter().all(|r| r.sha256.is_some()), "both come with a digest to check");
        // The unet the reporter did get is left alone.
        assert!(!paths.contains(&"unet/diffusion_pytorch_model.fp16.safetensors"));
    }

    #[test]
    fn an_lfs_pointer_where_a_shard_belongs_is_refetched_not_kept() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        github_127_snapshot(snap);
        write_sized(&snap.join("text_encoder/model.safetensors"), 492265168);
        write_sized(&snap.join("text_encoder_2/model.safetensors"), 2778702264);
        write(
            &snap.join("unet/diffusion_pytorch_model.fp16.safetensors"),
            b"version https://git-lfs.github.com/spec/v1\noid sha256:3a223ea0\nsize 5135149760\n",
        );
        let files = listing();
        let report = audit_snapshot(snap, Some(&files), Some("fp16"));
        let text = describe(&report);
        assert!(
            text.contains("unet/diffusion_pytorch_model.fp16.safetensors is a Git LFS pointer, not the weights (expected 4.8 GB)"),
            "{text}"
        );
        let (repairs, stuck) = repair_plan(&report.defects);
        assert!(stuck.is_empty());
        let broken: Vec<&Repair> = repairs
            .iter()
            .filter(|r| r.path == "unet/diffusion_pytorch_model.fp16.safetensors")
            .collect();
        assert_eq!(broken.len(), 1);
        assert!(broken[0].delete_first, "a pointer file has to go before the refetch");
        // Offline the pointer is caught too, on shape alone.
        assert!(!audit_snapshot(snap, None, Some("fp16")).is_complete());
    }

    #[test]
    fn a_partial_download_and_a_short_file_are_both_defects() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        github_127_snapshot(snap);
        write_sized(&snap.join("text_encoder_2/model.safetensors"), 2778702264);
        // The shape huggingface_hub leaves behind mid-transfer.
        write(&snap.join("text_encoder/model.safetensors"), b"half the bytes");
        write(&snap.join("text_encoder/model.safetensors.incomplete"), b"the rest");
        let files = listing();
        let report = audit_snapshot(snap, Some(&files), Some("fp16"));
        let text = describe(&report);
        assert!(text.contains("text_encoder/model.safetensors is still a partial download"), "{text}");

        // Without the .incomplete sibling the same file is merely short, and
        // only the listing can say so.
        std::fs::remove_file(snap.join("text_encoder/model.safetensors.incomplete")).unwrap();
        let report = audit_snapshot(snap, Some(&files), Some("fp16"));
        let text = describe(&report);
        assert!(
            text.contains("text_encoder/model.safetensors is 14 bytes on disk (expected 469.5 MB)"),
            "{text}"
        );
        assert!(audit_snapshot(snap, None, Some("fp16")).is_complete(), "size needs the listing");
        let (repairs, _) = repair_plan(&report.defects);
        assert!(repairs.iter().any(|r| r.path == "text_encoder/model.safetensors" && r.delete_first));
    }

    #[test]
    fn a_tokenizer_needs_one_of_its_alternatives_not_all_of_them() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        write(
            &snap.join("model_index.json"),
            br#"{"tokenizer":["transformers","LlamaTokenizer"],
                 "text_encoder":["transformers","CLIPTextModel"]}"#,
        );
        write(&snap.join("text_encoder/model.safetensors"), b"weights");
        // tokenizer.model and no tokenizer.json is a complete tokenizer.
        write(&snap.join("tokenizer/tokenizer.model"), b"sentencepiece");
        write(&snap.join("tokenizer/tokenizer_config.json"), b"{}");
        assert!(audit_snapshot(snap, None, None).is_complete());

        std::fs::remove_file(snap.join("tokenizer/tokenizer.model")).unwrap();
        let report = audit_snapshot(snap, None, None);
        assert!(!report.is_complete());
        assert!(describe(&report).contains("one of tokenizer.json"), "{}", describe(&report));

        // vocab.json alone is the SDXL shape and also counts.
        write(&snap.join("tokenizer/vocab.json"), b"{}");
        assert!(audit_snapshot(snap, None, None).is_complete());
    }

    #[test]
    fn a_manifest_that_cannot_be_read_blocks_instead_of_pretending() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        let report = audit_snapshot(snap, None, None);
        assert_eq!(report.blocker.as_deref(), Some("model_index.json is missing or unreadable"));
        assert!(!report.is_complete());

        // With a listing the same state is a repairable missing file.
        let report = audit_snapshot(snap, Some(&listing()), None);
        assert_eq!(report.blocker, None);
        let (repairs, _) = repair_plan(&report.defects);
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].path, "model_index.json");

        write(&snap.join("model_index.json"), b"{");
        assert_eq!(
            audit_snapshot(snap, None, None).blocker.as_deref(),
            Some("model_index.json contains invalid JSON")
        );
        write(&snap.join("model_index.json"), br#"{"../outside":["diffusers","UNet2DConditionModel"]}"#);
        assert_eq!(
            audit_snapshot(snap, None, None).blocker.as_deref(),
            Some("model_index.json contains an invalid component path")
        );
    }

    #[test]
    fn nothing_that_verifies_is_ever_scheduled_for_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let snap = temp.path();
        github_127_snapshot(snap);
        let files = listing();
        let report = audit_snapshot(snap, Some(&files), Some("fp16"));
        let (repairs, _) = repair_plan(&report.defects);
        for repair in &repairs {
            assert!(
                !snap.join(&repair.path).exists() || repair.delete_first,
                "{} is on disk and healthy",
                repair.path
            );
        }
        // Negative control: a snapshot with nothing wrong schedules no work.
        write_sized(&snap.join("text_encoder/model.safetensors"), 492265168);
        write_sized(&snap.join("text_encoder_2/model.safetensors"), 2778702264);
        let clean = audit_snapshot(snap, None, Some("fp16"));
        assert!(clean.is_complete());
        assert_eq!(describe(&clean), "no files are missing");
        assert!(repair_plan(&clean.defects).0.is_empty());
    }

    // Symlinks legt dieser Test mit `std::os::unix` an, das es unter Windows
    // nicht gibt. Dasselbe `cfg` tragen die vier Geschwister in filesystem.rs,
    // engine.rs und gpu.rs; hier hat es gefehlt.
    #[cfg(unix)]
    #[test]
    fn a_dangling_snapshot_link_reads_as_unreadable_and_takes_its_blob_with_it() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path();
        let snap = cache.join("snapshots/rev");
        let blob = cache.join("blobs/abc123");
        write(&blob, b"corrupt");
        write(&snap.join("model_index.json"), br#"{"unet":["diffusers","UNet2DConditionModel"]}"#);
        std::fs::create_dir_all(snap.join("unet")).unwrap();
        let link = snap.join("unet/diffusion_pytorch_model.safetensors");
        std::os::unix::fs::symlink(&blob, &link).unwrap();
        assert!(audit_snapshot(&snap, None, None).is_complete(), "a live link is a live file");

        drop_broken_file(&snap, cache, "unet/diffusion_pytorch_model.safetensors").unwrap();
        assert!(!blob.exists(), "the blob behind a broken link has to go too");
        assert!(!link.exists());

        // A link left pointing at nothing is not silently treated as absent.
        std::os::unix::fs::symlink(&blob, &link).unwrap();
        let report = audit_snapshot(&snap, None, None);
        assert!(describe(&report).contains("cannot be read"), "{}", describe(&report));
        assert!(drop_broken_file(&snap, cache, "../escape").is_err());
    }

    /// The live shape the huggingface_hub cache actually leaves behind since
    /// version 1.18: the weights file is absent from the snapshot and its
    /// unfinished transfer sits in the blob store under the digest the hub
    /// lists for it, with a per-run suffix that no later run can resume.
    #[test]
    fn an_orphaned_blob_transfer_names_the_file_it_belongs_to() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        let snap = repo.join("snapshots/f70ad5bc");
        github_127_snapshot(&snap);
        write_sized(&snap.join("text_encoder/model.safetensors"), 492265168);
        write_sized(&snap.join("text_encoder_2/model.safetensors"), 2778702264);
        std::fs::remove_file(snap.join("unet/diffusion_pytorch_model.fp16.safetensors")).unwrap();
        let digest = "3a223ea0680080ba251db390b9983646eb7ec857586799e6bdf7a4b0da1e67c9";
        write_sized(&repo.join(format!("blobs/{digest}.d4f6b876.incomplete")), 603561550);
        let files = listing();

        let report = audit_snapshot(&snap, Some(&files), Some("fp16"));
        let text = describe(&report);
        assert!(
            text.contains("unet/diffusion_pytorch_model.fp16.safetensors is still a partial download (expected 4.8 GB)"),
            "{text}"
        );
        // Without the orphan the very same state is a plain missing file.
        assert_eq!(drop_orphaned_partials(&snap, digest), 1);
        let text = describe(&audit_snapshot(&snap, Some(&files), Some("fp16")));
        assert!(text.contains("unet/diffusion_pytorch_model.fp16.safetensors is missing"), "{text}");
        assert_eq!(drop_orphaned_partials(&snap, digest), 0);
    }

    // Geht mit der Pruefung selbst auf macOS: ohne dieses `cfg` griffe der
    // Test auf Linux und Windows nach Posten, die es dort nicht mehr gibt, und
    // `cargo test` scheiterte schon am Uebersetzen statt an einer Lint-Regel.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_icloud_placeholder_is_not_a_downloaded_file() {
        // The flag cannot be set from user space, so the predicate is proved
        // on the bit pattern and wired into the size check above it.
        assert!(is_dataless(SF_DATALESS));
        assert!(is_dataless(SF_DATALESS | 0x2));
        assert!(!is_dataless(0));
        assert!(!is_dataless(0x8000_0000));
    }

    #[test]
    fn human_bytes_counts_the_way_the_interface_counts() {
        assert_eq!(human_bytes(0), "0 bytes");
        assert_eq!(human_bytes(1023), "1023 bytes");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(492265168), "469.5 MB");
        assert_eq!(human_bytes(5135149760), "4.8 GB");
        assert_eq!(human_bytes(8576626335), "8.0 GB");
    }

    #[test]
    fn a_digest_is_taken_over_the_whole_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("weights.safetensors");
        std::fs::write(&path, b"").unwrap();
        assert_eq!(
            sha256_of(&path).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        std::fs::write(&path, vec![7u8; 3 << 20]).unwrap();
        assert_eq!(sha256_of(&path).unwrap().len(), 64);
        assert!(sha256_of(&temp.path().join("absent")).is_err());
    }
}
