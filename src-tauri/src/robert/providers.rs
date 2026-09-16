// Providers: the three chat brains (OpenAI-compatible/DeepSeek, Anthropic,
// local Ollama) and the three vision brains, plus the local-brain sizing
// helpers (num_ctx / keep_alive / low_ram / error mapping) and prewarming.
//
// Phase B (rec 2/6) adds the `BrainProvider` seam: a trait with chat/stream/
// vision that the app asks for suggestions through, without naming a provider.
// Each provider owns its HTTP body; the #[tauri::command]s at the bottom are
// thin wrappers that build the right impl and delegate. Command names,
// signatures, defaults, error strings, and the robert://token stream are all
// unchanged — this is a structure-only seam over the existing behavior.

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
/// True on a RAM-starved machine (< ~12 GB), where a CPU-resident model already
/// spills into the pagefile. Both the KV cache size and how long we keep the
/// model hot are dialed back there so Robert stops holding the rest of the system
/// (browser, video) hostage to page faults.
fn low_ram() -> bool {
    matches!(crate::local_brain::total_ram_bytes(), Some(b) if (b as f64 / 1_073_741_824.0) < 12.0)
}

/// How long Ollama keeps the model resident after a call. On a workstation we
/// keep it hot for an hour so live-call turns stay fast; on a low-RAM box that
/// same hour means ~10 GB of commit and continuous pagefile churn for the rest of
/// the hour AFTER the user stops, so we let it fall out of memory quickly.
fn local_keep_alive() -> &'static str {
    if low_ram() {
        "90s"
    } else {
        "60m"
    }
}

/// Translate a failed local /api/chat response into something worth showing the
/// user. The signature failure on a small PC is llama.cpp's memory fitter
/// aborting *before the model even loads* ("unable to fit model into system
/// memory") — the weights simply don't fit in RAM, and no context shrink saves
/// it. Surface that (and a generic server error on a low-RAM box) as a plain
/// "not enough memory — use a cloud brain" instead of a raw 500 body, which is
/// otherwise a silent non-answer.
fn local_error_message(code: reqwest::StatusCode, txt: &str) -> String {
    let low = txt.to_lowercase();
    let mem = low.contains("unable to fit")
        || low.contains("free memory")
        || low.contains("out of memory")
        || low.contains("cannot allocate")
        || low.contains("insufficient memory");
    if mem || (code.is_server_error() && low_ram()) {
        return "Not enough free memory to run the local model on this PC. Switch to a cloud brain in Settings → Brain (choose a provider and paste your own key) — it's far faster here and uses no local RAM.".to_string();
    }
    format!("local brain {}: {}", code, txt)
}

fn local_num_ctx(system: &str) -> u64 {
    let est_tokens = (system.len() as u64) / 3; // conservative chars->tokens
    let needed = est_tokens + 4096; // headroom: history + turn + output
    let rounded = needed.div_ceil(4096) * 4096;
    // The KV cache for a big context is memory a low-RAM machine doesn't have (it
    // lands in the pagefile alongside the weights), so cap it hard there. A full
    // window only pays off when there's RAM to hold it.
    if low_ram() {
        rounded.clamp(4096, 8192)
    } else {
        rounded.clamp(8192, 65536)
    }
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
        .unwrap_or_else(|_| "http://127.0.0.1:11434".into());
    let url = format!("{}/api/chat", base);
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "stream": false,
        "think": false,
        "keep_alive": local_keep_alive(),
        "options": {
            "num_ctx": local_num_ctx(system),
            "num_predict": num_predict,
            "temperature": 0.6
        }
    });
    // Scale the ceiling with how much we asked the model to WRITE. A live-call
    // suggestion (a few hundred tokens) still fails fast if the server is wedged,
    // but a big conversion (résumé → profile, ~4k tokens) on a RAM-starved box
    // generating at only a few tokens/sec is no longer guillotined mid-answer.
    // ~0.3s/token ≈ a 3 t/s worst case, plus a base for prompt processing; capped
    // so nothing can hang indefinitely.
    let timeout_secs = (180 + num_predict * 3 / 10).min(1500);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
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
            return Err(local_error_message(code, &txt));
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

