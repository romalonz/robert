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
    max_tokens: Option<u64>,
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
        "max_tokens": max_tokens.unwrap_or(320)
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
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
    max_tokens: Option<u64>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("missing Anthropic API key".into());
    }
    let body = serde_json::json!({
        "model": if model.is_empty() { "claude-opus-5" } else { &model },
        "max_tokens": max_tokens.unwrap_or(640),
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
            "temperature": 0.6
        }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(240))
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
    max_tokens: Option<u64>,
) -> Result<String, String> {
    let model = if model.trim().is_empty() {
        LOCAL_DEFAULT_MODEL.to_string()
    } else {
        model
    };
    ollama_chat(&model, &system, &user, max_tokens.unwrap_or(320)).await
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


// ─── Meeting Memory ──────────────────────────────────────────────────────────
// Fathom-like, fully local. One folder per meeting under <notes>/meetings/,
// plain files only: transcript.jsonl (source of truth), transcript.md,
// summary.md. Learned knowledge lives in <notes>/memory/*.md and is injected
// into grounding (capped). Design: docs/2026-08-28_meeting-memory-plan.md

const MEMORY_FILES: [&str; 4] = ["qa-bank.md", "facts.md", "people.md", "decisions.md"];
const MEMORY_CHAR_CAP: usize = 8_000;

#[derive(serde::Serialize)]
pub struct MeetingInfo {
    id: String,
    dir: String,
    started: String,
    target: String,
    turns: u64,
    has_summary: bool,
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').chars().take(40).collect()
}

fn meetings_root(notes_folder: Option<String>) -> Result<std::path::PathBuf, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let root = base.join("meetings");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

/// A meeting dir is only valid if it is a direct child of <notes>/meetings.
fn checked_meeting_dir(notes_folder: Option<String>, dir: &str) -> Result<std::path::PathBuf, String> {
    let root = meetings_root(notes_folder)?;
    let p = std::path::PathBuf::from(dir);
    let ok = p.parent() == Some(root.as_path())
        && p.file_name().map(|n| !n.to_string_lossy().starts_with('.')).unwrap_or(false);
    if !ok {
        return Err("meeting folder is outside the notes folder".into());
    }
    Ok(p)
}

/// Memory files concatenated for grounding, head-first (entries are kept
/// newest-first by the merge step), capped.
fn read_memory_block(base: &std::path::Path) -> String {
    let mut out = String::new();
    for name in MEMORY_FILES {
        if let Ok(c) = std::fs::read_to_string(base.join("memory").join(name)) {
            let c = c.trim();
            if c.is_empty() {
                continue;
            }
            let block = format!("### memory/{}\n{}\n\n", name, c);
            if out.len() + block.len() > MEMORY_CHAR_CAP {
                let room = MEMORY_CHAR_CAP.saturating_sub(out.len());
                if room > 200 {
                    let cut: String = block.chars().take(room).collect();
                    out.push_str(&cut);
                }
                break;
            }
            out.push_str(&block);
        }
    }
    out.trim().to_string()
}

fn render_transcript_md(jsonl: &str) -> (String, u64) {
    let mut md = String::new();
    let mut turns: u64 = 0;
    for line in jsonl.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("header") {
            md.push_str(&format!(
                "# Meeting transcript\n\nStarted: {}  \nApp: {}  \nMode: {}  \nBrain: {}\n\n---\n\n",
                v.get("iso").and_then(|x| x.as_str()).unwrap_or(""),
                v.get("target").and_then(|x| x.as_str()).unwrap_or(""),
                v.get("mode").and_then(|x| x.as_str()).unwrap_or(""),
                v.get("brain").and_then(|x| x.as_str()).unwrap_or("")
            ));
            continue;
        }
        let t = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
        let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let who = match v.get("who").and_then(|x| x.as_str()).unwrap_or("") {
            "them" => {
                turns += 1;
                "Them".to_string()
            }
            "me" => "Me".to_string(),
            "robert" => "Robert (suggested)".to_string(),
            other => other.to_string(),
        };
        md.push_str(&format!("[{}] {}: {}\n", t, who, text));
    }
    (md, turns)
}

