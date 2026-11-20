//! The files that say what the voice loop is made of.
//!
//! `models.json` lists every model file with its size and sha256,
//! `python.json` the private Python per platform, `requirements.txt` the
//! locked packages. The setup reads all three from the sidecar directory and
//! never carries a version of its own, so a new lock or a new model revision
//! is a change to those files only.

use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::os_error;

const SUPPORTED_SCHEMA: u32 = 1;

/// The role of an entry that is one voice of the speech output. The list
/// names every voice LU offers; an installation holds the chosen one, and
/// another is fetched when the user picks it.
pub const VOICE_ROLE: &str = "tts-voice";
const VOICE_ID_PREFIX: &str = "tts-voice-";
/// The voice of an installation that has never chosen one.
pub const DEFAULT_VOICE: &str = "alba";

/// One file to download and verify.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct RemoteFile {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ModelFile {
    /// Relative to the models directory, always with forward slashes.
    pub path: String,
    #[serde(flatten)]
    pub remote: RemoteFile,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ModelEntry {
    pub id: String,
    pub role: String,
    pub name: String,
    pub license: String,
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub attribution: Option<String>,
    pub files: Vec<ModelFile>,
}

impl ModelEntry {
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.remote.size).sum()
    }

    /// The name of the voice, when this entry is one. The sidecar reads the
    /// same name out of the id (`models.py`).
    pub fn voice(&self) -> Option<&str> {
        if self.role == VOICE_ROLE {
            self.id.strip_prefix(VOICE_ID_PREFIX)
        } else {
            None
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct ModelManifest {
    schema: u32,
    pub models: Vec<ModelEntry>,
}

impl ModelManifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let manifest: ModelManifest = serde_json::from_str(text)
            .map_err(|e| format!("The voice model list (models.json) could not be read: {e}."))?;
        if manifest.schema != SUPPORTED_SCHEMA {
            return Err(format!(
                "The voice model list (models.json) has schema {}, this version of LU reads schema {SUPPORTED_SCHEMA}.",
                manifest.schema
            ));
        }
        if manifest.models.is_empty() {
            return Err("The voice model list (models.json) names no models.".to_string());
        }
        let mut seen = HashSet::new();
        for file in manifest.files() {
            check_relative_path(&file.path)?;
            check_remote(&file.remote, &file.path)?;
            if !seen.insert(file.path.as_str()) {
                return Err(format!("The voice model list (models.json) names {} twice.", file.path));
            }
        }
        for entry in manifest.models.iter().filter(|m| m.role == VOICE_ROLE) {
            // The name travels to the sidecar as the voice of a session.
            let named = entry.voice().is_some_and(|name| {
                !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            });
            if !named || entry.files.len() != 1 {
                return Err(format!(
                    "The voice model list (models.json) has a voice it cannot use: {}.",
                    entry.id
                ));
            }
        }
        Ok(manifest)
    }

    pub fn load(sidecar_dir: &Path) -> Result<Self, String> {
        Self::parse(&read_sidecar_file(sidecar_dir, "models.json")?)
    }

    pub fn files(&self) -> impl Iterator<Item = &ModelFile> {
        self.models.iter().flat_map(|m| m.files.iter())
    }

    pub fn total_bytes(&self) -> u64 {
        self.files().map(|f| f.remote.size).sum()
    }

    /// Every voice LU offers, in the order of the list.
    pub fn voices(&self) -> impl Iterator<Item = &ModelEntry> {
        self.models.iter().filter(|m| m.voice().is_some())
    }

    pub fn voice_entry(&self, voice: &str) -> Option<&ModelEntry> {
        self.voices().find(|m| m.voice() == Some(voice))
    }

    /// The voice an installation uses: the wanted one when the list has it,
    /// otherwise the default, otherwise the first. Empty when the list has no
    /// voices at all.
    pub fn resolve_voice(&self, wanted: &str) -> String {
        [wanted, DEFAULT_VOICE]
            .into_iter()
            .find(|name| self.voice_entry(name).is_some())
            .or_else(|| self.voices().next().and_then(|m| m.voice()))
            .unwrap_or("")
            .to_string()
    }

    /// What one installation is made of: every model, and of the voices only
    /// `voice`.
    pub fn with_voice(&self, voice: &str) -> ModelManifest {
        ModelManifest {
            schema: self.schema,
            models: self.models.iter().filter(|m| m.voice().is_none_or(|name| name == voice)).cloned().collect(),
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct PythonBuild {
    pub target: String,
    #[serde(flatten)]
    pub remote: RemoteFile,
    /// The interpreter inside the unpacked `python` directory.
    pub exe: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct PythonManifest {
    schema: u32,
    pub version: String,
    pub builds: Vec<PythonBuild>,
}

impl PythonManifest {
    pub fn parse(text: &str) -> Result<Self, String> {
        let manifest: PythonManifest = serde_json::from_str(text)
            .map_err(|e| format!("The voice Python list (python.json) could not be read: {e}."))?;
        if manifest.schema != SUPPORTED_SCHEMA {
            return Err(format!(
                "The voice Python list (python.json) has schema {}, this version of LU reads schema {SUPPORTED_SCHEMA}.",
                manifest.schema
            ));
        }
        for build in &manifest.builds {
            check_relative_path(&build.exe)?;
            check_remote(&build.remote, &build.target)?;
        }
        Ok(manifest)
    }

    pub fn load(sidecar_dir: &Path) -> Result<Self, String> {
        Self::parse(&read_sidecar_file(sidecar_dir, "python.json")?)
    }

    pub fn build_for(&self, target: &str) -> Result<&PythonBuild, String> {
        self.builds.iter().find(|b| b.target == target).ok_or_else(|| {
            format!("The voice loop has no Python build for this system ({target}).")
        })
    }
}

fn read_sidecar_file(sidecar_dir: &Path, name: &str) -> Result<String, String> {
    std::fs::read_to_string(sidecar_dir.join(name)).map_err(|e| {
        format!(
            "The voice loop file {name} could not be read: {}. Reinstall LU to restore it.",
            os_error::io_english(&e)
        )
    })
}

/// A manifest path must stay inside the directory it is joined to. The
/// manifest ships with the app, so this is a guard against a typo and not
/// against an attacker, but a typo that writes outside the voice folder would
/// be found by a user and not by us.
fn check_relative_path(path: &str) -> Result<(), String> {
    let bad = path.is_empty()
        || path.contains('\\')
        || path.contains(':')
        || Path::new(path).components().any(|c| !matches!(c, Component::Normal(_)));
    if bad {
        return Err(format!("The voice loop manifest names a path that is not allowed: {path}."));
    }
    Ok(())
}

fn check_remote(remote: &RemoteFile, label: &str) -> Result<(), String> {
    if !remote.url.starts_with("https://") {
        return Err(format!("The voice loop manifest has no https download address for {label}."));
    }
    if remote.size == 0 {
        return Err(format!("The voice loop manifest has no size for {label}."));
    }
    if remote.sha256.len() != 64 || !remote.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("The voice loop manifest has no valid sha256 for {label}."));
    }
    Ok(())
}

/// The versions `requirements.txt` pins for the named packages.
///
/// The lock carries one line per platform marker for torch (`2.14.1` and
/// `2.14.1+cpu`); the local build tag says nothing a user needs, so it is
/// dropped and the first line wins.
pub fn pinned_versions(requirements: &str, packages: &[&str]) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for line in requirements.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') {
            continue;
        }
        let spec = line.split(';').next().unwrap_or("").trim();
        let Some((name, version)) = spec.split_once("==") else { continue };
        let name = name.split('[').next().unwrap_or("").trim().to_ascii_lowercase();
        let version = version.split('+').next().unwrap_or("").trim();
        if version.is_empty() || !packages.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
            continue;
        }
        found.entry(name).or_insert_with(|| version.to_string());
    }
    found
}

