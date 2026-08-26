// Robert backend: run the live capture+STT engine (macOS: the robert-engine
// sidecar; Windows: in-process, see robert_win.rs) and relay its JSON events;
// call the LLM brain (local Ollama by default, or a cloud provider); run
// keyless web research; and load grounding from the user's notes folder.

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
) -> Result<(), String> {
    kill_existing(&state);

    // Windows: run the in-process engine (WASAPI loopback + whisper.cpp)
    // instead of the macOS Swift sidecar. Same events, same frontend.
    #[cfg(target_os = "windows")]
    {
        let _ = (target_bundle, target_pid, model_folder, silence_ms);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        *state.win_stop.lock().unwrap() = Some(stop.clone());
        let app2 = app.clone();
        std::thread::spawn(move || crate::robert_win::run_engine(app2, stop));
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
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

#[derive(serde::Deserialize)]
struct DsResp {
    choices: Vec<DsChoice>,
}
#[derive(serde::Deserialize)]
struct DsChoice {
    message: DsMsg,
}
#[derive(serde::Deserialize)]
struct DsMsg {
    content: String,
}

/// Cloud brain over any OpenAI-compatible chat API (DeepSeek, OpenAI, Groq,
/// Gemini's OpenAI endpoint, OpenRouter, or a custom base URL). Non-streaming.
/// The grounding goes in `system`, the turn in `user`.
#[tauri::command]
pub async fn robert_suggest(
    api_key: String,
    model: String,
    system: String,
    user: String,
    base_url: Option<String>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("missing API key for the selected provider".into());
    }
    let base = base_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://api.deepseek.com/v1".into());
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": if model.is_empty() { "deepseek-chat" } else { &model },
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "stream": false,
        "max_tokens": 320
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let code = res.status();
        let txt = res.text().await.unwrap_or_default();
        return Err(format!("cloud brain {}: {}", code, txt));
    }
    let parsed: DsResp = res.json().await.map_err(|e| e.to_string())?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "empty response from the cloud brain".to_string())
}

/// Anthropic Claude brain (native Messages API — not OpenAI-compatible).
/// No temperature/top_p (removed on current Claude models); adaptive thinking
/// is the model default, `effort: low` keeps live-call latency down. Checks
/// `stop_reason` for refusals before reading content.
#[tauri::command]
pub async fn robert_suggest_anthropic(
    api_key: String,
    model: String,
    system: String,
    user: String,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("missing Anthropic API key".into());
    }
    let body = serde_json::json!({
        "model": if model.is_empty() { "claude-opus-5" } else { &model },
        "max_tokens": 640,
        "output_config": {"effort": "low"},
        "system": system,
        "messages": [
            {"role": "user", "content": user}
        ]
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let code = res.status();
        let txt = res.text().await.unwrap_or_default();
        return Err(format!("Claude {}: {}", code, txt));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if v.get("stop_reason").and_then(|s| s.as_str()) == Some("refusal") {
        return Err("Claude declined this request (safety refusal).".into());
    }
    let text = v
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|blocks| {
            blocks
                .iter()
                .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "empty response from Claude".to_string())?;
    if text.is_empty() {
        return Err("empty response from Claude".into());
    }
    Ok(text)
}

// GGUF (llama.cpp) build, NOT the -mlx tag: the MLX runner crashed with Metal
// command-buffer/OOM failures under GPU contention (Brave video + Whisper +
// LLM), which surfaced as "local brain 500" in the UI. llama.cpp is stable
// under the same load.
const LOCAL_DEFAULT_MODEL: &str = "gemma4:12b";

/// Context window for the local brain, derived from the SYSTEM prompt only.
/// Ollama's default num_ctx (4096) silently truncates a big grounding, which
/// lobotomizes the model. Sizing from the system prompt alone (never the
/// per-turn user text) keeps num_ctx identical across every call of a meeting,
/// so Ollama reuses the loaded runner and its KV prefix cache instead of
/// re-evaluating the grounding each turn.
fn local_num_ctx(system: &str) -> u64 {
    let est_tokens = (system.len() as u64) / 3; // conservative chars->tokens
    let needed = est_tokens + 4096; // headroom: history + turn + output
    let rounded = needed.div_ceil(4096) * 4096;
    rounded.clamp(8192, 65536)
}

/// One /api/chat call to the local Ollama brain. `think:false` suppresses
/// chain-of-thought so we get a clean speakable line; if the model doesn't
/// support the think flag, retry once without it.
async fn ollama_chat(
    model: &str,
    system: &str,
    user: &str,
    num_predict: u64,
) -> Result<String, String> {
    let base = std::env::var("ROBERT_OLLAMA_URL")
        .unwrap_or_else(|_| "http://localhost:11434".into());
    let url = format!("{}/api/chat", base);
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "stream": false,
        "think": false,
        "keep_alive": "60m",
        "options": {
            "num_ctx": local_num_ctx(system),
            "num_predict": num_predict,
            "temperature": 0.4
        }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    for attempt in 0..3 {
        let res = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("local brain unreachable at {}: {} (is Ollama running?)", base, e))?;
        if !res.status().is_success() {
            let code = res.status();
            let txt = res.text().await.unwrap_or_default();
            // some models reject the think flag; drop it and retry once
            if attempt < 2 && txt.contains("think") {
                body.as_object_mut().map(|o| o.remove("think"));
                continue;
            }
            // a crashed runner (Metal/OOM) returns 5xx once; Ollama respawns
            // it, so one delayed retry usually recovers mid-meeting
            if attempt < 2 && code.is_server_error() {
                tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                continue;
            }
            return Err(format!("local brain {}: {}", code, txt));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        return v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() || num_predict <= 1)
            .ok_or_else(|| "empty response from local brain".to_string());
    }
    Err("local brain: retry loop exhausted".into())
}

