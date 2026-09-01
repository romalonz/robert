//! One-click local brain: detect Ollama and the model, install Ollama if it
//! is missing (silent installer on Windows, app bundle on macOS), start it,
//! and pull the model with progress. The 7.5 GB model cannot ship inside the
//! installer (GitHub caps release assets at 2 GB), so this is how a consumer
//! gets a working local brain without a terminal.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// Set by `robert_local_cancel`; checked inside the download and pull loops.
static CANCEL: AtomicBool = AtomicBool::new(false);

fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::Relaxed) {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn robert_local_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

#[derive(serde::Serialize, Clone)]
pub struct Recommendation {
    pub ram_gb: f64,
    pub model: String,
    pub why: String,
}

fn total_ram_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        return String::from_utf8_lossy(&out.stdout).trim().parse().ok();
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"])
            .output()
            .ok()?;
        return String::from_utf8_lossy(&out.stdout).trim().parse().ok();
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = s.lines().find(|l| l.starts_with("MemTotal"))?.split_whitespace().nth(1)?.parse().ok()?;
        return Some(kb * 1024);
    }
    #[allow(unreachable_code)]
    None
}

/// Pick the model this machine can actually run well. gemma4:12b needs about
/// 9 GB of memory while answering; below 16 GB of RAM the e4b build keeps the
/// same voice at a quarter of the footprint.
#[tauri::command]
pub fn robert_local_recommend() -> Recommendation {
    let bytes = total_ram_bytes().unwrap_or(0);
    let gb = bytes as f64 / 1_073_741_824.0;
    if bytes == 0 {
        return Recommendation { ram_gb: 0.0, model: "gemma4:12b".into(), why: "RAM unknown; default".into() };
    }
    if gb >= 15.0 {
        Recommendation { ram_gb: gb, model: "gemma4:12b".into(), why: format!("{gb:.0} GB RAM: full 12b model") }
    } else {
        Recommendation { ram_gb: gb, model: "gemma4:e4b".into(), why: format!("{gb:.0} GB RAM: lighter e4b model") }
    }
}

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

/// The Robert data folder where large model files are kept together, so a
/// fresh setup does not scatter ~13 GB across the disk. Created on demand.
pub fn robert_models_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = std::env::var("LOCALAPPDATA").ok().map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = std::env::var("HOME").ok().map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(target_os = "linux")]
    let root = std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local/share"));
    let dir = root?.join("Robert").join("models");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// True if the user already has an Ollama model store with content, so we must
/// NOT redirect OLLAMA_MODELS and hijack their existing models.
fn existing_models_present() -> bool {
    // an explicit user setting wins: respect it
    if std::env::var("OLLAMA_MODELS").is_ok() {
        return true;
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    if home.is_empty() {
        return true; // unknown; be safe and do not touch
    }
    let manifests = PathBuf::from(&home).join(".ollama").join("models").join("manifests");
    std::fs::read_dir(&manifests).map(|mut d| d.next().is_some()).unwrap_or(false)
}

/// On a FRESH setup, keep models in the Robert folder: set OLLAMA_MODELS for
/// this process (so the server/tray app we spawn inherits it) and persist it
/// (Windows setx / macOS launchctl) so it survives restarts. No-op if the user
/// already has models or set OLLAMA_MODELS themselves.
fn route_models_to_robert_folder() {
    if existing_models_present() {
        return;
    }
    let Some(dir) = robert_models_dir() else { return };
    let path = dir.to_string_lossy().to_string();
    std::env::set_var("OLLAMA_MODELS", &path);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("setx")
            .args(["OLLAMA_MODELS", &path])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("launchctl").args(["setenv", "OLLAMA_MODELS", &path]).status();
    }
}

