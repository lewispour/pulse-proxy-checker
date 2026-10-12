//! Launch-time update check. Compares the running version against the latest
//! GitHub release and tells the UI if a newer one is available. Notify-only —
//! no download or install. Fails silently (offline / rate-limited => no banner).

use serde::Serialize;
use tauri::AppHandle;

const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/lewispour/pulse-proxy-checker/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/lewispour/pulse-proxy-checker/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub update: bool,
    pub current: String,
    pub latest: Option<String>,
    pub url: String,
}

/// Parse "v1.2.3" / "1.2.3" into (major, minor, patch). Missing parts => 0.
fn parse_version(s: &str) -> (u64, u64, u64) {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let mut it = s.split('.').map(|p| {
        // stop at any non-digit (e.g. "3-rc1")
        let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse::<u64>().unwrap_or(0)
    });
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

/// True if `latest` is strictly newer than `current`.
fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

/// Check GitHub for a newer release. Never errors — returns `update: false`
/// on any failure so a launch check can't break or block the app.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> UpdateInfo {
    let current = app.package_info().version.to_string();
    let fallback = UpdateInfo {
        update: false,
        current: current.clone(),
        latest: None,
        url: RELEASES_PAGE.to_string(),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .user_agent("Pulse-Updater")
        .build()
    {
        Ok(c) => c,
        Err(_) => return fallback,
    };

    let resp = match client.get(LATEST_RELEASE_API).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return fallback,
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return fallback,
    };

    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    if !tag.is_empty() && is_newer(&tag, &current) {
        UpdateInfo {
            update: true,
            current,
            latest: Some(tag),
            url: html_url,
        }
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_and_compare() {
        assert_eq!(parse_version("v1.2.3"), (1, 2, 3));
        assert_eq!(parse_version("1.0"), (1, 0, 0));
        assert!(is_newer("v1.0.2", "1.0.1"));
        assert!(is_newer("1.0.10", "1.0.9")); // numeric, not lexical
        assert!(is_newer("v2.0.0", "1.9.9"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.1")); // older remote => no update
    }
}
