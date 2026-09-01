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
    // Use the IPv4 loopback explicitly: on Windows "localhost" often resolves to
    // IPv6 ::1 first, but Ollama binds 127.0.0.1 — so "localhost" makes every
    // /api call fail to connect and the server looks like it "never started".
    std::env::var("ROBERT_OLLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into())
}

/// The address every Ollama process Robert spawns must use. OLLAMA_HOST is
/// overloaded: `ollama serve` reads it as the address to BIND, while the CLI and
/// other clients read it as the address to CONNECT to. A leftover value from a
/// prior remote setup (e.g. a Tailscale address) is therefore doubly fatal — the
/// local server can't bind an IP that isn't this machine's (it exits on loop and
/// the tray app respawns it forever), and `ollama pull` would send the download
/// to that dead remote instead of localhost. We pin it to the IPv4 loopback.
const OLLAMA_LOCAL: &str = "127.0.0.1:11434";

fn is_local_host(h: &str) -> bool {
    let h = h.trim();
    h.is_empty()
        || h.starts_with(':')
        || h.starts_with("127.")
        || h.starts_with("localhost")
        || h.starts_with("0.0.0.0")
        || h.starts_with("::1")
        || h.starts_with("[::1]")
}

/// Make sure Robert's local-brain setup always talks to a LOCAL Ollama, no
/// matter what stale OLLAMA_HOST is lying around. Overrides it for this process
/// (so every child — `ollama serve`, `ollama pull` — inherits the correct value)
/// and, on Windows, deletes a non-local value persisted in the user environment
/// so the Ollama tray app stops its endless failed-bind respawn loop.
fn force_local_ollama(app: &AppHandle) {
    if let Ok(prev) = std::env::var("OLLAMA_HOST") {
        if !is_local_host(&prev) {
            emit(
                app,
                "start",
                &format!("Ignoring OLLAMA_HOST={prev} (points off this PC) — using local Ollama"),
                0,
                0,
            );
        }
    }
    std::env::set_var("OLLAMA_HOST", OLLAMA_LOCAL);
    #[cfg(target_os = "windows")]
    clear_persisted_ollama_host();
}