// ─── The brain seam ──────────────────────────────────────────────────────────
/// A provider-agnostic brain. The app asks for `chat` / `stream` / `vision`
/// without knowing whether the answer comes from DeepSeek, Claude, or a local
/// Ollama model. The command wrappers below construct the right impl and
/// delegate; the bodies here are the exact HTTP calls that used to live inline
/// in each command.
#[allow(async_fn_in_trait)]
pub(crate) trait BrainProvider {
    /// Non-streaming completion. Grounding in `system`, the turn in `user`.
    async fn chat(&self, system: &str, user: &str, max_tokens: u64) -> Result<String, String>;

    /// Vision completion over a base64 PNG.
    async fn vision(
        &self,
        system: &str,
        user: &str,
        image_base64: &str,
        max_tokens: u64,
    ) -> Result<String, String>;

    /// Streaming completion that emits `robert://token` as it generates and
    /// returns the full text. Only the local brain streams tokens today; the
    /// default delegates to a single `chat` call. Not reached on the live path
    /// (the stream command builds `OllamaBrain`), so it changes no behavior.
    async fn stream(
        &self,
        app: &tauri::AppHandle,
        req_id: u64,
        system: &str,
        user: &str,
        max_tokens: u64,
    ) -> Result<String, String> {
        let _ = (app, req_id);
        self.chat(system, user, max_tokens).await
    }
}

/// Cloud brain over any OpenAI-compatible chat API (DeepSeek, OpenAI, Groq,
/// Gemini's OpenAI endpoint, OpenRouter, or a custom base URL).
pub(crate) struct OpenAiCompatBrain {
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
}

impl BrainProvider for OpenAiCompatBrain {
    async fn chat(&self, system: &str, user: &str, max_tokens: u64) -> Result<String, String> {
        if self.api_key.trim().is_empty() {
            return Err("missing API key for the selected provider".into());
        }
        let base = self
            .base_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://api.deepseek.com/v1".into());
        let url = format!("{}/chat/completions", base.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": if self.model.is_empty() { "deepseek-chat" } else { &self.model },
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            "stream": false,
            "max_tokens": max_tokens
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
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

    async fn vision(
        &self,
        system: &str,
        user: &str,
        image_base64: &str,
        max_tokens: u64,
    ) -> Result<String, String> {
        if self.api_key.trim().is_empty() { return Err("missing API key".into()); }
        let base = self.base_url.clone().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "https://api.openai.com/v1".into());
        let url = format!("{}/chat/completions", base.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{}", image_base64)}}
                ]}
            ]
        });
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|e| e.to_string())?;
        let res = client.post(&url).bearer_auth(self.api_key.trim()).json(&body).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let code = res.status(); let txt = res.text().await.unwrap_or_default();
            return Err(format!("vision {}: {}", code, txt));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        v.pointer("/choices/0/message/content").and_then(|c| c.as_str())
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .ok_or_else(|| "empty vision response".to_string())
    }
}

/// Anthropic Claude brain (native Messages API — not OpenAI-compatible).
pub(crate) struct AnthropicBrain {
    pub api_key: String,
    pub model: String,
}