/// Free disk space (bytes) where Robert stores its models, so onboarding can
/// warn before a multi-GB download fails halfway.
#[tauri::command]
pub fn robert_disk_free() -> u64 {
    let path = robert_models_dir()
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .or_else(|| std::env::var("USERPROFILE").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    fs4::available_space(&path).unwrap_or(0)
}

/// Where Robert keeps the models (for the UI). Empty if it is using the
/// system default (existing Ollama install).
#[tauri::command]
pub fn robert_models_location() -> String {
    if existing_models_present() {
        return String::new();
    }
    robert_models_dir().map(|d| d.to_string_lossy().to_string()).unwrap_or_default()
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

async fn start_ollama(app: &AppHandle) -> Result<(), String> {
    // Already reachable? (the installer often starts the server itself.)
    if list_models().await.is_some() {
        return Ok(());
    }

    // Kick off the server. On Windows the headless `ollama serve` is far more
    // reliable than the GUI tray app for coming up unattended; it inherits our
    // env (OLLAMA_MODELS) too. macOS opens the app; Linux runs serve.
    fn spawn_server() {
        #[cfg(target_os = "macos")]
        {
            let mut opened = false;
            for p in ["/Applications/Ollama.app".to_string(), format!("{}/Applications/Ollama.app", std::env::var("HOME").unwrap_or_default())] {
                if std::path::Path::new(&p).exists() {
                    let _ = std::process::Command::new("open").arg(&p).spawn();
                    opened = true;
                    break;
                }
            }
            if !opened {
                let _ = std::process::Command::new("open").args(["-a", "Ollama"]).spawn();
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            if let Some(bin) = ollama_binary() {
                let _ = std::process::Command::new(bin).arg("serve").creation_flags(CREATE_NO_WINDOW).spawn();
            } else if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let app = PathBuf::from(&local).join("Programs").join("Ollama").join("ollama app.exe");
                if app.exists() {
                    let _ = std::process::Command::new(app).creation_flags(CREATE_NO_WINDOW).spawn();
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Some(bin) = ollama_binary() {
                let _ = std::process::Command::new(bin).arg("serve").spawn();
            }
        }
    }

    spawn_server();

    // Poll up to 3 minutes (a fresh install can be slow to initialise), showing
    // a live countdown so it never looks frozen, and re-spawn once if it stalls.
    let start = std::time::Instant::now();
    let mut respawned = false;
    loop {
        if list_models().await.is_some() {
            return Ok(());
        }
        let secs = start.elapsed().as_secs();
        if secs > 180 {
            break;
        }
        if !respawned && secs >= 25 {
            respawned = true;
            spawn_server();
        }
        emit(app, "start", &format!("Starting Ollama… ({}s)", secs), 0, 0);
        cancelled()?;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err("Ollama is installed but its local server did not start. Open the Ollama app once from the Start menu (or restart your PC), then click Set up local brain again. You can also use a cloud brain with your own key.".into())
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
        cancelled()?;
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
        emit(app, "install", "Installing Ollama (silent)", 0, 0);
        // Inno Setup installer: silent first; if that is refused, run the
        // normal wizard so the user can click through instead of failing.
        // The installer launches the Ollama tray app when it finishes, so
        // never block on the installer alone: the binary appearing is the
        // success signal, with a hard timeout.
        let ok = run_installer_until_binary(&exe, &["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], 600).await?;
        if !ok {
            emit(app, "install", "Installing Ollama: follow the installer window", 0, 0);
            let ok = run_installer_until_binary(&exe, &[], 1800).await?;
            if !ok {
                return Err("Ollama installer did not complete".into());
            }
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
        // launch the app we just unpacked (LaunchServices may not know it yet)
        let app_path = apps.join("Ollama.app");
        let _ = std::process::Command::new("open").arg(&app_path).spawn();
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return Err("On Linux run: curl -fsSL https://ollama.com/install.sh | sh".into());
    }
}

/// Run the installer and wait until either it exits successfully or the
/// Ollama binary appears (the installer may keep running because it launched
/// the tray app). `timeout_secs` bounds the wait. Ok(false) = did not install.
#[cfg(target_os = "windows")]
async fn run_installer_until_binary(exe: &PathBuf, args: &[&str], timeout_secs: u64) -> Result<bool, String> {
    let mut child = tokio::process::Command::new(exe)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            // installer finished on its own
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            return Ok(status.success() && ollama_binary().is_some());
        }
        if ollama_binary().is_some() {
            // files are in place; give the installer a moment to finish writing
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            cancelled()?;
            return Ok(true);
        }
        if start.elapsed().as_secs() > timeout_secs {
            let _ = child.kill().await;
            return Ok(ollama_binary().is_some());
        }
        cancelled()?;
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
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
        cancelled()?;
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
    CANCEL.store(false, Ordering::Relaxed);
    route_models_to_robert_folder();
    let result: Result<(), String> = async {
        if list_models().await.is_none() {
            if ollama_binary().is_none() {
                install_ollama(&app).await?;
            }
            emit(&app, "start", "Starting Ollama", 0, 0);
            start_ollama(&app).await?;
        }
        let have = list_models().await.unwrap_or_default();
        if !have.iter().any(|m| model_matches(m, &model)) {
            // one retry: Ollama resumes partial downloads, so a dropped
            // connection just continues where it stopped
            if let Err(e) = pull_model(&app, &model).await {
                if e == "cancelled" {
                    return Err(e);
                }
                emit(&app, "pull", &format!("Retrying download ({e})"), 0, 0);
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                pull_model(&app, &model).await?;
            }
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