#[tauri::command]
pub fn robert_meeting_begin(
    notes_folder: Option<String>,
    target: String,
    mode: String,
    brain: String,
    started: String,
    iso: String,
) -> Result<String, String> {
    let root = meetings_root(notes_folder)?;
    let id = format!("{}_{}", slug(&started), slug(&target));
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let header = serde_json::json!({
        "type": "header", "iso": iso, "target": target, "mode": mode, "brain": brain
    });
    std::fs::write(dir.join("transcript.jsonl"), format!("{}\n", header))
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn robert_meeting_append(
    notes_folder: Option<String>,
    dir: String,
    line: String,
) -> Result<(), String> {
    use std::io::Write;
    let d = checked_meeting_dir(notes_folder, &dir)?;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(d.join("transcript.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line.trim()).map_err(|e| e.to_string())
}

/// Render transcript.md from the JSONL log. Returns (markdown, turns heard).
#[tauri::command]
pub fn robert_meeting_finish(
    notes_folder: Option<String>,
    dir: String,
) -> Result<(String, u64), String> {
    let d = checked_meeting_dir(notes_folder, &dir)?;
    let jsonl = std::fs::read_to_string(d.join("transcript.jsonl")).map_err(|e| e.to_string())?;
    let (md, turns) = render_transcript_md(&jsonl);
    std::fs::write(d.join("transcript.md"), &md).map_err(|e| e.to_string())?;
    Ok((md, turns))
}

#[tauri::command]
pub fn robert_meeting_write(
    notes_folder: Option<String>,
    dir: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let d = checked_meeting_dir(notes_folder, &dir)?;
    if !name.ends_with(".md") || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("invalid file name".into());
    }
    std::fs::write(d.join(name), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn robert_read_memory(notes_folder: Option<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let mut m = std::collections::HashMap::new();
    for name in MEMORY_FILES {
        m.insert(
            name.to_string(),
            std::fs::read_to_string(base.join("memory").join(name)).unwrap_or_default(),
        );
    }
    Ok(m)
}

#[tauri::command]
pub fn robert_write_memory(notes_folder: Option<String>, name: String, content: String) -> Result<(), String> {
    if !MEMORY_FILES.contains(&name.as_str()) {
        return Err("unknown memory file".into());
    }
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let dir = base.join("memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(name), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn robert_list_meetings(notes_folder: Option<String>) -> Result<Vec<MeetingInfo>, String> {
    let root = meetings_root(notes_folder)?;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            if id.starts_with('.') {
                continue;
            }
            let jsonl = std::fs::read_to_string(p.join("transcript.jsonl")).unwrap_or_default();
            let (mut started, mut target) = (String::new(), String::new());
            if let Some(first) = jsonl.lines().next() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(first) {
                    started = v.get("iso").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    target = v.get("target").and_then(|x| x.as_str()).unwrap_or("").to_string();
                }
            }
            let (_, turns) = render_transcript_md(&jsonl);
            out.push(MeetingInfo {
                id,
                dir: p.to_string_lossy().to_string(),
                started,
                target,
                turns,
                has_summary: p.join("summary.md").exists(),
            });
        }
    }
    out.sort_by(|a, b| b.id.cmp(&a.id)); // ids start with the timestamp: newest first
    Ok(out)
}

#[tauri::command]
pub fn robert_delete_meeting(notes_folder: Option<String>, dir: String) -> Result<(), String> {
    let d = checked_meeting_dir(notes_folder, &dir)?;
    std::fs::remove_dir_all(d).map_err(|e| e.to_string())
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

#[cfg(test)]
mod meeting_tests {
    use super::*;

    #[test]
    fn slug_is_filesystem_safe() {
        assert_eq!(slug("com.microsoft.teams2"), "com-microsoft-teams2");
        assert_eq!(slug("2026-08-28_1430"), "2026-08-28-1430");
        assert_eq!(slug("  weird//name!! "), "weird-name");
    }

    #[test]
    fn transcript_renders_and_counts_turns() {
        let jsonl = concat!(
            r#"{"type":"header","iso":"2026-08-28T14:30:00Z","target":"teams","mode":"auto","brain":"local"}"#, "\n",
            r#"{"t":"14:30:05","who":"them","text":"How much does this cost?"}"#, "\n",
            r#"{"t":"14:30:06","who":"robert","text":"Zero new spend."}"#, "\n",
            r#"{"t":"14:30:09","who":"me","text":"Zero new spend, we use what we have.","delivered":true}"#, "\n",
            r#"{"t":"14:30:20","who":"them","text":"And who maintains it?"}"#, "\n",
            "not json\n"
        );
        let (md, turns) = render_transcript_md(jsonl);
        assert_eq!(turns, 2);
        assert!(md.contains("# Meeting transcript"));
        assert!(md.contains("[14:30:05] Them: How much does this cost?"));
        assert!(md.contains("[14:30:06] Robert (suggested): Zero new spend."));
        assert!(md.contains("[14:30:09] Me: Zero new spend, we use what we have."));
    }
}


// ─── Per-turn retrieval ──────────────────────────────────────────────────────
// For each question, pull the most relevant paragraphs from EVERY note in the
// folder (brief, handover docs, meeting takeaways, memory) into the prompt.
// Depth without prompt bloat: a few paragraphs, not whole files.

const STOPWORDS: [&str; 60] = [
    "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were", "have",
    "has", "had", "what", "when", "where", "which", "who", "why", "how", "does", "did", "will",
    "would", "could", "should", "can", "our", "their", "they", "them", "there", "here", "about",
    "from", "into", "than", "then", "also", "just", "like", "much", "many", "some", "any", "all",
    "not", "but", "its", "it's", "we're", "i'm", "don't", "doesn't", "is", "of", "to", "in", "on",
];

/// Light stemming so "costing"/"costs"/"cost" and "reports"/"reporting"/"report"
/// meet in the middle. Crude on purpose: fast, dependency-free, good enough
/// for paragraph ranking.
fn stem(w: &str) -> String {
    let mut s = w.to_string();
    for suf in ["ing", "ed", "es", "s"] {
        // keep at least 3 letters of stem ("costing" -> "cost", "asked" -> "ask")
        if s.len() >= 3 + suf.len() && s.ends_with(suf) && !(suf == "s" && s.ends_with("ss")) {
            s.truncate(s.len() - suf.len());
            break;
        }
    }
    s
}

fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '.' && c != ',')
        .map(|w| w.trim_matches(|c: char| c == '.' || c == ',' || c == '\''))
        .filter(|w| w.len() > 2 && !STOPWORDS.contains(w))
        .map(stem)
        .collect()
}

/// Split a note into paragraph-sized chunks (blank-line separated; bullet runs
/// stay together), each tagged with its nearest heading for context.
fn chunk_note(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut heading = String::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, heading: &str, chunks: &mut Vec<String>| {
        let c = cur.trim();
        if c.len() > 30 {
            chunks.push(if heading.is_empty() { c.to_string() } else { format!("{}\n{}", heading, c) });
        }
        cur.clear();
    };
    for line in text.lines() {
        let l = line.trim_end();
        if l.starts_with('#') {
            flush(&mut cur, &heading, &mut chunks);
            heading = l.trim_start_matches('#').trim().to_string();
            continue;
        }
        if l.trim().is_empty() {
            flush(&mut cur, &heading, &mut chunks);
            continue;
        }
        cur.push_str(l);
        cur.push('\n');
        if cur.len() > 1200 {
            flush(&mut cur, &heading, &mut chunks);
        }
    }
    flush(&mut cur, &heading, &mut chunks);
    chunks
}

/// Rarity weight per query token: log((N+1)/(df+1)) + 1 over all chunks, so a
/// word that appears in one paragraph ("cost") outweighs one that appears in
/// most of them ("reporting").
fn idf_weights(query: &[String], chunk_token_sets: &[std::collections::HashSet<String>]) -> std::collections::HashMap<String, f32> {
    let n = chunk_token_sets.len().max(1) as f32;
    let mut w = std::collections::HashMap::new();
    for q in query {
        if w.contains_key(q) {
            continue;
        }
        let df = chunk_token_sets.iter().filter(|s| s.contains(q)).count() as f32;
        w.insert(q.clone(), ((n + 1.0) / (df + 1.0)).ln() + 1.0);
    }
    w
}

fn score_chunk(query: &[String], chunk: &str) -> f32 {
    // unweighted fallback (unit tests / single-chunk use); the real path uses
    // score_chunk_weighted with corpus IDF
    let set: std::collections::HashSet<String> = tokens(chunk).into_iter().collect();
    let w: std::collections::HashMap<String, f32> = query.iter().map(|q| (q.clone(), 1.0)).collect();
    score_chunk_weighted(query, &set, &w)
}

fn score_chunk_weighted(
    query: &[String],
    chunk_tokens: &std::collections::HashSet<String>,
    weights: &std::collections::HashMap<String, f32>,
) -> f32 {
    if query.is_empty() || chunk_tokens.is_empty() {
        return 0.0;
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0.0f32;
    let mut hit = 0.0f32;
    let mut num_hits = 0usize;
    for q in query {
        if !seen.insert(q.as_str()) {
            continue;
        }
        let w = *weights.get(q).unwrap_or(&1.0);
        total += w;
        if chunk_tokens.contains(q) {
            hit += w;
            if q.chars().any(|c| c.is_ascii_digit()) {
                num_hits += 1;
            }
        }
    }
    if hit == 0.0 || total == 0.0 {
        return 0.0;
    }
    // weighted coverage of the question, small bonus for numbers, mild length penalty
    hit / total + 0.3 * num_hits as f32 - (chunk_tokens.len() as f32 / 4000.0)
}

/// Top-k relevant paragraphs across all notes for `query`, formatted for the prompt.
#[tauri::command]
pub fn robert_retrieve_notes(
    notes_folder: Option<String>,
    query: String,
    max_chars: Option<usize>,
) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let q = tokens(&query);
    if q.is_empty() {
        return Ok(String::new());
    }
    let mut files = Vec::new();
    gather_md(&base, &base, &mut files); // skips meetings/ and memory/; memory rides separately
    // memory files are worth searching too
    for name in MEMORY_FILES {
        if let Ok(c) = std::fs::read_to_string(base.join("memory").join(name)) {
            files.push((std::time::SystemTime::UNIX_EPOCH, format!("memory/{}", name), c));
        }
    }
    // chunk everything once, compute corpus rarity weights, then score
    let mut chunks: Vec<(String, String, std::collections::HashSet<String>)> = Vec::new();
    for (_, rel, content) in &files {
        for ch in chunk_note(content) {
            let set: std::collections::HashSet<String> = tokens(&ch).into_iter().collect();
            chunks.push((rel.clone(), ch, set));
        }
    }
    let sets: Vec<std::collections::HashSet<String>> = chunks.iter().map(|c| c.2.clone()).collect();
    let weights = idf_weights(&q, &sets);
    let mut scored: Vec<(f32, String, String)> = Vec::new();
    for (rel, ch, set) in chunks {
        let sc = score_chunk_weighted(&q, &set, &weights);
        if sc > 0.34 {
            scored.push((sc, rel, ch));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let cap = max_chars.unwrap_or(2200);
    let mut out = String::new();
    for (_, rel, ch) in scored.into_iter().take(6) {
        let block = format!("### {}\n{}\n\n", rel, ch.trim());
        if out.len() + block.len() > cap {
            break;
        }
        out.push_str(&block);
    }
    Ok(out.trim().to_string())
}

/// Write a top-level note into the notes folder (e.g. meeting takeaways), so
/// it shows up in the Meeting knowledge picker like any other note.
#[tauri::command]
pub fn robert_write_note(notes_folder: Option<String>, name: String, content: String) -> Result<String, String> {
    let (_, base) = resolve_notes_folder(notes_folder)?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if !safe.ends_with(".md") || safe.starts_with('.') || safe.eq_ignore_ascii_case("readme.md") {
        return Err("invalid note name".into());
    }
    std::fs::write(base.join(&safe), content).map_err(|e| e.to_string())?;
    Ok(safe)
}

#[cfg(test)]
mod retrieval_tests {
    use super::*;

    #[test]
    fn picks_the_paragraph_that_answers_the_question() {
        let note = "# Handover\n\nSeven reports are built on the VDI from Epicor BAQ extracts.\n\n## Paths\nEverything publishes to the BWF Insights folder; the [DEV] brackets need -LiteralPath in PowerShell.\n\n## Cargo tracking\nContainer ETAs come from the Vizion API via Playwright, written to Cargo_Tracking_Report.xlsx.\n";
        let chunks = chunk_note(note);
        assert_eq!(chunks.len(), 3);
        let q = tokens("where do the container ETAs come from?");
        let mut best = chunks.iter().map(|c| (score_chunk(&q, c), c.clone())).collect::<Vec<_>>();
        best.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        assert!(best[0].1.contains("Vizion"), "got {:?}", best[0]);
        assert!(best[0].0 > 0.34);
    }

    #[test]
    fn unrelated_paragraphs_score_zero() {
        let q = tokens("what does the snapshot retention look like?");
        assert_eq!(score_chunk(&q, "Good morning everyone, thanks for joining."), 0.0);
    }
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
            // meetings/ and memory/ are Meeting Memory's own folders: summaries
            // are offered individually in the picker, memory is injected with
            // its own cap. Neither belongs in the all-notes concatenation.
            if p.parent() == Some(base) && (name == "meetings" || name == "memory") {
                continue;
            }
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
    use_memory: Option<bool>,
) -> Result<Grounding, String> {
    let (folder, base) = resolve_notes_folder(notes_folder)?;
    let g = load_grounding_inner(&folder, &base, notes_file);
    // Meeting Memory: what Robert learned from past meetings rides along with
    // any grounding, capped so per-turn latency stays flat.
    if use_memory.unwrap_or(true) {
        let mem = read_memory_block(&base);
        if !mem.is_empty() {
            return Ok(match g {
                Ok(mut g) => {
                    g.content.push_str("\n\n## MEMORY (learned from my past meetings)\n\n");
                    g.content.push_str(&mem);
                    g.source.push_str(" + memory");
                    g
                }
                Err(_) => Grounding { source: format!("memory only in {}", folder), content: mem },
            });
        }
    }
    g
}

fn load_grounding_inner(
    folder: &str,
    base: &std::path::Path,
    notes_file: Option<String>,
) -> Result<Grounding, String> {
    let folder = folder.to_string();
    let base = base.to_path_buf();

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
#[cfg(test)]
mod retrieval_live_probe {
    // Prints what retrieval pulls from the REAL notes folder for a few
    // questions. Run: cargo test retrieval_live_probe -- --nocapture --ignored
    #[test]
    #[ignore]
    fn probe_real_notes() {
        for q in [
            "where do the container ETAs for cargo tracking come from?",
            "what is the gotcha with the reports folder path in PowerShell?",
            "how much is this costing us?",
        ] {
            let out = super::robert_retrieve_notes(None, q.to_string(), Some(2200)).unwrap();
            println!("\n=== Q: {} ===\n{}\n", q, out);
        }
    }
}
