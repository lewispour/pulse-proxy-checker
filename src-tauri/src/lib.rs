//! Pulse — library root.

pub mod app;
pub mod host;
pub mod proxy;
pub mod proxy_checker_service;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
