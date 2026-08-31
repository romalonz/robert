//! Optional, anonymous usage + error telemetry to a webhook the OPERATOR owns.
//!
//! Privacy contract (do not weaken):
//!  - NEVER sends meeting content, transcripts, notes, meeting knowledge,
//!    résumé/profile text, names, or API keys. Only event names, small numeric
//!    counts, app version, OS/arch, a random install id, and short error
//!    categories.
//!  - Fully OFF unless a webhook URL is configured by the operator.
//!  - The user can opt out (settings toggle -> ROBERT_TELEMETRY_OFF marker, or
//!    the ROBERT_TELEMETRY=0 env var).
//!
//! Set your webhook one of two ways:
//!  1. Build/run with the env var:  ROBERT_TELEMETRY_URL=https://your.hook/...
//!  2. Or paste it into DEFAULT_WEBHOOK below and rebuild.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{json, Value};

// Operator: your webhook goes here (or use the ROBERT_TELEMETRY_URL env var).
// Empty string = telemetry fully disabled.
const DEFAULT_WEBHOOK: &str = "";

fn data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = std::env::var("LOCALAPPDATA").ok().map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = std::env::var("HOME").ok().map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(target_os = "linux")]
    let root = std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local/share"));
    let dir = root?.join("Robert");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Random, non-identifying install id (v4 UUID), created once and reused.
fn install_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let path = data_dir().map(|d| d.join("install_id"));
        if let Some(p) = &path {
            if let Ok(s) = std::fs::read_to_string(p) {
                let s = s.trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(p) = &path {
            let _ = std::fs::write(p, &id);
        }
        id
    })
    .clone()
}

/// User opt-out marker file (written by the settings toggle).
fn opted_out() -> bool {
    if std::env::var("ROBERT_TELEMETRY").ok().as_deref() == Some("0") {
        return true;
    }
    data_dir().map(|d| d.join("telemetry_off").exists()).unwrap_or(false)
}

fn webhook_url() -> Option<String> {
    if opted_out() {
        return None;
    }
    let url = std::env::var("ROBERT_TELEMETRY_URL")
        .ok()
        .or_else(|| option_env!("ROBERT_TELEMETRY_URL").map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT_WEBHOOK.to_string());
    let url = url.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// True when telemetry is active (a webhook is set and the user hasn't opted
/// out), so the UI can show an honest indicator.
#[tauri::command]
pub fn robert_telemetry_status() -> bool {
    webhook_url().is_some()
}

/// Turn telemetry off (or back on) for this user. Off writes a marker file.
#[tauri::command]
pub fn robert_telemetry_set(enabled: bool) -> Result<(), String> {
    let Some(dir) = data_dir() else { return Ok(()) };
    let marker = dir.join("telemetry_off");
    if enabled {
        let _ = std::fs::remove_file(&marker);
    } else {
        let _ = std::fs::write(&marker, "1");
    }
    Ok(())
}

/// Fire-and-forget an anonymous event to the operator's webhook. `props` is a
/// small JSON object of NON-CONTENT fields (counts, provider name, mode). The
/// caller must never pass transcript/notes/keys. Error strings are truncated.
#[tauri::command]
pub async fn robert_track(event: String, props: Option<Value>) {
    let Some(url) = webhook_url() else { return };
    // sanitize: cap string values so a stray long string can't smuggle content
    let props = match props {
        Some(Value::Object(mut m)) => {
            for v in m.values_mut() {
                if let Value::String(s) = v {
                    if s.len() > 200 {
                        s.truncate(200);
                    }
                }
            }
            Value::Object(m)
        }
        _ => json!({}),
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = json!({
        "install_id": install_id(),
        "event": event.chars().take(64).collect::<String>(),
        "props": props,
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "ts": ts,
    });
    // never block the app; short timeout; ignore all errors
    tokio::spawn(async move {
        if let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            let _ = client.post(&url).json(&body).send().await;
        }
    });
}
