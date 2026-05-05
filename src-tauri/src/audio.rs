//! Audio capture via cpal + whisper.cpp transcription via whisper-rs.
//! Slice A: blocking record-to-file for mic verification.
//! Slice B: ensure_model + transcribe_file for offline whisper inference.
//! Slice C: streaming sliding-window capture + per-window whisper.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// small.en-tdrz (~488MB) is the tinydiarize-finetuned small.en model. It
// emits speaker-turn predictions alongside transcription so we can split
// chunks by speaker. Larger than tiny.en, but tdrz isn't published for
// tiny — small.en is the smallest size that ships with diarization.
pub const MODEL_URL: &str =
    "https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin";
pub const MODEL_FILENAME: &str = "ggml-small.en-tdrz.bin";
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
    /// Cycling label like "Speaker A", "Speaker B" derived from
    /// tinydiarize's speaker-turn predictions. The tdrz model only knows
    /// "did the speaker just change" — it does not identify *who* — so
    /// labels alternate but don't persist identity across windows.
    pub speaker: String,
}

/// Format a 0-based speaker index as "Speaker A", "Speaker B", … "Speaker Z",
/// "Speaker AA", etc. Wraps around at 26 by default for the prototype.
fn speaker_label(idx: usize) -> String {
    let letter = char::from(b'A' + (idx % 26) as u8);
    format!("Speaker {letter}")
}

/// Minimum size we'll accept as a complete model. small.en-tdrz is ~488MB;
/// bump this constant if MODEL_URL changes again.
const MIN_MODEL_BYTES: u64 = 400_000_000;

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
/// run on a worker thread. Used by the test/dev commands; the
/// audio-import path (AIZ-31) goes through `transcribe_audio_file`,
/// which dispatches by extension and supports mp3/m4a/flac as well.
pub fn transcribe_file(
    model_path: &Path,
    wav_path: &Path,
) -> Result<Vec<TranscriptSegment>, String> {
    let samples = load_wav_as_mono_16k(wav_path)?;
    transcribe_samples(model_path, &samples)
}

/// AIZ-31 — single entry point for offline audio import. Dispatches the
/// decode by extension (`.wav` via `hound`, `.mp3`/`.m4a`/`.flac` via
/// symphonia), then runs whisper on the unified mono-16k f32 buffer.
/// Blocking — run on a worker thread.
pub fn transcribe_audio_file(
    model_path: &Path,
    audio_path: &Path,
) -> Result<Vec<TranscriptSegment>, String> {
    let samples = decode_audio_to_mono_16k(audio_path)?;
    if samples.is_empty() {
        return Err("Audio file decoded to zero samples".into());
    }
    transcribe_samples(model_path, &samples)
}

/// Whisper invocation shared between the WAV and decoded-audio paths.
/// `samples` must already be mono f32 PCM at 16 kHz.
fn transcribe_samples(
    model_path: &Path,
    samples: &[f32],
) -> Result<Vec<TranscriptSegment>, String> {
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
    params.set_tdrz_enable(true);

    state
        .full(params, samples)
        .map_err(|e| format!("Whisper inference failed: {e}"))?;

    let n = state.full_n_segments();
    let mut segments = Vec::with_capacity(n as usize);
    let mut speaker_idx: usize = 0;
    for i in 0..n {
        let segment = state
            .get_segment(i)
            .ok_or_else(|| format!("Failed to read segment {i}"))?;
        let text = segment
            .to_str()
            .map_err(|e| format!("Failed to read segment {i} text: {e}"))?
            .to_string();
        let t0 = segment.start_timestamp();
        let t1 = segment.end_timestamp();
        let turn_next = segment.next_segment_speaker_turn();
        let speaker = speaker_label(speaker_idx);
        // whisper.cpp returns timestamps in 10ms units
        segments.push(TranscriptSegment {
            text: text.trim().to_string(),
            start_ms: t0 * 10,
            end_ms: t1 * 10,
            speaker,
        });
        if turn_next {
            speaker_idx = speaker_idx.wrapping_add(1);
        }
    }
    Ok(segments)
}