impl BrainProvider for AnthropicBrain {
    /// No temperature/top_p (removed on current Claude models); adaptive thinking
    /// is the model default, `effort: low` keeps live-call latency down. Checks
    /// `stop_reason` for refusals before reading content.
    async fn chat(&self, system: &str, user: &str, max_tokens: u64) -> Result<String, String> {
        if self.api_key.trim().is_empty() {
            return Err("missing Anthropic API key".into());
        }
        let body = serde_json::json!({
            "model": if self.model.is_empty() { "claude-opus-5" } else { &self.model },
            "max_tokens": max_tokens,
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
            .header("x-api-key", self.api_key.trim())
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

    /// Anthropic vision: an image content block (base64 source) + a text block.
    async fn vision(
        &self,
        system: &str,
        user: &str,
        image_base64: &str,
        max_tokens: u64,
    ) -> Result<String, String> {
        if self.api_key.trim().is_empty() { return Err("missing Anthropic API key".into()); }
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_base64}},
                    {"type": "text", "text": user}
                ]}
            ]
        });
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|e| e.to_string())?;
        let res = client.post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", self.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            let code = res.status(); let txt = res.text().await.unwrap_or_default();
            return Err(format!("vision {}: {}", code, txt));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        v.pointer("/content/0/text").and_then(|c| c.as_str())
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .ok_or_else(|| "empty vision response".to_string())
    }
}

/// Local brain via Ollama native /api/chat. The DEFAULT brain, no API key.
pub(crate) struct OllamaBrain {
    pub model: String,
}

impl BrainProvider for OllamaBrain {
    /// Non-streaming, thinking disabled. Grounding in the system message, the
    /// turn in the user message — same shape as DeepSeek.
    async fn chat(&self, system: &str, user: &str, max_tokens: u64) -> Result<String, String> {
        let model = if self.model.trim().is_empty() {
            LOCAL_DEFAULT_MODEL.to_string()
        } else {
            self.model.clone()
        };
        ollama_chat(&model, system, user, max_tokens).await
    }

    /// Local vision model via Ollama (qwen2.5vl etc.): /api/chat with an images
    /// array (raw base64, no data-URI prefix).
    async fn vision(
        &self,
        system: &str,
        user: &str,
        image_base64: &str,
        max_tokens: u64,
    ) -> Result<String, String> {
        let base = std::env::var("ROBERT_OLLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into());
        let url = format!("{}/api/chat", base);
        let body = serde_json::json!({
            "model": if self.model.trim().is_empty() { "qwen2.5vl:7b" } else { &self.model },
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user, "images": [image_base64]}
            ],
            "stream": false,
            "keep_alive": local_keep_alive(),
            "options": {"num_ctx": if low_ram() { 4096 } else { 8192 }, "num_predict": max_tokens, "temperature": 0.2}
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(240))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client.post(&url).json(&body).send().await
            .map_err(|e| format!("local vision unreachable at {}: {} (is Ollama running?)", base, e))?;
        if !res.status().is_success() {
            let code = res.status();
            let txt = res.text().await.unwrap_or_default();
            if txt.contains("model") && (txt.contains("not found") || txt.contains("try pulling")) {
                return Err(format!("vision model not installed. In settings, set a vision model (e.g. qwen2.5vl:7b) and click Set up. ({})", code));
            }
            return Err(format!("local vision {}: {}", code, txt));
        }
        let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str())
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
            .ok_or_else(|| "empty response from local vision model".to_string())
    }

    /// Streaming local brain: emits each token to the frontend as it is
    /// generated (event "robert://token", tagged with `req_id`) and returns the
    /// full text at the end.
    async fn stream(
        &self,
        app: &tauri::AppHandle,
        req_id: u64,
        system: &str,
        user: &str,
        max_tokens: u64,
    ) -> Result<String, String> {
        use tauri::Emitter;
        let model = if self.model.trim().is_empty() { LOCAL_DEFAULT_MODEL.to_string() } else { self.model.clone() };
        let base = std::env::var("ROBERT_OLLAMA_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into());
        let url = format!("{}/api/chat", base);
        let body = serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            "stream": true,
            "think": false,
            "keep_alive": local_keep_alive(),
            "options": {
                "num_ctx": local_num_ctx(system),
                "num_predict": max_tokens,
                "temperature": 0.6
            }
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(240))
            .build()
            .map_err(|e| e.to_string())?;
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
            return Err(local_error_message(code, &txt));
        }
        use futures_util::StreamExt;
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf = buf[nl + 1..].to_string();
                if line.is_empty() { continue; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(tok) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                        if !tok.is_empty() {
                            full.push_str(tok);
                            let _ = app.emit("robert://token", serde_json::json!({"id": req_id, "text": full}));
                        }
                    }
                    if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                        let _ = app.emit("robert://token", serde_json::json!({"id": req_id, "text": full, "done": true}));
                    }
                }
            }
        }
        Ok(full.trim().to_string())
    }
}

