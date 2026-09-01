// Robert live engine for WINDOWS.
//
// The macOS build uses the Swift sidecar (Core Audio process tap + WhisperKit).
// On Windows the same job runs in-process: the upstream WASAPI system-audio
// loopback (speaker module) feeds 16k-mono-resampled audio into whisper.cpp
// (whisper-rs), and the SAME end-of-turn protocol is emitted as
// `robert://event` JSON lines, so the frontend is byte-for-byte identical:
//   {"type":"status","stage":"loading_model"} / {"stage":"ready",...}
//   {"type":"partial","text":"..."} / {"type":"final","text":"..."}
//   {"type":"error","message":"..."}
//
// v1 captures the WHOLE system audio output (what the speakers play), not a
// single app: per-process loopback is a later refinement. For a meeting that
// is equivalent in practice — the meeting app is what's playing.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::speaker::SpeakerInput;
use futures_util::StreamExt;

const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const WHISPER_MODEL_FILE: &str = "ggml-base.en.bin";
const TARGET_RATE: usize = 16_000;

fn emit_line(app: &AppHandle, obj: serde_json::Value) {
    if let Ok(line) = serde_json::to_string(&obj) {
        let _ = app.emit("robert://event", line);
    }
}

fn emit_error(app: &AppHandle, msg: &str) {
    emit_line(app, serde_json::json!({"type": "error", "message": msg}));
}

/// Ensure the whisper.cpp model exists locally; download on first run.
fn ensure_model(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(WHISPER_MODEL_FILE);
    if path.exists() {
        return Ok(path);
    }
    let bytes = tauri::async_runtime::block_on(async {
        let res = reqwest::get(WHISPER_MODEL_URL)
            .await
            .map_err(|e| format!("model download failed: {}", e))?;
        if !res.status().is_success() {
            return Err(format!("model download HTTP {}", res.status()));
        }
        res.bytes()
            .await
            .map_err(|e| format!("model download read failed: {}", e))
    })?;
    let tmp = dir.join(format!("{}.part", WHISPER_MODEL_FILE));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Linear resampler with cross-chunk continuity (port of the macOS engine's).
struct Resampler {
    step: f64,
    phase: f64,
    prev: Option<f32>,
}

impl Resampler {
    fn new(source_rate: f64, target_rate: f64) -> Self {
        Self { step: source_rate / target_rate, phase: 0.0, prev: None }
    }
    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        let mut ext: Vec<f32> = Vec::with_capacity(input.len() + 1);
        if let Some(p) = self.prev {
            ext.push(p);
        }
        ext.extend_from_slice(input);
        // causal box low-pass when downsampling, to tame aliasing
        let w = self.step.round() as usize;
        if w >= 2 {
            let mut smoothed = ext.clone();
            let mut acc: f32 = 0.0;
            for i in 0..ext.len() {
                acc += ext[i];
                if i >= w {
                    acc -= ext[i - w];
                }
                smoothed[i] = acc / (usize::min(i + 1, w) as f32);
            }
            ext = smoothed;
        }
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 2);
        let mut pos = self.phase;
        while pos < (ext.len() - 1) as f64 {
            let i = pos as usize;
            let frac = (pos - i as f64) as f32;
            out.push(ext[i] + (ext[i + 1] - ext[i]) * frac);
            pos += self.step;
        }
        self.phase = pos - (ext.len() - 1) as f64;
        self.prev = ext.last().copied();
        out
    }
}

