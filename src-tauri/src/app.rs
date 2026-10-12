//! App setup / plugin registration.
//!
//! Plugins: store, fs, dialog,
//! opener, event, menu, path, image, deep-link, updater, process.
//! (No auto-updater plugin.)

use tauri::Builder;

pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            crate::proxy_checker_service::check_proxies_native,
            crate::proxy_checker_service::fetch_free_proxies,
            crate::proxy_checker_service::find_alive_proxies,
            crate::proxy_checker_service::cancel_check,
            crate::proxy_checker_service::load_saved,
            crate::proxy_checker_service::save_saved,
            crate::proxy_checker_service::export_proxies,
            crate::update::check_for_update,
            install_native_host_cmd,
            install_firefox_native_host_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Optional: install the Chrome native-messaging manifest.
/// `allowed_origins` is caller-supplied; empty by default.
#[tauri::command]
fn install_native_host_cmd(
    app: tauri::AppHandle,
    allowed_origins: Vec<String>,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bin = crate::host::resolve_host_binary(&dir)
        .ok_or("Failed to resolve PulseEngine")?;
    let path = crate::host::install_native_host(&bin, &allowed_origins)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn install_firefox_native_host_cmd(
    app: tauri::AppHandle,
    allowed_extensions: Vec<String>,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bin = crate::host::resolve_host_binary(&dir)
        .ok_or("Failed to resolve PulseEngine")?;
    let path = crate::host::install_firefox_native_host(&bin, &allowed_extensions)?;
    Ok(path.to_string_lossy().to_string())
}