/// Decode any whisper-compatible media file to mono f32 PCM at 16 kHz.
/// `.wav` goes through `hound`; the rest go through symphonia, which
/// reads audio tracks out of both audio-only files and video containers
/// (the video stream is silently ignored). `.mp4` / `.mov` are the same
/// ISO BMFF container as `.m4a`, so they share the same code path.
/// `.webm` and `.mkv` share the Matroska container (symphonia's `mkv`
/// feature handles both). Their audio is almost always Opus, which
/// symphonia 0.5 demuxes but cannot decode — see `decode_with_symphonia`
/// for the Opus branch that hands packets to the pure-Rust `opus-decoder`.
/// Other extensions are rejected so we can give the user a useful error
/// rather than a downstream symphonia probe failure.
pub fn decode_audio_to_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "wav" => load_wav_as_mono_16k(path),
        "mp3" | "m4a" | "flac" | "mp4" | "mov" | "webm" | "mkv" => {
            decode_with_symphonia(path)
        }
        other if other.is_empty() => Err(
            "Media file has no extension; expected .wav, .mp3, .m4a, .flac, .mp4, .mov, .webm, or .mkv"
                .into(),
        ),
        other => Err(format!(
            "Unsupported media extension: .{other}. Use .wav, .mp3, .m4a, .flac, .mp4, .mov, .webm, or .mkv."
        )),
    }
}

/// Decode a symphonia-supported file (mp3/m4a/flac/mp4/mov/webm/mkv) to
/// mono 16 kHz f32 PCM. Most codecs go through symphonia end-to-end;
/// Opus tracks (browser WebM, screen recorders, etc.) are demuxed by
/// symphonia but decoded with the pure-Rust `opus-decoder` crate because
/// symphonia 0.5 has no Opus decoder of its own.
fn decode_with_symphonia(path: &Path) -> Result<Vec<f32>, String> {
    use symphonia::core::codecs::{CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open audio file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Failed to probe audio format: {e}"))?;
    let format = probed.format;

    // Snapshot what we need from the borrowed track so we can move
    // `format` into the per-codec helper.
    let (codec, track_id, codec_params) = {
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("No decodable audio track found in file")?;
        (track.codec_params.codec, track.id, track.codec_params.clone())
    };

    if codec == CODEC_TYPE_OPUS {
        decode_opus_track(format, track_id, &codec_params)
    } else {
        decode_symphonia_track(format, track_id, &codec_params)
    }
}

/// Drives the symphonia decoder for a single audio track and returns
/// mono f32 PCM at 16 kHz.
fn decode_symphonia_track(
    mut format: Box<dyn symphonia::core::formats::FormatReader>,
    track_id: u32,
    codec_params: &symphonia::core::codecs::CodecParameters,
) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error as SymphoniaError;

    // Container probes don't always populate sample_rate / channels up
    // front (m4a in particular surfaces them only after the first
    // decoded packet). Read both lazily from the first decoded buffer's
    // spec; codec_params is just an early hint.
    let mut sample_rate = codec_params.sample_rate;
    let mut channels: Option<usize> = codec_params.channels.map(|c| c.count());

    let mut decoder = symphonia::default::get_codecs()
        .make(codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to create audio decoder: {e}"))?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut interleaved: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // EOF surfaces as either ResetRequired or an UnexpectedEof
            // wrapped in IoError, depending on the container.
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("Read packet failed: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                if sample_buf.is_none() {
                    let spec = *decoded.spec();
                    if sample_rate.is_none() {
                        sample_rate = Some(spec.rate);
                    }
                    if channels.is_none() {
                        channels = Some(spec.channels.count());
                    }
                    let duration = decoded.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<f32>::new(duration, spec));
                }
                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(decoded);
                    interleaved.extend_from_slice(buf.samples());
                }
            }
            // Decode-only errors are recoverable per symphonia's contract.
            Err(SymphoniaError::DecodeError(e)) => {
                eprintln!("[audio-import] decode error (skipping packet): {e}");
                continue;
            }
            Err(e) => return Err(format!("Decoder error: {e}")),
        }
    }

    if interleaved.is_empty() {
        return Err("Audio file decoded to zero samples".into());
    }
    let channels = channels.ok_or("Audio track has unknown channel layout")?;
    let sample_rate = sample_rate.ok_or("Audio track has unknown sample rate")?;

    Ok(downmix_and_resample(&interleaved, channels, sample_rate))
}

