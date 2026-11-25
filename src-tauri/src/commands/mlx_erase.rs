//! Fast local object removal on macOS using LaMa (`big-lama.pt`).
//!
//! On Windows and Linux, Erase was retired into promptless masked Edit (and
//! LU Cloud keeps its hosted Erase endpoint). On Apple Silicon, masked
//! diffusion inpainting hallucinates over the surrounding textures and takes
//! ~40s, whereas LaMa removes unwanted objects cleanly along mask contours in
//! a few seconds on Metal (`mps`) using the already-installed `mlx/venv`
//! PyTorch runtime.
//!
//! Security & runtime layout:
//! - Both `image` and `mask` must point to staged files inside
//!   `staged_images_dir()` (canonical path check matching `mlx_cutout.rs`).
//! - The ~205 MB `big-lama.pt` weights download once on first Erase run into
//!   `<data_dir>/mlx/lama/big-lama.pt` and are verified against a pinned
//!   SHA-256 digest before execution.
//! - The helper script (`resources/mlx/erase_lama.py`) is embedded and written
//!   next to `server.py` under `<data_dir>/mlx/`.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::commands::CmdResult;
use crate::state::AppState;

pub(crate) const NO_IMAGE: &str = "Add an image to erase from.";
pub(crate) const NO_MASK: &str = "Paint over the object or area you want to erase.";
const GONE_IMAGE: &str = "The image to erase from is no longer on disk. Add it again.";
const GONE_MASK: &str = "The painted mask is no longer on disk. Paint it again.";
const NO_PYTHON: &str = "Local Erase needs the Mac image runtime. Open Settings or Image to install it, or try again after setup.";
#[cfg(not(target_os = "macos"))]
const MAC_ONLY: &str = "Fast local LaMa Erase runs on macOS only.";

const LAMA_MODEL_URL: &str = "https://github.com/enesmsahin/simple-lama-inpainting/releases/download/v0.1.0/big-lama.pt";
const LAMA_MODEL_BYTES: u64 = 205_803_670;
const LAMA_MODEL_SHA256: &str = "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c";
const ERASE_TIMEOUT_SECS: u64 = 120;

#[cfg(target_os = "macos")]
const ERASE_LAMA_PY: &str = include_str!("../../resources/mlx/erase_lama.py");

/// Validate that a caller-supplied path lives inside `staged` (`start-images/`),
/// preventing arbitrary filesystem reads from the webview.
pub(crate) fn staged_input_with(asked: &str, staged: &Path, empty_msg: &str, gone_msg: &str) -> Result<PathBuf, String> {
    if asked.trim().is_empty() {
        return Err(empty_msg.to_string());
    }
    let staged = staged.canonicalize().map_err(|_| gone_msg.to_string())?;
    Path::new(asked)
        .canonicalize()
        .ok()
        .filter(|p| p.is_file() && p.starts_with(&staged))
        .ok_or_else(|| gone_msg.to_string())
}

fn feather_px(args: &Value) -> u32 {
    args.get("featherPx")
        .or_else(|| args.get("growMaskBy"))
        .and_then(Value::as_u64)
        .map(|v| v.min(64) as u32)
        .unwrap_or(6)
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct HelperOutput {
    width: u32,
    height: u32,
    device: String,
}

fn parse_helper_output(stdout: &str) -> Option<HelperOutput> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|line| serde_json::from_str::<HelperOutput>(line).ok())
}

#[cfg(target_os = "macos")]
mod runtime {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::process::Stdio;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    static LAMA_DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

    pub(super) fn mlx_root() -> PathBuf {
        crate::os_paths::data_dir().join("mlx")
    }

    pub(super) fn find_python(root: &Path) -> Result<PathBuf, String> {
        let candidates = [
            root.join("venv").join("bin").join("python"),
            root.join("venv-mflux").join("bin").join("python"),
        ];
        candidates
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(|| NO_PYTHON.to_string())
    }

    pub(super) fn ensure_helper_script(root: &Path) -> Result<PathBuf, String> {
        std::fs::create_dir_all(root)
            .map_err(|e| format!("Could not create {}: {}", root.display(), crate::os_error::english(&e)))?;
        let path = root.join("erase_lama.py");
        let current = std::fs::read_to_string(&path).ok();
        if current.as_deref() != Some(ERASE_LAMA_PY) {
            std::fs::write(&path, ERASE_LAMA_PY)
                .map_err(|e| format!("Could not write {}: {}", path.display(), crate::os_error::english(&e)))?;
        }
        Ok(path)
    }

