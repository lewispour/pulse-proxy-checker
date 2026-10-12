//! Proxy-check command surface. Each command drives the bundled Node engine
//! and streams per-proxy progress to the UI via the `proxy-progress` event.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// PIDs of currently-running engine child processes, so `cancel_check` can kill
/// them when the user navigates back mid-run.
fn active_children() -> &'static Mutex<Vec<u32>> {
    static ACTIVE: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(Vec::new()))
}

fn register_child(pid: u32) {
    if let Ok(mut v) = active_children().lock() {
        v.push(pid);
    }
}

fn unregister_child(pid: u32) {
    if let Ok(mut v) = active_children().lock() {
        v.retain(|&p| p != pid);
    }
}

/// Kill all running engine children (cancels an in-flight check/find-alive).
#[tauri::command]
pub fn cancel_check() {
    let pids: Vec<u32> = active_children().lock().map(|v| v.clone()).unwrap_or_default();
    for pid in pids {
        // SIGTERM the engine; host.js handles it and exits, ending the read loop.
        let _ = Command::new("kill").arg(pid.to_string()).status();
        unregister_child(pid);
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOptions {
    #[serde(default)]
    pub concurrency: Option<u32>,
    #[serde(default)]
    pub timeout_ms: Option<u32>,
    #[serde(default)]
    pub test_url: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

// ---- Saved proxy pools (per-protocol), persisted as JSON in the app-data dir ----

fn saved_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    let dir = dir.join("saved");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create saved dir: {e}"))?;
    Ok(dir)
}

fn sanitize_protocol(p: &str) -> String {
    p.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase()
}

/// Load the saved pool for a protocol (array of proxy result objects). Empty if none.
#[tauri::command]
pub fn load_saved(app: AppHandle, protocol: String) -> Result<serde_json::Value, String> {
    let path = saved_dir(&app)?.join(format!("{}.json", sanitize_protocol(&protocol)));
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or(serde_json::json!([]))),
        Err(_) => Ok(serde_json::json!([])),
    }
}