/// Decode an Opus track (typical inside `.webm`/`.mkv` from MediaRecorder,
/// Loom, Tella, etc.) using the pure-Rust `opus-decoder` crate. Symphonia
/// hands us one Opus packet per call; each packet decodes to 2.5–60 ms of
/// audio at 48 kHz. We feed the decoder at 48 kHz / native channels, then
/// downmix and resample to mono 16 kHz like every other path.
fn decode_opus_track(
    mut format: Box<dyn symphonia::core::formats::FormatReader>,
    track_id: u32,
    codec_params: &symphonia::core::codecs::CodecParameters,
) -> Result<Vec<f32>, String> {
    use symphonia::core::errors::Error as SymphoniaError;

    // Opus always decodes at 48 kHz internally per RFC 6716. The track's
    // codec_params.sample_rate is the *original* capture rate hint; we
    // ignore it for decode and resample from 48 kHz to 16 kHz at the end.
    const OPUS_DECODE_RATE: u32 = 48_000;
    let channels: usize = codec_params
        .channels
        .map(|c| c.count())
        .filter(|&n| n > 0)
        .unwrap_or(1);
    if channels > 2 {
        return Err(format!(
            "Opus track has {channels} channels; only mono and stereo are supported"
        ));
    }

    let mut decoder = opus_decoder::OpusDecoder::new(OPUS_DECODE_RATE, channels)
        .map_err(|e| format!("Failed to create Opus decoder: {e}"))?;

    // Maximum Opus frame is 120 ms; at 48 kHz that's 5760 samples per
    // channel. Reuse this scratch buffer across packets to avoid churn.
    let max_samples_per_channel: usize = 5_760;
    let mut scratch: Vec<f32> = vec![0.0; max_samples_per_channel * channels];
    let mut interleaved: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("Read packet failed: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode_float(packet.buf(), &mut scratch, false) {
            Ok(samples_per_channel) => {
                let n = samples_per_channel * channels;
                interleaved.extend_from_slice(&scratch[..n]);
            }
            Err(e) => {
                eprintln!("[audio-import] opus decode error (skipping packet): {e}");
                continue;
            }
        }
    }

    if interleaved.is_empty() {
        return Err("Opus track decoded to zero samples".into());
    }

    Ok(downmix_and_resample(&interleaved, channels, OPUS_DECODE_RATE))
}

