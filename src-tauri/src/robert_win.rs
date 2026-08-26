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
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
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

/// The engine loop: capture -> resample -> VAD -> end-of-turn -> events.
/// Runs on its own thread until `stop` is set.
pub fn run_engine(app: AppHandle, stop: Arc<AtomicBool>) {
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

    // WASAPI system-audio loopback (upstream speaker module), mono f32.
    let input = match SpeakerInput::new() {
        Ok(i) => i,
        Err(e) => return emit_error(&app, &format!("system audio capture failed: {}", e)),
    };
    let mut stream = input.stream();
    let source_rate = stream.sample_rate().max(8000) as f64;
    let mut resampler = Resampler::new(source_rate, TARGET_RATE as f64);

    // capture thread: drain the WASAPI stream into a shared buffer
    let captured: Arc<std::sync::Mutex<Vec<f32>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured2 = captured.clone();
    let stop3 = stop.clone();
    let cap_handle = std::thread::spawn(move || {
        tauri::async_runtime::block_on(async move {
            let mut chunk: Vec<f32> = Vec::with_capacity(1024);
            while !stop3.load(Ordering::Relaxed) {
                match stream.next().await {
                    Some(s) => {
                        chunk.push(s);
                        if chunk.len() >= 1024 {
                            captured2.lock().unwrap().extend_from_slice(&chunk);
                            chunk.clear();
                        }
                    }
                    None => break,
                }
            }
        });
    });

    emit_line(
        &app,
        serde_json::json!({"type": "status", "stage": "ready", "target": "system.audio"}),
    );

    // turn loop — same constants and semantics as the macOS engine
    let check_ms: u64 = 120;
    let silence_ms_limit: u64 = 1200;
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
                let voice = avg > 0.008 || (avg > 0.003 && avg > floor * 2.5);
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