/// Windows only: if the user-scope OLLAMA_HOST is set to a non-local address,
/// remove it so it stops poisoning every future Ollama start. We never touch a
/// deliberate local value.
#[cfg(target_os = "windows")]
fn clear_persisted_ollama_host() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args(["query", "HKCU\\Environment", "/v", "OLLAMA_HOST"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    if let Ok(out) = out {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let val = text
                .lines()
                .find(|l| l.contains("OLLAMA_HOST"))
                .and_then(|l| l.split_whitespace().last())
                .unwrap_or("");
            if !val.is_empty() && !is_local_host(val) {
                let _ = std::process::Command::new("reg")
                    .args(["delete", "HKCU\\Environment", "/v", "OLLAMA_HOST", "/f"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }
        }
    }
}

/// Windows only: turn the opaque "server did not start" timeout into an
/// actionable message when Ollama's own log shows it was actually a bind
/// failure (the classic leftover-OLLAMA_HOST symptom).
#[cfg(target_os = "windows")]
fn ollama_server_log_hint() -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let log = PathBuf::from(local).join("Ollama").join("server.log");
    let text = std::fs::read_to_string(&log).ok()?;
    let tail = text
        .lines()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if tail.contains("bind") || tail.contains("requested address") || tail.contains("not valid") {
        Some(
            "Ollama's server keeps failing to bind its address — usually a leftover OLLAMA_HOST \
             pointing at another machine. Robert has reset it to local; please quit Ollama from \
             the system tray (or restart your PC) and click Set up local brain again."
                .into(),
        )
    } else {
        None
    }
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
                let _ = std::process::Command::new(bin).arg("serve").env("OLLAMA_HOST", OLLAMA_LOCAL).creation_flags(CREATE_NO_WINDOW).spawn();
            } else if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let app = PathBuf::from(&local).join("Programs").join("Ollama").join("ollama app.exe");
                if app.exists() {
                    let _ = std::process::Command::new(app).env("OLLAMA_HOST", OLLAMA_LOCAL).creation_flags(CREATE_NO_WINDOW).spawn();
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Some(bin) = ollama_binary() {
                let _ = std::process::Command::new(bin).arg("serve").env("OLLAMA_HOST", OLLAMA_LOCAL).spawn();
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
    #[cfg(target_os = "windows")]
    if let Some(hint) = ollama_server_log_hint() {
        return Err(hint);
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
/// Download a model. Prefer driving the `ollama` CLI directly — it talks to the
/// server over Ollama's own client (never our reqwest/localhost path), resumes
/// partial downloads natively, and is immune to the IPv6/localhost and proxy
/// quirks that make the HTTP /api/pull flow stall on some Windows machines.
/// Falls back to the HTTP API if the CLI binary can't be located or launched.
async fn pull_model(app: &AppHandle, model: &str) -> Result<(), String> {
    if ollama_binary().is_some() {
        match pull_via_cli(app, model).await {
            Ok(()) => return Ok(()),
            Err(e) if e == "cancelled" => return Err(e),
            Err(e) => {
                // CLI path failed for some other reason — try the HTTP API before
                // giving up, so we degrade gracefully rather than hard-fail.
                emit(app, "pull", &format!("Retrying via API ({e})"), 0, 0);
            }
        }
    }
    pull_via_http(app, model).await
}

/// Run `ollama pull <model>` as a subprocess and translate its live output into
/// `robert://local` progress events. Ollama writes its progress bar and status
/// lines to stderr (using \r to redraw), so we read stderr, split on \r/\n, and
/// pull a percentage out of each segment. On Windows we spawn it headless (no
/// flashing console window). Cancellation kills the child.
async fn pull_via_cli(app: &AppHandle, model: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    let bin = ollama_binary().ok_or_else(|| "ollama binary not found".to_string())?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("pull")
        .arg(model)
        .env("OLLAMA_HOST", OLLAMA_LOCAL)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not launch ollama pull: {e}"))?;
    let mut err = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr from ollama".to_string())?;

    emit(app, "pull", &format!("Downloading {model}…"), 0, 0);

    let mut raw = [0u8; 4096];
    let mut seg = String::new();
    let mut tail = String::new();
    let mut last = std::time::Instant::now();
    loop {
        if cancelled().is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err("cancelled".to_string());
        }
        // Short read timeout so we re-check cancellation even when Ollama is
        // quiet (e.g. verifying a large layer).
        match tokio::time::timeout(std::time::Duration::from_millis(500), err.read(&mut raw)).await {
            Err(_) => continue,
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                let s = String::from_utf8_lossy(&raw[..n]);
                for ch in s.chars() {
                    if ch == '\r' || ch == '\n' {
                        process_pull_segment(app, model, seg.trim(), &mut tail, &mut last);
                        seg.clear();
                    } else {
                        seg.push(ch);
                    }
                }
            }
            Ok(Err(e)) => return Err(format!("reading ollama output: {e}")),
        }
    }
    if !seg.trim().is_empty() {
        process_pull_segment(app, model, seg.trim(), &mut tail, &mut last);
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        emit(app, "pull", &format!("Downloading {model}: success"), 100, 100);
        Ok(())
    } else {
        let msg = tail.trim();
        let msg = msg.lines().last().unwrap_or("").trim();
        if msg.is_empty() {
            Err("ollama pull failed".to_string())
        } else {
            Err(msg.to_string())
        }
    }
}

/// Turn one line/segment of `ollama pull` output into a progress event.
fn process_pull_segment(
    app: &AppHandle,
    model: &str,
    seg: &str,
    tail: &mut String,
    last: &mut std::time::Instant,
) {
    if seg.is_empty() {
        return;
    }
    // Keep a rolling tail of non-progress lines for error reporting.
    if !seg.contains('%') {
        tail.push_str(seg);
        tail.push('\n');
        if tail.len() > 2000 {
            *tail = tail[tail.len() - 2000..].to_string();
        }
    }
    if let Some(pct) = parse_percent(seg) {
        if last.elapsed().as_millis() > 250 || pct >= 100 {
            emit(app, "pull", &format!("Downloading {model}… {pct}%"), pct as u64, 100);
            *last = std::time::Instant::now();
        }
    } else if last.elapsed().as_millis() > 250 {
        // A status phrase like "pulling manifest" / "verifying sha256 digest".
        emit(app, "pull", &format!("Downloading {model}: {seg}"), 0, 0);
        *last = std::time::Instant::now();
    }
}

/// Extract the integer immediately preceding a `%` (e.g. `45` from `... 45% ...`).
fn parse_percent(s: &str) -> Option<u32> {
    let bytes = s.as_bytes();
    let pos = s.find('%')?;
    let mut i = pos;
    let mut digits: Vec<u8> = Vec::new();
    while i > 0 {
        i -= 1;
        if bytes[i].is_ascii_digit() {
            digits.push(bytes[i]);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    digits.reverse();
    let num: u32 = std::str::from_utf8(&digits).ok()?.parse().ok()?;
    (num <= 100).then_some(num)
}

async fn pull_via_http(app: &AppHandle, model: &str) -> Result<(), String> {
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
    // Before anything else: guarantee we drive a LOCAL Ollama. A stale OLLAMA_HOST
    // pointing off this machine otherwise makes the server exit-loop on bind and
    // sends `ollama pull` to the wrong host — the download never even starts.
    force_local_ollama(&app);
    route_models_to_robert_folder();
    let result: Result<(), String> = async {
        if list_models().await.is_none() {
            if ollama_binary().is_none() {
                install_ollama(&app).await?;
            }
            emit(&app, "start", "Starting Ollama", 0, 0);
            // Best-effort: this spawns `ollama serve` and waits for it. Even if
            // the wait times out, the server process is still coming up, and the
            // CLI `ollama pull` below drives it directly — so don't hard-fail the
            // whole setup on a slow start.
            let _ = start_ollama(&app).await;
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