/// Downmix interleaved multichannel f32 PCM to mono and resample to
/// 16 kHz — the format whisper consumes.
fn downmix_and_resample(interleaved: &[f32], channels: usize, sample_rate: u32) -> Vec<f32> {
    let mono: Vec<f32> = if channels <= 1 {
        interleaved.to_vec()
    } else {
        interleaved
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };

    if sample_rate == 16_000 {
        mono
    } else {
        resample_linear(&mono, sample_rate, 16_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drives `decode_audio_to_mono_16k` against a real audio file at
    /// `$AIZ31_AUDIO_PATH`. Skipped silently when the env var is unset
    /// so CI / cargo-test on a clean checkout doesn't fail.
    #[test]
    fn decode_audio_to_mono_16k_real_file() {
        let path = match std::env::var("AIZ31_AUDIO_PATH") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => return,
        };
        let samples = decode_audio_to_mono_16k(&path).expect("decode failed");
        assert!(!samples.is_empty(), "decoded zero samples");
        let dur_s = samples.len() as f64 / 16_000.0;
        eprintln!(
            "decoded {} samples ({:.2}s @ 16kHz mono) from {}",
            samples.len(),
            dur_s,
            path.display()
        );
        assert!(dur_s > 0.0 && dur_s < 600.0, "duration out of plausible range");
    }

    #[test]
    fn decode_audio_to_mono_16k_rejects_unsupported() {
        let bad = std::path::Path::new("/tmp/does-not-exist.csv");
        let err = decode_audio_to_mono_16k(bad).unwrap_err();
        assert!(err.contains("Unsupported"), "got: {err}");
    }
}

// ---------------------------------------------------------------------------
// Streaming live capture (Slice C)
// ---------------------------------------------------------------------------

/// Sliding-window parameters. 8s window + 3s advance = 5s overlap.
/// tinydiarize needs more context than transcription alone — with 3s
/// windows the model essentially never predicted [SPEAKER_TURN] tokens,
/// because turns rarely fall entirely inside such a short clip. 8s gives
/// the model enough conversational context to fire turn predictions while
/// keeping first-chunk latency reasonable (~8s) and refresh cadence at 3s.
const STREAM_WINDOW_SECS: u32 = 8;
const STREAM_ADVANCE_SECS: u32 = 3;

/// Handle returned to a caller that started a streaming capture. Drop or
/// `stop()` to end the session — the threads watch the stop flag and exit
/// cleanly.
pub struct LiveCapture {
    stop_flag: Arc<AtomicBool>,
    capture_thread: Option<JoinHandle<()>>,
    transcribe_thread: Option<JoinHandle<()>>,
}

impl LiveCapture {
    pub fn stop(mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(t) = self.capture_thread.take() {
            t.join().ok();
        }
        if let Some(t) = self.transcribe_thread.take() {
            t.join().ok();
        }
    }
}

/// Starts a streaming capture session. Spawns a capture thread that holds
/// the cpal Stream and an audio-buffer mutex, plus a transcribe thread
/// that periodically drains a window from the buffer, runs whisper, and
/// invokes `on_segment` for each transcript segment whisper returns.
/// `on_level` mirrors the Slice A callback for live level visualization.
pub fn start_live_capture<L, S>(
    model_path: PathBuf,
    on_level: L,
    on_segment: S,
) -> Result<LiveCapture, String>
where
    L: Fn(f32) + Send + Sync + 'static + Clone,
    S: Fn(TranscriptSegment) + Send + Sync + 'static,
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

    let stop_flag = Arc::new(AtomicBool::new(false));
    let buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(
        sample_rate as usize * 60,
    )));

    // Capture thread: builds stream, holds it for the session, exits on stop
    let capture_buf = buf.clone();
    let capture_stop = stop_flag.clone();
    let capture_level = on_level.clone();
    let capture_thread = thread::spawn(move || {
        let err_fn = |err| eprintln!("[live-capture] stream error: {err}");

        let stream_result = match sample_format {
            SampleFormat::F32 => {
                let buf_cb = capture_buf.clone();
                let level_cb = capture_level.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut peak = 0f32;
                        if let Ok(mut guard) = buf_cb.lock() {
                            for &sample in data {
                                let abs = sample.abs();
                                if abs > peak {
                                    peak = abs;
                                }
                                if channels == 1 {
                                    guard.push(sample);
                                }
                            }
                            // Multichannel downmix: average each frame
                            if channels > 1 {
                                let n = channels as usize;
                                for chunk in data.chunks(n) {
                                    let avg: f32 =
                                        chunk.iter().copied().sum::<f32>() / n as f32;
                                    guard.push(avg);
                                }
                            }
                        }
                        level_cb(peak.min(1.0));
                    },
                    err_fn,
                    None,
                )
            }
            SampleFormat::I16 => {
                let buf_cb = capture_buf.clone();
                let level_cb = capture_level.clone();
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let mut peak: i16 = 0;
                        if let Ok(mut guard) = buf_cb.lock() {
                            if channels == 1 {
                                for &s in data {
                                    if s.abs() > peak {
                                        peak = s.abs();
                                    }
                                    guard.push(s as f32 / i16::MAX as f32);
                                }
                            } else {
                                let n = channels as usize;
                                for chunk in data.chunks(n) {
                                    let avg: f32 = chunk
                                        .iter()
                                        .map(|&s| s as f32 / i16::MAX as f32)
                                        .sum::<f32>()
                                        / n as f32;
                                    guard.push(avg);
                                    for &s in chunk {
                                        if s.abs() > peak {
                                            peak = s.abs();
                                        }
                                    }
                                }
                            }
                        }
                        level_cb(peak as f32 / i16::MAX as f32);
                    },
                    err_fn,
                    None,
                )
            }
            other => {
                eprintln!("[live-capture] unsupported sample format: {other:?}");
                return;
            }
        };

        let stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[live-capture] failed to build stream: {e}");
                return;
            }
        };
        if let Err(e) = stream.play() {
            eprintln!("[live-capture] failed to start stream: {e}");
            return;
        }

        while !capture_stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
    });

    // Transcribe thread: load whisper once, drain windows on a timer
    let trans_buf = buf.clone();
    let trans_stop = stop_flag.clone();
    let model_str = model_path
        .to_str()
        .ok_or("Model path is not valid UTF-8")?
        .to_string();
    let transcribe_thread = thread::spawn(move || {
        let ctx = match WhisperContext::new_with_params(
            &model_str,
            WhisperContextParameters::default(),
        ) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[live-transcribe] failed to load model: {e}");
                return;
            }
        };
        let mut state = match ctx.create_state() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[live-transcribe] failed to create state: {e}");
                return;
            }
        };

        let window_samples = (sample_rate * STREAM_WINDOW_SECS) as usize;
        let advance_samples = (sample_rate * STREAM_ADVANCE_SECS) as usize;
        let mut next_start = 0usize;
        // Track absolute meeting time for emitted timestamps
        let session_start = std::time::Instant::now();
        // tdrz produces a speaker_turn_next flag between successive segments
        // *within a single inference call*. Across window boundaries we have
        // no signal, so we just continue the current label — the next within-
        // window turn will resync. This loses speaker changes that happen
        // exactly at a boundary but is the simplest sound default.
        let mut speaker_idx: usize = 0;

        while !trans_stop.load(Ordering::Relaxed) {
            let buf_len = trans_buf.lock().map(|b| b.len()).unwrap_or(0);
            if buf_len < next_start + window_samples {
                thread::sleep(Duration::from_millis(250));
                continue;
            }

            let window: Vec<f32> = match trans_buf.lock() {
                Ok(b) => b[next_start..next_start + window_samples].to_vec(),
                Err(_) => continue,
            };

            let resampled = if sample_rate == 16_000 {
                window
            } else {
                resample_linear(&window, sample_rate, 16_000)
            };

            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_n_threads(4);
            params.set_translate(false);
            params.set_language(Some("en"));
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            params.set_no_context(true);
            params.set_tdrz_enable(true);

            if let Err(e) = state.full(params, &resampled) {
                eprintln!("[live-transcribe] inference failed: {e}");
                next_start += advance_samples;
                continue;
            }

            let n = state.full_n_segments();
            let window_offset_ms =
                session_start.elapsed().as_millis() as i64
                    - ((window_samples as i64) * 1000 / (sample_rate as i64));
            let mut window_turns = 0usize;
            for i in 0..n {
                let segment = match state.get_segment(i) {
                    Some(s) => s,
                    None => continue,
                };
                let text = match segment.to_str() {
                    Ok(t) => t.trim().to_string(),
                    Err(_) => continue,
                };
                let turn_next = segment.next_segment_speaker_turn();
                if turn_next {
                    window_turns += 1;
                }
                if text.is_empty() {
                    if turn_next {
                        speaker_idx = speaker_idx.wrapping_add(1);
                    }
                    continue;
                }
                let t0 = segment.start_timestamp() * 10;
                let t1 = segment.end_timestamp() * 10;
                on_segment(TranscriptSegment {
                    text,
                    start_ms: window_offset_ms + t0,
                    end_ms: window_offset_ms + t1,
                    speaker: speaker_label(speaker_idx),
                });
                if turn_next {
                    speaker_idx = speaker_idx.wrapping_add(1);
                }
            }
            eprintln!(
                "[live-transcribe] window: {n} segments, {window_turns} turn(s), speaker_idx={speaker_idx}"
            );
            // Bound buffer growth: trim everything before the next window's start
            let drop_before = next_start.saturating_add(advance_samples);
            if let Ok(mut b) = trans_buf.lock() {
                if b.len() > drop_before {
                    b.drain(0..drop_before);
                    next_start = 0;
                }
            }
            // Yield CPU briefly so capture isn't starved
            thread::sleep(Duration::from_millis(20));
        }
    });

    Ok(LiveCapture {
        stop_flag,
        capture_thread: Some(capture_thread),
        transcribe_thread: Some(transcribe_thread),
    })
}
