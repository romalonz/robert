//! One-click local brain: detect Ollama and the model, install Ollama if it
//! is missing (silent installer on Windows, app bundle on macOS), start it,
//! and pull the model with progress. The 7.5 GB model cannot ship inside the
//! installer (GitHub caps release assets at 2 GB), so this is how a consumer
//! gets a working local brain without a terminal.

use std::path::PathBuf;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

fn base_url() -> String {
    std::env::var("ROBERT_OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".into())
}

#[derive(serde::Serialize, Clone)]
pub struct LocalStatus {
    pub installed: bool,
    pub running: bool,
    pub models: Vec<String>,
    pub has_model: bool,
}

#[derive(serde::Serialize, Clone)]
struct Progress {
    stage: String,   // "download" | "install" | "start" | "pull" | "done" | "error"
    status: String,  // human line
    completed: u64,
    total: u64,
}

fn emit(app: &AppHandle, stage: &str, status: &str, completed: u64, total: u64) {
    let _ = app.emit(
        "robert://local",
        Progress {
            stage: stage.into(),
            status: status.into(),
            completed,
            total,
        },
    );
}

fn ollama_binary() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        for p in [
            "/Applications/Ollama.app/Contents/Resources/ollama",
            "/usr/local/bin/ollama",
            "/opt/homebrew/bin/ollama",
        ] {
            if std::path::Path::new(p).exists() {
                return Some(PathBuf::from(p));
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let p = PathBuf::from(home).join("Applications/Ollama.app/Contents/Resources/ollama");
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(local).join("Programs").join("Ollama").join("ollama.exe");
            if p.exists() {
                return Some(p);
            }
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            let p = PathBuf::from(pf).join("Ollama").join("ollama.exe");
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for p in ["/usr/local/bin/ollama", "/usr/bin/ollama"] {
            if std::path::Path::new(p).exists() {
                return Some(PathBuf::from(p));
            }
        }
    }
    None
}

async fn list_models() -> Option<Vec<String>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let v: serde_json::Value = client
        .get(format!("{}/api/tags", base_url()))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    Some(
        v["models"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn model_matches(have: &str, want: &str) -> bool {
    if have == want {
        return true;
    }
    // "gemma4:12b" also satisfied by an exact tag the user typed without one
    !want.contains(':') && have.split(':').next() == Some(want)
}

#[tauri::command]
pub async fn robert_local_status(model: String) -> Result<LocalStatus, String> {
    let models = list_models().await;
    let running = models.is_some();
    let models = models.unwrap_or_default();
    let has_model = models.iter().any(|m| model_matches(m, &model));
    Ok(LocalStatus {
        installed: running || ollama_binary().is_some(),
        running,
        models,
        has_model,
    })
}

async fn start_ollama() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").args(["-a", "Ollama"]).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        // the tray app starts the server; fall back to `ollama serve`
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let app = PathBuf::from(&local).join("Programs").join("Ollama").join("ollama app.exe");
            if app.exists() {
                let _ = std::process::Command::new(app).spawn();
            } else if let Some(bin) = ollama_binary() {
                let _ = std::process::Command::new(bin).arg("serve").spawn();
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(bin) = ollama_binary() {
            let _ = std::process::Command::new(bin).arg("serve").spawn();
        }
    }
    for _ in 0..60 {
        if list_models().await.is_some() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err("Ollama did not start within 60 seconds".into())
}

async fn download(app: &AppHandle, url: &str, dest: &PathBuf, label: &str) -> Result<(), String> {
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut done: u64 = 0;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 300 {
            emit(app, "download", label, done, total);
            last = std::time::Instant::now();
        }
    }
    emit(app, "download", label, done, total.max(done));
    Ok(())
}

async fn install_ollama(app: &AppHandle) -> Result<(), String> {
    let tmp = std::env::temp_dir();
    #[cfg(target_os = "windows")]
    {
        let exe = tmp.join("OllamaSetup.exe");
        download(app, "https://ollama.com/download/OllamaSetup.exe", &exe, "Downloading Ollama").await?;
        emit(app, "install", "Installing Ollama", 0, 0);
        let status = tokio::process::Command::new(&exe)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("Ollama installer exited with {status}"));
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let zip = tmp.join("Ollama-darwin.zip");
        download(app, "https://ollama.com/download/Ollama-darwin.zip", &zip, "Downloading Ollama").await?;
        emit(app, "install", "Installing Ollama", 0, 0);
        let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
        let apps = PathBuf::from(home).join("Applications");
        let _ = std::fs::create_dir_all(&apps);
        // ditto keeps the .app bundle's symlinks and permissions intact
        let status = tokio::process::Command::new("ditto")
            .args(["-x", "-k", &zip.to_string_lossy(), &apps.to_string_lossy()])
            .status()
            .await
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("could not unpack Ollama".into());
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return Err("On Linux run: curl -fsSL https://ollama.com/install.sh | sh".into());
    }
}

/// Pull a model with progress events. Ollama streams JSON lines:
/// {"status":"pulling ...","digest":..,"total":..,"completed":..}
async fn pull_model(app: &AppHandle, model: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60 * 3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/api/pull", base_url()))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("pull failed: HTTP {}", resp.status()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf = buf[nl + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(err) = v["error"].as_str() {
                    return Err(format!("pull: {err}"));
                }
                let status = v["status"].as_str().unwrap_or("").to_string();
                let total = v["total"].as_u64().unwrap_or(0);
                let completed = v["completed"].as_u64().unwrap_or(0);
                if last.elapsed().as_millis() > 300 || status == "success" {
                    emit(app, "pull", &format!("Downloading {model}: {status}"), completed, total);
                    last = std::time::Instant::now();
                }
            }
        }
    }
    Ok(())
}

/// Everything a consumer needs, in one call: install Ollama if missing, start
/// it, pull the model. Progress arrives on the "robert://local" event.
#[tauri::command]
pub async fn robert_setup_local(app: AppHandle, model: String) -> Result<LocalStatus, String> {
    let result: Result<(), String> = async {
        if list_models().await.is_none() {
            if ollama_binary().is_none() {
                install_ollama(&app).await?;
            }
            emit(&app, "start", "Starting Ollama", 0, 0);
            start_ollama().await?;
        }
        let have = list_models().await.unwrap_or_default();
        if !have.iter().any(|m| model_matches(m, &model)) {
            pull_model(&app, &model).await?;
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            emit(&app, "done", "Local brain ready", 1, 1);
            robert_local_status(model).await
        }
        Err(e) => {
            emit(&app, "error", &e, 0, 0);
            Err(e)
        }
    }
}