/// Local brain (via Ollama native /api/chat, non-streaming, thinking disabled).
/// This is the DEFAULT brain. No API key needed. The grounding goes in the
/// system message, the turn in the user message — same shape as DeepSeek.
#[tauri::command]
pub async fn robert_suggest_local(
    model: String,
    system: String,
    user: String,
) -> Result<String, String> {
    let model = if model.trim().is_empty() {
        LOCAL_DEFAULT_MODEL.to_string()
    } else {
        model
    };
    ollama_chat(&model, &system, &user, 320).await
}

/// Load the local model and evaluate the grounding prefix before the first
/// real turn, so turn one is as fast as turn ten. Uses the same num_ctx and
/// keep_alive as robert_suggest_local — that is what makes the KV prefix
/// cache line up. Best-effort.
#[tauri::command]
pub async fn robert_prewarm_local(model: String, system: String) -> Result<(), String> {
    let model = if model.trim().is_empty() {
        LOCAL_DEFAULT_MODEL.to_string()
    } else {
        model
    };
    let _ = ollama_chat(&model, &system, "ready", 1).await;
    Ok(())
}

/// Prime DeepSeek's on-disk context cache with the grounding prefix (max_tokens 1)
/// so the first real turn is a cache hit. Best-effort. For local Qwen this is a
/// no-op (Ollama has no remote cache to warm).
#[tauri::command]
pub async fn robert_prewarm_cache(
    api_key: String,
    model: String,
    system: String,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Ok(());
    }
    let body = serde_json::json!({
        "model": if model.is_empty() { "deepseek-chat" } else { &model },
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": "ready"}
        ],
        "stream": false,
        "max_tokens": 1
    });
    let client = reqwest::Client::new();
    let _ = client
        .post("https://api.deepseek.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await;
    Ok(())
}

