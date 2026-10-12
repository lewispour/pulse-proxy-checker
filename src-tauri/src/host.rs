//! Engine (sidecar) management + optional browser native-messaging installer.
//!
//! Writes Chrome/Firefox native-messaging host manifests pointing at the engine
//! binary. Browser-extension allow-lists are caller-supplied (empty by default),
//! so the native-messaging integration is opt-in.

use serde_json::json;
use std::path::PathBuf;

pub const HOST_NAME: &str = "com.pulse.host";
pub const HOST_DESCRIPTION: &str = "Pulse native messaging host";

/// Resolve the bundled engine binary (`assets/PulseEngine`, or `.exe` on Windows).
pub fn resolve_host_binary(resource_dir: &PathBuf) -> Option<PathBuf> {
    let assets = resource_dir.join("assets");
    for name in ["PulseEngine", "PulseEngine.exe"] {
        let candidate = assets.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Dev-mode engine invocation. If `PulseEngine` isn't bundled (e.g. `tauri dev`),
/// fall back to running the Node source directly via `node host/src/host.js`.
/// Returns (program, prefix_args).
pub fn resolve_engine_command(resource_dir: &PathBuf) -> (String, Vec<String>) {
    if let Some(bin) = resolve_host_binary(resource_dir) {
        return (bin.to_string_lossy().to_string(), vec![]);
    }
    // dev fallback: ../host/src/host.js relative to the crate
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("host")
        .join("src")
        .join("host.js");
    ("node".to_string(), vec![dev.to_string_lossy().to_string()])
}

/// Chrome native-messaging manifest directory (macOS).
fn chrome_nm_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
    })
}

/// Firefox native-messaging manifest directory (macOS).
fn firefox_nm_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library/Application Support/Mozilla/NativeMessagingHosts")
    })
}

/// Install the Chrome native-messaging host manifest.
/// `allowed_origins` defaults to empty — browser extension ids are NOT
/// written unless the caller explicitly supplies it.
pub fn install_native_host(
    host_binary: &PathBuf,
    allowed_origins: &[String],
) -> Result<PathBuf, String> {
    let dir = chrome_nm_dir().ok_or("cannot determine Chrome NM directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": host_binary.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": allowed_origins,
    });
    let path = dir.join(format!("{HOST_NAME}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap())
        .map_err(|e| format!("write manifest: {e}"))?;
    Ok(path)
}

/// Install the Firefox native-messaging host manifest.
pub fn install_firefox_native_host(
    host_binary: &PathBuf,
    allowed_extensions: &[String],
) -> Result<PathBuf, String> {
    let dir = firefox_nm_dir().ok_or("cannot determine Firefox NM directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let manifest = json!({
        "name": HOST_NAME,
        "description": HOST_DESCRIPTION,
        "path": host_binary.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": allowed_extensions,
    });
    let path = dir.join(format!("{HOST_NAME}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap())
        .map_err(|e| format!("write manifest: {e}"))?;
    Ok(path)
}