/// Spawn the WASAPI capture thread. Returns the shared sample buffer, the source
/// sample-rate, and the thread handle. If the loopback stream ends (device or
/// format change, the render stream stopping), it RE-ACQUIRES the stream instead
/// of exiting forever — that silent death was the dominant "captured nothing"
/// failure (13 of 21 sessions). Shared by both the sherpa and whisper engines.
fn spawn_capture(
    app: &AppHandle,
    stop: &Arc<AtomicBool>,
) -> Result<(Arc<std::sync::Mutex<Vec<f32>>>, f64, std::thread::JoinHandle<()>), String> {
    let input = SpeakerInput::new().map_err(|e| format!("system audio capture failed: {e}"))?;
    let mut stream = input.stream();
    let source_rate = stream.sample_rate().max(8000) as f64;
    let captured: Arc<std::sync::Mutex<Vec<f32>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured2 = captured.clone();
    let stop2 = stop.clone();
    let app2 = app.clone();
    let handle = std::thread::spawn(move || {
        tauri::async_runtime::block_on(async move {
            let mut chunk: Vec<f32> = Vec::with_capacity(1024);
            let mut fails: u32 = 0;
            let mut warned = false;
            while !stop2.load(Ordering::Relaxed) {
                match stream.next().await {
                    Some(s) => {
                        if fails > 0 {
                            fails = 0;
                            warned = false;
                        }
                        chunk.push(s);
                        if chunk.len() >= 1024 {
                            if let Ok(mut g) = captured2.lock() {
                                g.extend_from_slice(&chunk);
                            }
                            chunk.clear();
                        }
                    }
                    None => {
                        // The loopback ended. DON'T exit — re-acquire it. Surface a
                        // one-time note so a dropped stream is visible, not silent.
                        fails += 1;
                        if fails >= 6 && !warned {
                            warned = true;
                            emit_line(
                                &app2,
                                serde_json::json!({"type":"status","stage":"ready","note":"audio stream dropped — reconnecting"}),
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        if let Ok(inp) = SpeakerInput::new() {
                            stream = inp.stream();
                        }
                    }
                }
            }
        });
    });
    Ok((captured, source_rate, handle))
}

fn transcribe(
    state: &mut whisper_rs::WhisperState,
    samples: &[f32],
) -> String {
    if samples.len() < TARGET_RATE / 5 {
        return String::new();
    }
    let mut params =
        whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    // Cheap decode wins: each call transcribes an independent tail window, so
    // carrying decoder context between calls only adds work and repetition.
    params.set_no_context(true);
    params.set_single_segment(true);
    // Disable temperature fallback so a marginal decode is not silently re-run at
    // higher temperature — on a slow CPU that re-run is pure added latency.
    params.set_temperature_inc(0.0);
    // Leave headroom for the UI, WebView and capture thread instead of grabbing
    // every logical core (oversubscription just adds contention for whisper).
    let threads = std::thread::available_parallelism()
        .map(|n| (n.get().saturating_sub(2)).clamp(2, 6) as i32)
        .unwrap_or(4);
    params.set_n_threads(threads);
    if state.full(params, samples).is_err() {
        return String::new();
    }
    let n = state.full_n_segments().unwrap_or(0);
    let mut text = String::new();
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            text.push_str(&seg);
            text.push(' ');
        }
    }
    text.trim().to_string()
}