/// Keyless research fallback: DuckDuckGo's HTML results (no API key), top
/// snippets returned as plain text for the active brain to synthesize into a
/// speakable line. Lower quality than Exa, but free and always available.
#[tauri::command]
pub async fn robert_research_free(query: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query.as_str())])
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("web search failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("web search HTTP {}", res.status()));
    }
    let html = res.text().await.map_err(|e| e.to_string())?;

    // Pull result titles + snippets out of the HTML (no DOM dependency).
    fn strip_tags(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut in_tag = false;
        for c in s.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(c),
                _ => {}
            }
        }
        out.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&#x27;", "'")
            .replace("&quot;", "\"")
            .replace("&nbsp;", " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn extract<'a>(html: &'a str, marker: &str) -> Vec<String> {
        let mut items = Vec::new();
        for chunk in html.split(marker).skip(1) {
            // the element's inner HTML ends at the closing anchor/snippet tag
            let end = chunk.find("</a>").unwrap_or_else(|| chunk.len().min(400));
            let inner = &chunk[..end];
            // skip past the tag's remaining attributes to its content
            if let Some(gt) = inner.find('>') {
                let text = strip_tags(&inner[gt + 1..]);
                if !text.is_empty() {
                    items.push(text);
                }
            }
            if items.len() >= 5 {
                break;
            }
        }
        items
    }
    let titles = extract(&html, "class=\"result__a\"");
    let snippets = extract(&html, "class=\"result__snippet\"");
    if !titles.is_empty() || !snippets.is_empty() {
        let mut out = String::new();
        for i in 0..titles.len().max(snippets.len()).min(5) {
            if let Some(t) = titles.get(i) {
                out.push_str(&format!("- {}", t));
            }
            if let Some(s) = snippets.get(i) {
                out.push_str(&format!(": {}", s));
            }
            out.push('\n');
        }
        return Ok(out.trim().to_string());
    }

    // Layer 2: the HTML endpoint sometimes serves a challenge page under
    // rate pressure — fall back to DDG's Instant Answer JSON API (separate
    // service, keyless, never challenges; sparser but often enough).
    let res = client
        .get("https://api.duckduckgo.com/")
        .query(&[("q", query.as_str()), ("format", "json"), ("no_html", "1")])
        .send()
        .await
        .map_err(|e| format!("web search failed: {}", e))?;
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    if let Some(a) = v.get("AbstractText").and_then(|x| x.as_str()) {
        if !a.is_empty() {
            out.push_str(&format!("- {}\n", a));
        }
    }
    if let Some(a) = v.get("Answer").and_then(|x| x.as_str()) {
        if !a.is_empty() {
            out.push_str(&format!("- {}\n", a));
        }
    }
    if let Some(topics) = v.get("RelatedTopics").and_then(|x| x.as_array()) {
        for t in topics.iter().take(4) {
            if let Some(txt) = t.get("Text").and_then(|x| x.as_str()) {
                if !txt.is_empty() {
                    out.push_str(&format!("- {}\n", txt));
                }
            }
        }
    }
    if out.trim().is_empty() {
        return Err("web search returned no readable results".into());
    }
    Ok(out.trim().to_string())
}

/// Resize the Robert window's height to fit its content, preserving width.
#[tauri::command]
pub fn robert_set_height(window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let cur = window.inner_size().map_err(|e| e.to_string())?;
    let logical_w = (cur.width as f64) / scale;
    window
        .set_size(tauri::LogicalSize::new(logical_w, height))
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct Grounding {
    source: String,
    content: String,
}

// Keep the concatenated notes small enough that per-turn prompt evaluation
// stays interactive on the local brain (~24K chars ≈ 7-8K tokens).
const NOTES_CHAR_CAP: usize = 24_000;

/// Recursively collect .md files under `dir` (hidden entries and README.md
/// skipped), returning (mtime, relative path, content).
fn gather_md(
    dir: &std::path::Path,
    base: &std::path::Path,
    out: &mut Vec<(std::time::SystemTime, String, String)>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            gather_md(&p, base, out);
            continue;
        }
        if !name.to_lowercase().ends_with(".md") || name.eq_ignore_ascii_case("readme.md") {
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > 2_000_000 {
            continue;
        }
        if let Ok(c) = std::fs::read_to_string(&p) {
            let c = c.trim().to_string();
            if c.is_empty() {
                continue;
            }
            let rel = p
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or(name);
            let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            out.push((mtime, rel, c));
        }
    }
}

