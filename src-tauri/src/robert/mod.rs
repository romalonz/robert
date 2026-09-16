// Robert backend: run the live capture+STT engine (macOS: the robert-engine
// sidecar; Windows: in-process, see robert_win.rs) and relay its JSON events;
// call the LLM brain (local Ollama by default, or a cloud provider); run
// keyless web research; and load grounding from the user's notes folder.
//
// This module was split out of the former single `robert.rs` into concern
// submodules. Every public path stays identical (`robert::robert_suggest`,
// `robert::RobertState`, `robert::shutdown_engine`, ...) via the `pub use`
// re-exports below, so `lib.rs` and the frontend are untouched. `mod.rs` keeps
// the engine lifecycle + the stray Desktop/window commands.

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod meetings;
mod notes_ctx;
mod providers;
mod research;

// Keep every public path identical after the split: the command surface and
// shared types (RobertState lives here) all resolve as `robert::<name>`.
pub use meetings::*;
pub use notes_ctx::*;
pub use providers::*;
pub use research::*;

// knowledge.rs references this exact path: `crate::robert::resolve_notes_folder`.
// It is pub(crate); re-export it explicitly so that path stays valid.
pub(crate) use notes_ctx::resolve_notes_folder;

/// Absolute path to the bundled engine next to the app binary. We spawn by
/// absolute path instead of Tauri's sidecar resolution, which fails to resolve
/// when the app is launched by executing its binary directly (via Robert.command).
fn engine_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "no exe dir".to_string())?;
    Ok(dir.join("robert-engine").to_string_lossy().to_string())
}

#[derive(Default)]
pub struct RobertState {
    child: Arc<Mutex<Option<CommandChild>>>,
    // Windows: the in-process engine's stop flag (no sidecar on Windows).
    #[cfg(target_os = "windows")]
    win_stop: Arc<Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>>,
}

fn kill_existing(state: &State<'_, RobertState>) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    #[cfg(target_os = "windows")]
    if let Some(stop) = state.win_stop.lock().unwrap().take() {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Kill the capture engine when the app exits, so it never orphans. Without
/// this, quitting or replacing Robert leaves the robert-engine child reparented
/// to launchd, still running WhisperKit on the browser audio for a dead parent.
pub fn shutdown_engine(app: &AppHandle) {
    let state = app.state::<RobertState>();
    kill_existing(&state);
}

#[tauri::command]
pub async fn robert_list_processes(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    // Windows v1 captures the whole system output (WASAPI loopback), so the
    // picker gets a single pseudo-entry instead of a per-process list.
    #[cfg(target_os = "windows")]
    {
        let _ = &app;
        return Ok(vec![serde_json::json!({
            "type": "process", "pid": 0, "bundle": "system.audio"
        })]);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = app
            .shell()
            .command(engine_path()?)
            .args(["--list"])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut procs = Vec::new();
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                procs.push(v);
            }
        }
        Ok(procs)
    }
}

#[tauri::command]
pub async fn robert_start(
    app: AppHandle,
    state: State<'_, RobertState>,
    target_bundle: Option<String>,
    target_pid: Option<i64>,
    model_folder: Option<String>,
    silence_ms: Option<i64>,
    output_device: Option<String>,
    mic: Option<bool>,
) -> Result<(), String> {
    kill_existing(&state);

    // Windows: run the in-process engine (WASAPI loopback + whisper.cpp)
    // instead of the macOS Swift sidecar. Same events, same frontend.
    // Microphone capture is a macOS-only feature for now (the Swift sidecar);
    // the Windows loopback path ignores `mic` (noted as a follow-up).
    #[cfg(target_os = "windows")]
    {
        let _ = (target_bundle, target_pid, model_folder, silence_ms, mic);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        *state.win_stop.lock().unwrap() = Some(stop.clone());
        let app2 = app.clone();
        // output_device = the loopback endpoint the user chose (None = default).
        std::thread::spawn(move || crate::robert_win::run_engine(app2, stop, output_device));
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
    let _ = output_device; // macOS/Linux select capture via the sidecar/args
    let mut args: Vec<String> = Vec::new();
    if let Some(pid) = target_pid {
        args.push("--pid".into());
        args.push(pid.to_string());
    } else if let Some(bundle) = target_bundle {
        args.push("--bundle".into());
        args.push(bundle);
    } else {
        return Err("provide target_pid or target_bundle".into());
    }
    // Use the bundled model if present so first start is instant and offline.
    let model_folder = model_folder.or_else(|| {
        app.path()
            .resource_dir()
            .ok()
            .map(|d| d.join("resources/models/openai_whisper-base.en"))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().to_string())
    });
    if let Some(folder) = model_folder {
        args.push("--model-folder".into());
        args.push(folder);
    }
    if let Some(ms) = silence_ms {
        args.push("--silence-ms".into());
        args.push(ms.to_string());
    }
    // Opt-in microphone capture: adds a second, isolated stream that emits the
    // user's own turns tagged who:"me". Off unless the app asks for it, so the
    // default (system-audio only) behavior is unchanged.
    if mic.unwrap_or(false) {
        args.push("--mic".into());
    }

    let (mut rx, child) = app
        .shell()
        .command(engine_path()?)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    *state.child.lock().unwrap() = Some(child);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    for line in chunk.split('\n') {
                        let line = line.trim();
                        if !line.is_empty() {
                            let _ = app2.emit("robert://event", line.to_string());
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let msg = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !msg.is_empty() {
                        eprintln!("[robert-engine] {}", msg);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app2.emit("robert://terminated", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
    }
}

#[tauri::command]
pub fn robert_stop(state: State<'_, RobertState>) -> Result<(), String> {
    kill_existing(&state);
    Ok(())
}

/// Launch the terminal updater: opens a VISIBLE PowerShell window that runs
/// update-robert.ps1 (check latest → download signed installer → close Robert →
/// install → relaunch), so the whole update is real, watchable actions. The
/// in-app Update button calls this instead of doing a silent in-app install.
#[tauri::command]
pub fn robert_terminal_update() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let ps = "$u='https://github.com/romalonz/robert/releases/download/v0.1.1/update-robert.ps1'; \
                  $s=\"$env:TEMP\\update-robert.ps1\"; \
                  try { Invoke-RestMethod $u -OutFile $s; & $s } \
                  catch { Write-Host $_.Exception.Message -ForegroundColor Red }; \
                  Read-Host 'Press Enter to close'";
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps])
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("could not open the updater terminal: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("the terminal updater is Windows-only".into())
    }
}

/// Reveal a folder in Finder / Explorer / the desktop's file manager.
#[tauri::command]
pub fn robert_open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&path).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(&path).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Resize the Robert window's height to fit its content, preserving width.
#[tauri::command]
pub fn robert_set_size(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn robert_set_height(window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let cur = window.inner_size().map_err(|e| e.to_string())?;
    let logical_w = (cur.width as f64) / scale;
    window
        .set_size(tauri::LogicalSize::new(logical_w, height))
        .map_err(|e| e.to_string())
}