/// Streaming sherpa-onnx zipformer engine (primary). Feeds the audio stream
/// incrementally and emits `partial` events as words arrive, `final` at each
/// detected endpoint (built-in rule-based trailing-silence). Returns Err ONLY if
/// the model can't be loaded (so the caller falls back to whisper); a clean stop
/// returns Ok. ONNX Runtime does runtime CPU dispatch, so this is safe on any CPU.
fn run_engine_sherpa(app: &AppHandle, stop: &Arc<AtomicBool>) -> Result<(), String> {
    use sherpa_transducers::asr::Model;

    emit_line(
        app,
        serde_json::json!({"type": "status", "stage": "loading_model", "engine": "streaming"}),
    );

    let threads = std::thread::available_parallelism()
        .map(|n| (n.get().saturating_sub(2)).clamp(2, 6))
        .unwrap_or(4);
    // Fetch the streaming zipformer (cached after first run) and build the model.
    let cfg = tauri::async_runtime::block_on(Model::from_pretrained(
        "nytopop/zipformer-en-2023-06-21-320ms",
    ))
    .map_err(|e| format!("model fetch: {e}"))?;
    let model = cfg
        .sample_rate(TARGET_RATE)
        .num_threads(threads)
        .cpu()
        .detect_endpoints(true)
        .rule2_min_trailing_silence(0.8_f32) // end a turn ~0.8s after they stop
        .build()
        .map_err(|e| format!("model build: {e}"))?;
    let mut asr = model.online_stream().map_err(|e| format!("stream: {e}"))?;

    // WASAPI system-audio loopback (auto-reconnecting) — shared capture path.
    let (captured, source_rate_f, cap_handle) = spawn_capture(app, stop)?;
    let source_rate = source_rate_f as usize;

    emit_line(
        app,
        serde_json::json!({"type": "status", "stage": "ready", "target": "system.audio", "engine": "streaming"}),
    );

    // Streaming loop: sherpa resamples internally, so hand it raw source-rate audio.
    let mut shown = String::new();
    while !stop.load(Ordering::Relaxed) {
        let raw: Vec<f32> = {
            let mut g = captured.lock().unwrap();
            std::mem::take(&mut *g)
        };
        if !raw.is_empty() {
            asr.accept_waveform(source_rate, &raw);
        }
        while asr.is_ready() {
            asr.decode();
        }
        let text = asr.result().unwrap_or_default();
        let t = text.trim();
        if asr.is_endpoint() {
            if !t.is_empty() {
                emit_line(app, serde_json::json!({"type": "final", "text": t}));
            }
            asr.reset();
            shown.clear();
        } else if !t.is_empty() && t != shown {
            emit_line(app, serde_json::json!({"type": "partial", "text": t}));
            shown = t.to_string();
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    let _ = cap_handle.join();
    let _ = app.emit("robert://terminated", Option::<i32>::None);
    Ok(())
}

/// Encode 16 kHz mono f32 samples as a PCM16 WAV (RIFF) blob for POSTing.
fn pcm16_wav_16k(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + samples.len() * 2);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVE");
    w.extend_from_slice(b"fmt ");
    w.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    w.extend_from_slice(&1u16.to_le_bytes()); // format = PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // channels = mono
    w.extend_from_slice(&(TARGET_RATE as u32).to_le_bytes()); // sample rate
    w.extend_from_slice(&((TARGET_RATE as u32) * 2).to_le_bytes()); // byte rate
    w.extend_from_slice(&2u16.to_le_bytes()); // block align
    w.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        w.extend_from_slice(&v.to_le_bytes());
    }
    w
}

/// Is an OpenAI-compatible transcription server (e.g. Parakeet-TDT) up here?
async fn server_health(base: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(format!("{}/health", base.trim_end_matches('/'))).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

/// POST one utterance (WAV) to the server's /v1/audio/transcriptions and return
/// the transcript text.
async fn post_transcribe(base: &str, wav: Vec<u8>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("a.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json")
        .text("language", "en");
    let resp = client
        .post(format!("{}/v1/audio/transcriptions", base.trim_end_matches('/')))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["text"].as_str().unwrap_or("").trim().to_string())
}

/// On-device transcription-SERVER engine (primary when a server is up): capture
/// audio locally but send each utterance to a fast local OpenAI-compatible ASR
/// server (Parakeet-TDT via achetronic/parakeet on :5092). Robert only captures
/// + POSTs; the heavy single-pass decode runs in that server — fast enough to
/// keep up even on a throttled CPU where whisper can't. Returns Err if the server
/// isn't reachable (so the caller falls back to the local engines).
fn run_engine_server(app: &AppHandle, stop: &Arc<AtomicBool>, base: &str) -> Result<(), String> {
    if !tauri::async_runtime::block_on(server_health(base)) {
        return Err(format!("no transcription server at {base}"));
    }
    let (captured, source_rate, cap_handle) = spawn_capture(app, stop)?;
    let mut resampler = Resampler::new(source_rate, TARGET_RATE as f64);
    emit_line(
        app,
        serde_json::json!({"type":"status","stage":"ready","target":"system.audio","engine":"server"}),
    );

    let check_ms: u64 = 120;
    let silence_ms_limit: u64 = 800;
    let partial_step = (1.5 * TARGET_RATE as f32) as usize; // ~1.5s of new speech
    let max_utter = 30 * TARGET_RATE; // cap a turn at 30s
    let mut utter: Vec<f32> = Vec::new();
    let mut energies: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
    let mut had_speech = false;
    let mut silent_ms: u64 = 0;
    let mut last_post_len: usize = 0;
    let mut shown = String::new();

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(check_ms));
        let raw: Vec<f32> = {
            let mut g = captured.lock().unwrap();
            std::mem::take(&mut *g)
        };
        if raw.is_empty() {
            if had_speech {
                silent_ms += check_ms;
            }
        } else {
            let fresh = resampler.process(&raw);
            if !fresh.is_empty() {
                let avg: f32 = fresh.iter().map(|x| x.abs()).sum::<f32>() / fresh.len() as f32;
                energies.push_back(avg);
                if energies.len() > 20 {
                    energies.pop_front();
                }
                let floor = energies.iter().cloned().fold(f32::INFINITY, f32::min).max(1e-4);
                let voice = avg > 0.004 || (avg > 0.0015 && avg > floor * 2.0);
                if had_speech || voice {
                    utter.extend_from_slice(&fresh);
                    if utter.len() > max_utter {
                        let cut = utter.len() - max_utter;
                        utter.drain(..cut);
                    }
                }
                if voice {
                    had_speech = true;
                    silent_ms = 0;
                    if utter.len().saturating_sub(last_post_len) > partial_step {
                        last_post_len = utter.len();
                        let wav = pcm16_wav_16k(&utter);
                        if let Ok(text) = tauri::async_runtime::block_on(post_transcribe(base, wav)) {
                            if !text.is_empty() && text != shown {
                                shown = text.clone();
                                emit_line(app, serde_json::json!({"type":"partial","text":text}));
                            }
                        }
                    }
                } else if had_speech {
                    silent_ms += check_ms;
                }
            }
        }
        if had_speech && silent_ms >= silence_ms_limit {
            if !utter.is_empty() {
                let wav = pcm16_wav_16k(&utter);
                if let Ok(text) = tauri::async_runtime::block_on(post_transcribe(base, wav)) {
                    if !text.is_empty() {
                        emit_line(app, serde_json::json!({"type":"final","text":text}));
                    }
                }
            }
            had_speech = false;
            silent_ms = 0;
            last_post_len = 0;
            shown.clear();
            utter.clear();
        }
    }
    let _ = cap_handle.join();
    let _ = app.emit("robert://terminated", Option::<i32>::None);
    Ok(())
}