/// `__version__ = "0.1.0"` out of the sidecar package.
pub fn sidecar_version(init_py: &str) -> Option<String> {
    init_py.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("__version__")?.trim_start().strip_prefix('=')?.trim();
        let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let inner = rest[1..].split(quote).next()?;
        (!inner.is_empty()).then(|| inner.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(super::super::layout::SIDECAR_RESOURCE_PATH)
    }

    const SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn models_json(path: &str, url: &str, size: u64, sha: &str) -> String {
        format!(
            r#"{{"schema":1,"models":[{{"id":"m","role":"stt","name":"M","license":"MIT","files":[
                {{"path":"{path}","url":"{url}","size":{size},"sha256":"{sha}"}}]}}]}}"#
        )
    }

    #[test]
    fn the_shipped_model_list_parses_and_adds_up() {
        let manifest = ModelManifest::load(&sidecar()).unwrap();
        assert!(manifest.models.iter().any(|m| m.role == "stt"));
        assert!(manifest.models.iter().any(|m| m.role == "tts"));
        assert!(manifest.models.iter().any(|m| m.role == "tts-voice"));
        let by_entry: u64 = manifest.models.iter().map(ModelEntry::bytes).sum();
        assert_eq!(by_entry, manifest.total_bytes());
        // Hundreds of megabytes, not a few bytes and not tens of gigabytes: a
        // unit slip in the file would show here.
        assert!((100 << 20..2 << 30).contains(&manifest.total_bytes()), "{}", manifest.total_bytes());
        for entry in &manifest.models {
            assert!(!entry.revision.is_empty(), "{} has no pinned revision", entry.id);
            for file in &entry.files {
                assert!(file.remote.url.contains(&entry.revision), "{} is not fetched by revision", file.path);
            }
        }
    }

    fn with_voices(names: &[&str]) -> String {
        let mut entries = vec![format!(
            r#"{{"id":"m","role":"stt","name":"M","license":"MIT","files":[{{"path":"stt/a.bin","url":"https://example.org/a","size":3,"sha256":"{SHA}"}}]}}"#
        )];
        for name in names {
            entries.push(format!(
                r#"{{"id":"tts-voice-{name}","role":"tts-voice","name":"{name}","license":"CC0-1.0","files":[{{"path":"tts/{name}.bin","url":"https://example.org/{name}","size":5,"sha256":"{SHA}"}}]}}"#
            ));
        }
        format!(r#"{{"schema":1,"models":[{}]}}"#, entries.join(","))
    }

    #[test]
    fn the_shipped_list_offers_several_voices_and_alba_is_the_default() {
        let manifest = ModelManifest::load(&sidecar()).unwrap();
        let names: Vec<&str> = manifest.voices().filter_map(ModelEntry::voice).collect();
        assert!(names.len() >= 2, "{names:?}");
        assert_eq!(names[0], DEFAULT_VOICE);
        assert_eq!(manifest.resolve_voice(""), DEFAULT_VOICE);
        for entry in manifest.voices() {
            // Only licenses that allow commercial use, and each with its credit line.
            assert!(matches!(entry.license.as_str(), "CC-BY-4.0" | "CC0-1.0"), "{}: {}", entry.id, entry.license);
            assert!(entry.attribution.as_deref().is_some_and(|a| a.contains(&entry.name)), "{}", entry.id);
        }
    }

    #[test]
    fn an_installation_is_every_model_and_one_voice() {
        let manifest = ModelManifest::parse(&with_voices(&["alba", "anna", "paul"])).unwrap();
        let one = manifest.with_voice("anna");
        let ids: Vec<&str> = one.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m", "tts-voice-anna"]);
        assert_eq!(one.total_bytes(), 8);
        assert_eq!(manifest.total_bytes(), 18);
        // A list without voices is taken whole.
        let plain = ModelManifest::parse(&models_json("stt/a.bin", "https://example.org/a.bin", 3, SHA)).unwrap();
        assert_eq!(plain.with_voice("alba").models.len(), 1);
        assert_eq!(plain.resolve_voice("alba"), "");
    }

    #[test]
    fn the_chosen_voice_falls_back_to_one_the_list_has() {
        let manifest = ModelManifest::parse(&with_voices(&["anna", "alba", "paul"])).unwrap();
        assert_eq!(manifest.resolve_voice("paul"), "paul");
        assert_eq!(manifest.resolve_voice("gone"), "alba");
        assert_eq!(manifest.resolve_voice(""), "alba");
        let without_default = ModelManifest::parse(&with_voices(&["anna", "paul"])).unwrap();
        assert_eq!(without_default.resolve_voice("gone"), "anna");
        assert!(manifest.voice_entry("gone").is_none());
    }

    #[test]
    fn a_voice_with_a_name_the_sidecar_would_refuse_is_refused_here() {
        for bad in ["Anna", "an na", "a-b", ""] {
            let err = ModelManifest::parse(&with_voices(&[bad])).unwrap_err();
            assert!(err.contains("a voice it cannot use"), "{bad}: {err}");
        }
        let wrong_id = with_voices(&["anna"]).replace("\"id\":\"tts-voice-anna\"", "\"id\":\"anna\"");
        assert!(ModelManifest::parse(&wrong_id).unwrap_err().contains("a voice it cannot use"));
    }

    #[test]
    fn the_shipped_python_list_covers_every_platform_lu_ships() {
        let manifest = PythonManifest::load(&sidecar()).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(sidecar().join("python.json")).unwrap()).unwrap();
        let release = raw["release"].as_str().unwrap();
        for (os, arch) in [("macos", "aarch64"), ("windows", "x86_64"), ("linux", "x86_64")] {
            let target = super::super::layout::platform_support(os, arch, None).unwrap();
            let build = manifest.build_for(target).unwrap();
            assert!(build.remote.url.contains(target), "{}", build.remote.url);
            assert!(build.remote.url.contains(release), "{}", build.remote.url);
            assert!(build.remote.url.contains(&manifest.version), "{}", build.remote.url);
            assert_eq!(build.exe.ends_with(".exe"), os == "windows");
        }
        // The sidecar needs 3.11 or 3.12.
        let minor: u32 = manifest.version.split('.').nth(1).unwrap().parse().unwrap();
        assert!(manifest.version.starts_with("3.") && (11..=12).contains(&minor), "{}", manifest.version);
    }

    #[test]
    fn a_missing_platform_is_named() {
        let manifest = PythonManifest::load(&sidecar()).unwrap();
        let err = manifest.build_for("riscv64-unknown-linux-gnu").unwrap_err();
        assert!(err.contains("riscv64"), "{err}");
    }

    #[test]
    fn a_valid_model_list_is_accepted() {
        let m = ModelManifest::parse(&models_json("stt/a.bin", "https://example.org/a.bin", 3, SHA)).unwrap();
        assert_eq!(m.total_bytes(), 3);
        assert_eq!(m.files().next().unwrap().remote.sha256, SHA);
    }

    #[test]
    fn a_path_that_leaves_the_models_folder_is_refused() {
        for path in ["../evil.bin", "/etc/passwd", "a/../../b", "C:/x.bin", "a\\\\b.bin", ""] {
            let err = ModelManifest::parse(&models_json(path, "https://example.org/a", 3, SHA)).unwrap_err();
            assert!(err.contains("not allowed"), "{path}: {err}");
        }
    }

    #[test]
    fn a_file_without_a_usable_checksum_size_or_https_address_is_refused() {
        assert!(ModelManifest::parse(&models_json("a.bin", "https://example.org/a", 3, "abc")).is_err());
        assert!(ModelManifest::parse(&models_json("a.bin", "https://example.org/a", 3, &"z".repeat(64))).is_err());
        assert!(ModelManifest::parse(&models_json("a.bin", "https://example.org/a", 0, SHA)).is_err());
        assert!(ModelManifest::parse(&models_json("a.bin", "http://example.org/a", 3, SHA)).is_err());
    }

    #[test]
    fn a_file_listed_twice_is_refused() {
        let text = format!(
            r#"{{"schema":1,"models":[{{"id":"m","role":"stt","name":"M","license":"MIT","files":[
                {{"path":"a.bin","url":"https://e.org/a","size":3,"sha256":"{SHA}"}},
                {{"path":"a.bin","url":"https://e.org/b","size":3,"sha256":"{SHA}"}}]}}]}}"#
        );
        assert!(ModelManifest::parse(&text).unwrap_err().contains("twice"));
    }

    #[test]
    fn an_unknown_schema_and_broken_json_are_errors() {
        let newer = models_json("a.bin", "https://e.org/a", 3, SHA).replace("\"schema\":1", "\"schema\":2");
        assert!(ModelManifest::parse(&newer).unwrap_err().contains("schema 2"));
        assert!(ModelManifest::parse("{not json").unwrap_err().contains("models.json"));
        assert!(ModelManifest::parse(r#"{"schema":1,"models":[]}"#).unwrap_err().contains("no models"));
        assert!(PythonManifest::parse("[]").unwrap_err().contains("python.json"));
    }

    #[test]
    fn pins_come_out_of_the_lock_file() {
        let lock = "\
# comment
--index-url https://pypi.org/simple
pipecat-ai==1.12.0
    # via -r requirements.in
faster-whisper==1.2.1
torch==2.14.1 ; sys_platform == 'darwin'
torch==2.14.1+cpu ; sys_platform != 'darwin'
Uvicorn[standard]==0.54.0
numpy==2.3.0
";
        let pins = pinned_versions(lock, &["pipecat-ai", "faster-whisper", "torch", "uvicorn", "pocket-tts"]);
        assert_eq!(pins.get("pipecat-ai").map(String::as_str), Some("1.12.0"));
        assert_eq!(pins.get("faster-whisper").map(String::as_str), Some("1.2.1"));
        assert_eq!(pins.get("torch").map(String::as_str), Some("2.14.1"));
        assert_eq!(pins.get("uvicorn").map(String::as_str), Some("0.54.0"));
        assert!(!pins.contains_key("numpy") && !pins.contains_key("pocket-tts"));
    }

    #[test]
    fn the_shipped_lock_pins_the_packages_the_status_reports() {
        let lock = std::fs::read_to_string(sidecar().join("requirements.txt")).unwrap();
        let pins = pinned_versions(&lock, super::super::install::REPORTED_PACKAGES);
        for package in super::super::install::REPORTED_PACKAGES {
            assert!(pins.contains_key(*package), "{package} is not pinned in requirements.txt");
        }
    }

    #[test]
    fn the_sidecar_version_is_read_from_the_package() {
        assert_eq!(sidecar_version("\"\"\"doc\"\"\"\n\n__version__ = \"0.1.0\"\n").as_deref(), Some("0.1.0"));
        assert_eq!(sidecar_version("__version__='2.3'").as_deref(), Some("2.3"));
        assert_eq!(sidecar_version("version = 1"), None);
        let real = std::fs::read_to_string(sidecar().join("lu_voice_loop").join("__init__.py")).unwrap();
        assert!(sidecar_version(&real).is_some());
    }
}
