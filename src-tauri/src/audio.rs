//! Audio capture via cpal + whisper.cpp transcription via whisper-rs.
//! Slice A: blocking record-to-file for mic verification.
//! Slice B: ensure_model + transcribe_file for offline whisper inference.
//! Streaming sliding-window pipeline lands in Slice C.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// tiny.en (~39MB) is a deliberate prototype trade-off — base.en is higher
// quality but the download is slow on HuggingFace from some networks.
// Switch to ggml-base.en.bin once the pipeline is proven.
pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin";
pub const MODEL_FILENAME: &str = "ggml-tiny.en.bin";
use hound::{SampleFormat as HoundSampleFormat, WavSpec, WavWriter};

/// Records from the system default input device for `duration_secs` and
/// writes a 16-bit PCM WAV to `output_path`. Blocks the calling thread.
/// `on_level` is invoked once per audio buffer with a 0..1 peak amplitude —
/// the consumer can throttle further before forwarding to the UI.
pub fn record_to_file<F>(
    duration_secs: u32,
    output_path: PathBuf,
    on_level: F,
) -> Result<(), String>
where
    F: Fn(f32) + Send + Sync + 'static + Clone,
{
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No default input device available".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Failed to query input config: {e}"))?;

    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let sample_format = supported.sample_format();
    let stream_config: cpal::StreamConfig = supported.into();

    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: HoundSampleFormat::Int,
    };

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let writer = WavWriter::create(&output_path, spec)
        .map_err(|e| format!("Failed to create WAV file: {e}"))?;
    let writer = Arc::new(Mutex::new(Some(writer)));

    let err_fn = |err| eprintln!("audio stream error: {err}");

    let stream = match sample_format {
        SampleFormat::F32 => {
            let writer_cb = writer.clone();
            let level_cb = on_level.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut peak = 0f32;
                        if let Ok(mut guard) = writer_cb.lock() {
                            if let Some(w) = guard.as_mut() {
                                for &sample in data {
                                    let abs = sample.abs();
                                    if abs > peak {
                                        peak = abs;
                                    }
                                    let s = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                                    let _ = w.write_sample(s);
                                }
                            }
                        }
                        level_cb(peak.min(1.0));
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build f32 input stream: {e}"))?
        }
        SampleFormat::I16 => {
            let writer_cb = writer.clone();
            let level_cb = on_level.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let mut peak: i16 = 0;
                        if let Ok(mut guard) = writer_cb.lock() {
                            if let Some(w) = guard.as_mut() {
                                for &sample in data {
                                    if sample.abs() > peak {
                                        peak = sample.abs();
                                    }
                                    let _ = w.write_sample(sample);
                                }
                            }
                        }
                        level_cb(peak as f32 / i16::MAX as f32);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build i16 input stream: {e}"))?
        }
        SampleFormat::U16 => {
            let writer_cb = writer.clone();
            let level_cb = on_level.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let mut peak: i32 = 0;
                        if let Ok(mut guard) = writer_cb.lock() {
                            if let Some(w) = guard.as_mut() {
                                for &sample in data {
                                    let centered = sample as i32 - i16::MAX as i32;
                                    if centered.abs() > peak {
                                        peak = centered.abs();
                                    }
                                    let _ = w.write_sample(centered as i16);
                                }
                            }
                        }
                        level_cb(peak as f32 / i16::MAX as f32);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build u16 input stream: {e}"))?
        }
        other => return Err(format!("Unsupported sample format: {other:?}")),
    };

    stream
        .play()
        .map_err(|e| format!("Failed to start audio stream: {e}"))?;

    thread::sleep(Duration::from_secs(duration_secs as u64));

    drop(stream);

    if let Ok(mut guard) = writer.lock() {
        if let Some(w) = guard.take() {
            w.finalize()
                .map_err(|e| format!("Failed to finalize WAV file: {e}"))?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Whisper transcription
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TranscriptSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Minimum size we'll accept as a complete model. tiny.en is ~39MB; bump
/// this constant if MODEL_URL changes to a larger model.
const MIN_MODEL_BYTES: u64 = 30_000_000;

/// Downloads the model via curl if it's not already at `path`. Blocking.
/// Re-downloads when the existing file is suspiciously small (partial fetch
/// from an earlier interrupted run).
pub fn ensure_model(path: &Path, url: &str) -> Result<(), String> {
    if path.exists() {
        match std::fs::metadata(path) {
            Ok(meta) if meta.len() >= MIN_MODEL_BYTES => return Ok(()),
            Ok(meta) => {
                eprintln!(
                    "[whisper] removing partial model ({} bytes < {} required)",
                    meta.len(),
                    MIN_MODEL_BYTES
                );
                std::fs::remove_file(path).ok();
            }
            Err(_) => {
                std::fs::remove_file(path).ok();
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create model dir: {e}"))?;
    }
    eprintln!("[whisper] downloading model from {url} → {path:?}");
    let status = std::process::Command::new("curl")
        .args(["-L", "-f", "--progress-bar", "-o"])
        .arg(path)
        .arg(url)
        .status()
        .map_err(|e| format!("Failed to spawn curl: {e}"))?;
    if !status.success() {
        std::fs::remove_file(path).ok();
        return Err(format!("curl exited with status {status} downloading model"));
    }
    Ok(())
}

/// Reads a WAV file, downmixes to mono, resamples to 16kHz, returns f32 PCM
/// in the range whisper expects (roughly [-1.0, 1.0]).
fn load_wav_as_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("Failed to open WAV: {e}"))?;
    let spec = reader.spec();

    let samples_i16: Vec<i16> = reader
        .samples::<i16>()
        .filter_map(Result::ok)
        .collect();
    if samples_i16.is_empty() {
        return Err("WAV file contains no samples".into());
    }

    let mono: Vec<f32> = if spec.channels == 1 {
        samples_i16
            .iter()
            .map(|&s| s as f32 / i16::MAX as f32)
            .collect()
    } else {
        let n = spec.channels as usize;
        samples_i16
            .chunks(n)
            .map(|chunk| {
                let sum: f32 = chunk.iter().map(|&s| s as f32 / i16::MAX as f32).sum();
                sum / n as f32
            })
            .collect()
    };

    if spec.sample_rate == 16_000 {
        Ok(mono)
    } else {
        Ok(resample_linear(&mono, spec.sample_rate, 16_000))
    }
}

/// Naive linear-interpolation resampler. Good enough for prototype quality;
/// a higher-order resampler (rubato) is a Slice C+ refinement.
fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to {
        return input.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let out_len = (input.len() as f64 * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let lo = src.floor() as usize;
        let hi = (lo + 1).min(input.len().saturating_sub(1));
        let frac = (src - lo as f64) as f32;
        out.push(input[lo] * (1.0 - frac) + input[hi] * frac);
    }
    out
}

/// Loads the whisper model at `model_path` and transcribes the WAV at
/// `wav_path`. English-only, greedy decoding. Blocking — caller should
/// run on a worker thread.
pub fn transcribe_file(
    model_path: &Path,
    wav_path: &Path,
) -> Result<Vec<TranscriptSegment>, String> {
    let samples = load_wav_as_mono_16k(wav_path)?;

    let model_str = model_path
        .to_str()
        .ok_or("Model path is not valid UTF-8")?;

    let ctx = WhisperContext::new_with_params(model_str, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load whisper model: {e}"))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create whisper state: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(4);
    params.set_translate(false);
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);

    state
        .full(params, &samples)
        .map_err(|e| format!("Whisper inference failed: {e}"))?;

    let n = state
        .full_n_segments()
        .map_err(|e| format!("Failed to read segment count: {e}"))?;
    let mut segments = Vec::with_capacity(n as usize);
    for i in 0..n {
        let text = state
            .full_get_segment_text(i)
            .map_err(|e| format!("Failed to read segment {i}: {e}"))?;
        let t0 = state
            .full_get_segment_t0(i)
            .map_err(|e| format!("Failed to read segment {i} t0: {e}"))?;
        let t1 = state
            .full_get_segment_t1(i)
            .map_err(|e| format!("Failed to read segment {i} t1: {e}"))?;
        // whisper.cpp returns timestamps in 10ms units
        segments.push(TranscriptSegment {
            text: text.trim().to_string(),
            start_ms: t0 * 10,
            end_ms: t1 * 10,
        });
    }
    Ok(segments)
}