/// Entry point. Preference order: (1) a local OpenAI-compatible transcription
/// server if one is up (Parakeet-TDT — offloads the heavy decode, fast even on a
/// throttled CPU), (2) the streaming sherpa-onnx engine, (3) the whisper.cpp
/// engine. ROBERT_STT=whisper|sherpa forces one; ROBERT_STT_URL overrides the
/// server URL (default http://127.0.0.1:5092). Same events either way.
pub fn run_engine(app: AppHandle, stop: Arc<AtomicBool>) {
    let mode = std::env::var("ROBERT_STT").unwrap_or_default().to_ascii_lowercase();

    if mode == "whisper" {
        return run_engine_whisper(app, stop);
    }

    // Auto-detect a local transcription server unless the user forced a local engine.
    if mode != "sherpa" {
        let url = std::env::var("ROBERT_STT_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:5092".into());
        if tauri::async_runtime::block_on(server_health(&url)) {
            emit_line(
                &app,
                serde_json::json!({"type":"status","stage":"loading_model","note":format!("using transcription server at {url}")}),
            );
            match run_engine_server(&app, &stop, &url) {
                Ok(()) => return,
                Err(e) => {
                    emit_line(
                        &app,
                        serde_json::json!({"type":"status","stage":"loading_model","note":format!("transcription server error ({e}); using local engine")}),
                    );
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                }
            }
        }
    }

    if mode != "whisper" {
        match run_engine_sherpa(&app, &stop) {
            Ok(()) => return,
            Err(e) => {
                emit_line(
                    &app,
                    serde_json::json!({"type": "status", "stage": "loading_model", "note": format!("streaming engine unavailable ({e}); using whisper")}),
                );
                if stop.load(Ordering::Relaxed) {
                    return;
                }
            }
        }
    }
    run_engine_whisper(app, stop);
}