    fn sha256_file(path: &Path) -> Result<(u64, String), String> {
        let mut file = std::fs::File::open(path)
            .map_err(|e| format!("Could not read {}: {}", path.display(), crate::os_error::english(&e)))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| format!("Could not hash {}: {}", path.display(), crate::os_error::english(&e)))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            hasher.update(&buf[..n]);
        }
        let hex = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        Ok((total, hex))
    }

    pub(super) fn ensure_lama_model(root: &Path) -> Result<PathBuf, String> {
        let _guard = LAMA_DOWNLOAD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = root.join("lama");
        let dest = dir.join("big-lama.pt");
        if dest.is_file() {
            if let Ok((len, digest)) = sha256_file(&dest) {
                if len == LAMA_MODEL_BYTES && digest == LAMA_MODEL_SHA256 {
                    return Ok(dest);
                }
            }
        }

        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create {}: {}", dir.display(), crate::os_error::english(&e)))?;
        let part = dir.join("big-lama.pt.part");
        let _ = std::fs::remove_file(&part);

        tracing::info!("[erase] downloading big-lama.pt ({LAMA_MODEL_BYTES} bytes)");
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(600))
            .user_agent(crate::app_identity::outgoing_agent!("3.1"))
            .build()
            .map_err(|e| format!("HTTP client setup failed for Erase model download: {}", crate::os_error::english(&e.without_url())))?;

        let mut resp = client
            .get(LAMA_MODEL_URL)
            .send()
            .map_err(|e| format!("Failed to download Erase model: {}", crate::os_error::english(&e.without_url())))?;
        if !resp.status().is_success() {
            return Err(format!("Erase model download returned HTTP {}", resp.status()));
        }

        let mut out = std::fs::File::create(&part)
            .map_err(|e| format!("Could not create {}: {}", part.display(), crate::os_error::english(&e)))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut downloaded: u64 = 0;
        loop {
            let n = resp
                .read(&mut buf)
                .map_err(|e| {
                    let _ = std::fs::remove_file(&part);
                    format!("Erase model download interrupted: {}", crate::os_error::english(&e))
                })?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| {
                let _ = std::fs::remove_file(&part);
                format!("Could not write Erase model: {}", crate::os_error::english(&e))
            })?;
            hasher.update(&buf[..n]);
            downloaded += n as u64;
        }
        drop(out);

        let digest = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if downloaded != LAMA_MODEL_BYTES || digest != LAMA_MODEL_SHA256 {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "Downloaded Erase model failed integrity check (got {downloaded} bytes, sha256 {digest})."
            ));
        }

        std::fs::rename(&part, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("Could not finalize Erase model: {}", crate::os_error::english(&e))
        })?;
        Ok(dest)
    }

    pub(super) fn run_lama(image: &Path, mask: &Path, out_dir: &Path, feather: u32) -> Result<(PathBuf, u32, u32, String), String> {
        let root = mlx_root();
        let python = find_python(&root)?;
        let script = ensure_helper_script(&root)?;
        let model = ensure_lama_model(&root)?;

        std::fs::create_dir_all(out_dir)
            .map_err(|e| format!("Could not create {}: {}", out_dir.display(), crate::os_error::english(&e)))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = out_dir.join(format!("erase-{stamp}-{}.png", std::process::id()));

        let mut cmd = crate::process_util::hidden_command(&python);
        cmd.arg(&script)
            .arg("--model")
            .arg(&model)
            .arg("--image")
            .arg(image)
            .arg("--mask")
            .arg(mask)
            .arg("--out")
            .arg(&out)
            .arg("--feather")
            .arg(feather.to_string())
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start local Erase runtime: {}", crate::os_error::english(&e)))?;

        let deadline = Instant::now() + Duration::from_secs(ERASE_TIMEOUT_SECS);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&out);
                    return Err(format!("Erase timed out after {ERASE_TIMEOUT_SECS}s."));
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = std::fs::remove_file(&out);
                    return Err(format!("Erase runtime failed while waiting: {}", crate::os_error::english(&e)));
                }
            }
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Erase runtime output error: {}", crate::os_error::english(&e)))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            let _ = std::fs::remove_file(&out);
            let detail = stderr.trim();
            return Err(if detail.is_empty() {
                format!("Local Erase failed (exit {}).", output.status)
            } else {
                format!("Local Erase failed: {}", crate::os_error::english_child_text(detail))
            });
        }

        if !out.is_file() {
            return Err("Local Erase finished without writing an output image.".to_string());
        }

        if let Some(meta) = parse_helper_output(&stdout) {
            return Ok((out, meta.width, meta.height, meta.device));
        }

        let (width, height) = image::image_dimensions(&out)
            .map_err(|e| format!("Could not inspect Erase output dimensions ({e})."))?;
        Ok((out, width, height, "mps".to_string()))
    }
}