const NOTES_README: &str = "# RobertNotes\n\nThis folder is Robert's knowledge. Every .md file here becomes meeting grounding.\n\n- Pick a specific file in the app's \"Meeting knowledge source\" dropdown, or leave it on Auto.\n- Auto: a file named robert-brief.md wins when present; otherwise all .md files load, newest first.\n- Keep files small and factual; exact numbers get quoted verbatim in answers.\n- This README is ignored. An Obsidian vault works too: point the app's Notes folder setting at it.\n";

fn resolve_notes_folder(notes_folder: Option<String>) -> Result<(String, std::path::PathBuf), String> {
    // HOME on macOS/Linux, USERPROFILE on Windows
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home directory found".to_string())?;
    let folder = notes_folder
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "~/RobertNotes".into())
        .replacen('~', &home, 1);
    let base = std::path::PathBuf::from(&folder);
    // First run: create the folder and seed a README explaining how it works,
    // so users can find it and drop notes in without reading any docs.
    if !base.exists() {
        let _ = std::fs::create_dir_all(&base);
        let _ = std::fs::write(base.join("README.md"), NOTES_README);
    }
    Ok((folder, base))
}

/// List the .md files in the notes folder (relative paths, newest first) so
/// the UI can offer them as selectable meeting-knowledge sources.
#[tauri::command]
pub fn robert_list_notes(notes_folder: Option<String>) -> Result<Vec<String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let mut notes = Vec::new();
    gather_md(&base, &base, &mut notes);
    notes.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    let mut rels: Vec<String> = notes.into_iter().map(|(_, rel, _)| rel).collect();
    // stable sort: the brief bubbles to the top, the rest stay newest-first
    rels.sort_by_key(|r| if r == "robert-brief.md" { 0 } else { 1 });
    Ok(rels)
}

/// Load grounding. Priority:
/// 1. An explicitly selected note file (`notes_file`, relative to the folder).
/// 2. `<notes folder>/robert-brief.md` — the distilled prep for THE meeting.
/// 3. All .md files in the notes folder (an Obsidian vault works as-is;
///    Notion pages arrive via Markdown export), newest first, size-capped.
#[tauri::command]
pub fn robert_load_grounding(
    notes_folder: Option<String>,
    notes_file: Option<String>,
) -> Result<Grounding, String> {
    let (folder, base) = resolve_notes_folder(notes_folder)?;

    // explicit selection wins; sanitized to stay inside the folder
    if let Some(sel) = notes_file.filter(|s| !s.trim().is_empty()) {
        let sel = sel.trim().to_string();
        if !sel.contains("..") && !sel.starts_with('/') {
            if let Ok(c) = std::fs::read_to_string(base.join(&sel)) {
                let c = c.trim().to_string();
                if !c.is_empty() {
                    return Ok(Grounding {
                        source: format!("{} (selected) in {}", sel, folder),
                        content: c,
                    });
                }
            }
        }
        // selected file gone or empty: fall through to auto
    }

    let brief = base.join("robert-brief.md");
    if let Ok(c) = std::fs::read_to_string(&brief) {
        let c = c.trim().to_string();
        if !c.is_empty() {
            return Ok(Grounding {
                source: format!("robert-brief.md (meeting brief) in {}", folder),
                content: c,
            });
        }
    }

    let mut notes = Vec::new();
    gather_md(&base, &base, &mut notes);
    if !notes.is_empty() {
        notes.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
        let mut content = String::new();
        let mut used = 0usize;
        for (_, rel, c) in &notes {
            let block = format!("### {}\n{}\n\n", rel, c);
            if content.len() + block.len() > NOTES_CHAR_CAP {
                if content.is_empty() {
                    content.push_str(&block[..NOTES_CHAR_CAP.min(block.len())]);
                    used = 1;
                }
                break;
            }
            content.push_str(&block);
            used += 1;
        }
        return Ok(Grounding {
            source: format!("{} note file(s) in {}", used, folder),
            content: content.trim().to_string(),
        });
    }

    Err(format!(
        "No .md notes found in {} — drop your notes there (or point the setting at an Obsidian vault).",
        folder
    ))
}