/// The whisper.cpp engine (fallback): capture -> resample -> VAD -> end-of-turn.
/// Runs on its own thread until `stop` is set.
fn run_engine_whisper(app: AppHandle, stop: Arc<AtomicBool>) {
    emit_line(&app, serde_json::json!({"type": "status", "stage": "loading_model"}));

    let model_path = match ensure_model(&app) {
        Ok(p) => p,
        Err(e) => return emit_error(&app, &e),
    };
    let ctx = match whisper_rs::WhisperContext::new_with_params(
        &model_path.to_string_lossy(),
        whisper_rs::WhisperContextParameters::default(),
    ) {
        Ok(c) => c,
        Err(e) => return emit_error(&app, &format!("whisper load failed: {}", e)),
    };
    let mut wstate = match ctx.create_state() {
        Ok(s) => s,
        Err(e) => return emit_error(&app, &format!("whisper state failed: {}", e)),
    };

    // WASAPI system-audio loopback (auto-reconnecting) — shared capture path.
    let (captured, source_rate, cap_handle) = match spawn_capture(&app, &stop) {
        Ok(t) => t,
        Err(e) => return emit_error(&app, &e),
    };
    let mut resampler = Resampler::new(source_rate, TARGET_RATE as f64);

    emit_line(
        &app,
        serde_json::json!({"type": "status", "stage": "ready", "target": "system.audio", "engine": "whisper"}),
    );

    // turn loop — same constants and semantics as the macOS engine
    let check_ms: u64 = 120;
    let silence_ms_limit: u64 = 900;
    let mut samples16: Vec<f32> = Vec::new();
    let mut energies: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
    let mut had_speech = false;
    let mut silent_ms: u64 = 0;
    let mut last_partial_size: usize = 0;
    let mut empty_decodes = 0;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(check_ms));

        let fresh_raw: Vec<f32> = {
            let mut g = captured.lock().unwrap();
            std::mem::take(&mut *g)
        };
        if fresh_raw.is_empty() {
            if had_speech {
                silent_ms += check_ms;
            }
        } else {
            let fresh = resampler.process(&fresh_raw);
            if !fresh.is_empty() {
                // energy VAD: absolute threshold first (speech over loopback
                // sits well above this), rolling noise floor as the sensitive
                // secondary. Floor-only logic goes deaf when audio is loud
                // from the very first chunk (no quiet chunk to set the floor).
                let avg: f32 =
                    fresh.iter().map(|x| x.abs()).sum::<f32>() / fresh.len() as f32;
                energies.push_back(avg);
                if energies.len() > 20 {
                    energies.pop_front();
                }
                let floor = energies
                    .iter()
                    .cloned()
                    .fold(f32::INFINITY, f32::min)
                    .max(1e-4);
                // Lowered thresholds: modest playback volume was registering as
                // silence, producing zero-turn sessions. Still gated by the
                // empty-decode guard below so sustained non-speech gets dropped.
                let voice = avg > 0.004 || (avg > 0.0015 && avg > floor * 2.0);
                samples16.extend_from_slice(&fresh);

                if voice {
                    had_speech = true;
                    silent_ms = 0;
                    // partial every ~2s of fresh audio, tail-window decode
                    if samples16.len().saturating_sub(last_partial_size) > 2 * TARGET_RATE {
                        last_partial_size = samples16.len();
                        let win = samples16.len().min(12 * TARGET_RATE);
                        let text =
                            transcribe(&mut wstate, &samples16[samples16.len() - win..]);
                        if !text.is_empty() {
                            empty_decodes = 0;
                            emit_line(
                                &app,
                                serde_json::json!({"type": "partial", "text": text}),
                            );
                        } else {
                            empty_decodes += 1;
                            if empty_decodes >= 2 {
                                // sustained non-speech energy (music, noise):
                                // drop it and wait for a fresh onset
                                empty_decodes = 0;
                                had_speech = false;
                                silent_ms = 0;
                                last_partial_size = 0;
                                let keep = TARGET_RATE / 5;
                                if samples16.len() > keep {
                                    samples16.drain(..samples16.len() - keep);
                                }
                            }
                        }
                    }
                } else if had_speech {
                    silent_ms += check_ms;
                }
            }
        }

        if had_speech && silent_ms >= silence_ms_limit {
            let win = samples16.len().min(30 * TARGET_RATE);
            let text = transcribe(&mut wstate, &samples16[samples16.len() - win..]);
            if !text.is_empty() {
                emit_line(&app, serde_json::json!({"type": "final", "text": text}));
            }
            had_speech = false;
            silent_ms = 0;
            last_partial_size = 0;
            empty_decodes = 0;
            let keep = TARGET_RATE / 5;
            if samples16.len() > keep {
                samples16.drain(..samples16.len() - keep);
            }
        }
    }

    let _ = cap_handle.join();
    let _ = app.emit("robert://terminated", Option::<i32>::None);
}