// ─── Command wrappers (thin; identical surface + outputs) ────────────────────

/// Cloud brain over any OpenAI-compatible chat API. Non-streaming.
#[tauri::command]
pub async fn robert_suggest(
    api_key: String,
    model: String,
    system: String,
    user: String,
    base_url: Option<String>,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    OpenAiCompatBrain { api_key, model, base_url }
        .chat(&system, &user, max_tokens.unwrap_or(320))
        .await
}

/// Anthropic Claude brain (native Messages API — not OpenAI-compatible).
#[tauri::command]
pub async fn robert_suggest_anthropic(
    api_key: String,
    model: String,
    system: String,
    user: String,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    AnthropicBrain { api_key, model }
        .chat(&system, &user, max_tokens.unwrap_or(640))
        .await
}

/// Local brain (via Ollama native /api/chat, non-streaming, thinking disabled).
/// This is the DEFAULT brain. No API key needed.
#[tauri::command]
pub async fn robert_suggest_local(
    model: String,
    system: String,
    user: String,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    OllamaBrain { model }
        .chat(&system, &user, max_tokens.unwrap_or(320))
        .await
}

/// ── Vision: solve a screenshot of a technical problem ──────────────────────
/// Local vision model via Ollama (qwen2.5vl etc.).
#[tauri::command]
pub async fn robert_vision_local(
    model: String,
    system: String,
    user: String,
    image_base64: String,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    OllamaBrain { model }
        .vision(&system, &user, &image_base64, max_tokens.unwrap_or(700))
        .await
}

/// OpenAI-compatible vision: image_url with a data URI in the content array.
#[tauri::command]
pub async fn robert_vision_openai(
    api_key: String,
    model: String,
    system: String,
    user: String,
    image_base64: String,
    base_url: Option<String>,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    OpenAiCompatBrain { api_key, model, base_url }
        .vision(&system, &user, &image_base64, max_tokens.unwrap_or(700))
        .await
}

/// Anthropic vision: an image content block (base64 source) + a text block.
#[tauri::command]
pub async fn robert_vision_anthropic(
    api_key: String,
    model: String,
    system: String,
    user: String,
    image_base64: String,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    AnthropicBrain { api_key, model }
        .vision(&system, &user, &image_base64, max_tokens.unwrap_or(700))
        .await
}

/// Streaming local brain: same call as robert_suggest_local but emits each
/// token to the frontend as it is generated (event "robert://token", tagged
/// with `req_id`). Returns the full text at the end. Non-streaming callers
/// (cloud, rewrite, research) keep using robert_suggest_local.
#[tauri::command]
pub async fn robert_suggest_local_stream(
    app: tauri::AppHandle,
    req_id: u64,
    model: String,
    system: String,
    user: String,
    max_tokens: Option<u64>,
) -> Result<String, String> {
    OllamaBrain { model }
        .stream(&app, req_id, &system, &user, max_tokens.unwrap_or(320))
        .await
}

/// Read an image from the clipboard as base64 PNG. Needs NO screen-recording
/// permission (the OS screenshot tool captured it, not us) — the fallback for
/// locked-down machines where live screen capture is blocked. Take a shot with
/// the OS shortcut that copies to the clipboard, then call this.
#[tauri::command]
pub fn robert_clipboard_image() -> Result<String, String> {
    use base64::Engine;
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    let img = cb.get_image().map_err(|_| {
        "No image on the clipboard. Take a screenshot to the clipboard first, then try again.".to_string()
    })?;
    let (w, h) = (img.width as u32, img.height as u32);
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&img.bytes, w, h, ColorType::Rgba8.into())
        .map_err(|e| format!("encode failed: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
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