/// Overwrite the saved pool for a protocol with `proxies` (the full deduped list).
#[tauri::command]
pub fn save_saved(
    app: AppHandle,
    protocol: String,
    proxies: serde_json::Value,
) -> Result<(), String> {
    let path = saved_dir(&app)?.join(format!("{}.json", sanitize_protocol(&protocol)));
    let bytes = serde_json::to_vec_pretty(&proxies).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write saved: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyResult {
    pub raw: String,
    pub ok: bool,
    pub status: String,
    pub latency_ms: Option<u64>,
    pub exit_ip: Option<String>,
    pub anonymous: Option<bool>,
    pub scheme: Option<String>,
    pub error: Option<String>,
}

/// Export text to a file. Writes directly to the user's Downloads folder (the
/// browser `<a download>` trick does not trigger a save inside a WKWebView).
/// Returns the path written.
#[tauri::command]
pub fn export_proxies(filename: String, content: String) -> Result<String, String> {
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or("could not resolve a download directory")?;
    // sanitize filename
    let name: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let name = if name.is_empty() { "proxies.txt".to_string() } else { name };
    let path = dir.join(name);
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub result: serde_json::Value,
    pub done: u64,
    pub total: u64,
}

// These commands are `async` and run the blocking engine read-loop inside
// `tauri::async_runtime::spawn_blocking`. This is REQUIRED for live event
// streaming: a *synchronous* command runs on the main thread and blocks the
// event loop, so `app.emit` events only flush to the webview once the command
// returns (symptom: all results appear at the end). Running the blocking loop
// on spawn_blocking keeps the event loop free so emits reach the webview live.
#[tauri::command]
pub async fn check_proxies_native(
    app: AppHandle,
    proxies: Vec<String>,
    options: Option<CheckOptions>,
) -> Result<Vec<serde_json::Value>, String> {
    let opts = options.unwrap_or_default();
    let request = serde_json::json!({
        "type": "proxy-check",
        "id": "1",
        "proxies": proxies,
        "options": {
            "concurrency": opts.concurrency.unwrap_or(25),
            "timeoutMs": opts.timeout_ms.unwrap_or(15000),
            "testUrl": opts.test_url,
        }
    });
    let msg = run_engine_async(app, request, "proxy-check-result", "results").await?;
    Ok(msg.as_array().cloned().unwrap_or_default())
}

/// Fetch free proxies from public sources (no checking). Returns the raw list.
/// `protocol` selects the source lists: http | https | socks4 | socks5.
#[tauri::command]
pub async fn fetch_free_proxies(
    app: AppHandle,
    protocol: Option<String>,
) -> Result<Vec<String>, String> {
    let request = serde_json::json!({
        "type": "fetch-free",
        "id": "1",
        "protocol": protocol.unwrap_or_else(|| "http".into()),
    });
    let msg = run_engine_async(app, request, "fetch-free-result", "proxies").await?;
    let proxies = msg
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Ok(proxies)
}

/// Fetch free proxies AND check them, streaming `proxy-progress`. Returns working ones.
#[tauri::command]
pub async fn find_alive_proxies(
    app: AppHandle,
    protocol: Option<String>,
    options: Option<CheckOptions>,
) -> Result<Vec<serde_json::Value>, String> {
    let opts = options.unwrap_or_default();
    let request = serde_json::json!({
        "type": "find-alive",
        "id": "1",
        "protocol": protocol.unwrap_or_else(|| "http".into()),
        "options": {
            "concurrency": opts.concurrency.unwrap_or(50),
            "timeoutMs": opts.timeout_ms.unwrap_or(9000),
            "testUrl": opts.test_url,
            "limit": opts.limit.unwrap_or(0),
        }
    });
    let msg = run_engine_async(app, request, "find-alive-result", "alive").await?;
    Ok(msg.as_array().cloned().unwrap_or_default())
}

/// Spawn the engine, send `request`, and pump messages. The blocking read-loop
/// runs on `spawn_blocking` so the Tauri event loop stays free and `app.emit`
/// events reach the webview LIVE (not batched at the end). Returns the value at
/// `result_field` from the first message whose `type` == `terminal_type`.
async fn run_engine_async(
    app: AppHandle,
    request: serde_json::Value,
    terminal_type: &'static str,
    result_field: &'static str,
) -> Result<serde_json::Value, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {e}"))?;
    let (program, prefix_args) = crate::host::resolve_engine_command(&resource_dir);

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&program)
            .args(&prefix_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn engine: {e}"))?;

        let pid = child.id();
        register_child(pid);

        write_message(child.stdin.as_mut().unwrap(), &request)
            .map_err(|e| format!("Error sending message: {e}"))?;

        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);

        let out = loop {
            match read_message(&mut reader) {
                Ok(Some(msg)) => {
                    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if kind == "proxy-progress" {
                        let payload = ProgressPayload {
                            result: msg.get("result").cloned().unwrap_or(serde_json::Value::Null),
                            done: msg.get("done").and_then(|v| v.as_u64()).unwrap_or(0),
                            total: msg.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                        };
                        let _ = app.emit("proxy-progress", payload);
                    } else if kind == "fetch-free-result" && terminal_type == "find-alive-result" {
                        let _ = app.emit("free-fetched", msg.clone());
                    } else if kind == terminal_type {
                        break msg.get(result_field).cloned().unwrap_or(serde_json::Value::Null);
                    }
                }
                // EOF or read error (e.g. the child was killed by cancel_check) —
                // end cleanly rather than surfacing an error.
                Ok(None) | Err(_) => break serde_json::Value::Null,
            }
        };

        unregister_child(pid);
        let _ = child.wait();
        Ok(out)
    })
    .await
    .map_err(|e| format!("engine task join error: {e}"))?
}

fn write_message<W: Write>(w: &mut W, msg: &serde_json::Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(msg)?;
    let len = bytes.len() as u32;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

fn read_message<R: BufRead>(r: &mut R) -> std::io::Result<Option<serde_json::Value>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok(Some(value))
}