/// `mlx_erase`: `args.image` and `args.mask` are paths to staged files.
/// Returns `{ image_base64, width, height, output, device }`, matching `mlx_cutout`.
pub fn mlx_erase(_state: &AppState, args: &Value) -> CmdResult {
    let image_arg = args.get("image").and_then(Value::as_str).unwrap_or_default();
    let mask_arg = args.get("mask").and_then(Value::as_str).unwrap_or_default();
    let feather = feather_px(args);

    #[cfg(target_os = "macos")]
    {
        use base64::Engine as _;
        let staged = crate::commands::mlx_cutout::staged_images_dir();
        let image = staged_input_with(image_arg, &staged, NO_IMAGE, GONE_IMAGE)
            .map_err(crate::commands::bad_request)?;
        let mask = staged_input_with(mask_arg, &staged, NO_MASK, GONE_MASK)
            .map_err(crate::commands::bad_request)?;

        let started = std::time::Instant::now();
        let (out, width, height, device) =
            runtime::run_lama(&image, &mask, &crate::commands::mlx::images_root(), feather)
                .map_err(crate::commands::bad_request)?;
        tracing::info!(
            "[erase] {width}x{height} via {device} in {} ms",
            started.elapsed().as_millis()
        );
        let bytes = std::fs::read(&out)
            .map_err(|e| crate::commands::internal(format!("read {}: {}", out.display(), crate::os_error::english(&e))))?;
        Ok(serde_json::json!({
            "image_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "width": width,
            "height": height,
            "output": out.to_string_lossy(),
            "device": device,
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (image_arg, mask_arg, feather);
        Err(crate::commands::bad_request(MAC_ONLY))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn feather_defaults_and_clamps_to_safe_bounds() {
        assert_eq!(feather_px(&json!({})), 6);
        assert_eq!(feather_px(&json!({ "featherPx": 12 })), 12);
        assert_eq!(feather_px(&json!({ "growMaskBy": 4 })), 4);
        assert_eq!(feather_px(&json!({ "featherPx": 999 })), 64);
    }

    #[test]
    fn parse_helper_output_reads_last_json_line() {
        let out = "warning line\n{\"width\": 1024, \"height\": 768, \"device\": \"mps\"}\n";
        assert_eq!(
            parse_helper_output(out),
            Some(HelperOutput {
                width: 1024,
                height: 768,
                device: "mps".to_string(),
            })
        );
        assert_eq!(parse_helper_output("not json"), None);
    }

    #[test]
    fn staged_input_with_enforces_stage_directory_jail() {
        let root = tempfile::tempdir().unwrap();
        let staged = root.path().join("start-images");
        std::fs::create_dir_all(&staged).unwrap();
        let inside = staged.join("mask.png");
        std::fs::write(&inside, b"png").unwrap();
        let outside = root.path().join("escape.png");
        std::fs::write(&outside, b"png").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert_eq!(
            staged_input_with(&s(&inside), &staged, NO_MASK, GONE_MASK).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert_eq!(
            staged_input_with(&s(&outside), &staged, NO_MASK, GONE_MASK).unwrap_err(),
            GONE_MASK
        );
        assert_eq!(
            staged_input_with(&s(&staged.join("..").join("escape.png")), &staged, NO_MASK, GONE_MASK).unwrap_err(),
            GONE_MASK
        );
        assert_eq!(
            staged_input_with("", &staged, NO_MASK, GONE_MASK).unwrap_err(),
            NO_MASK
        );
    }
}
