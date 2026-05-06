//! Audio/video-import staging (AIZ-31, streaming AIZ-47).
//!
//! Sister of `transcript_import` — same destination (`PendingImport` in
//! shared state, picked up by the meeting window via `take_pending_import`),
//! but the input is a media file. As of AIZ-47 the path is fully
//! streaming:
//!
//! 1. Stage an empty `PendingImport` with `streaming: true`. Open the
//!    meeting window immediately with `?autostart=import`.
//! 2. Spawn a worker thread that decodes the media file (`.wav` / `.mp3` /
//!    `.m4a` / `.flac` / `.mp4` / `.mov` / `.webm` / `.mkv`) to mono 16k
//!    f32, then runs whisper.cpp + tinydiarize via
//!    `audio::transcribe_audio_file_streaming`.
//! 3. Whisper's `new_segment_callback` fires per segment during
//!    inference; we convert each one to an `ImportedChunk` and emit a
//!    Tauri `audio-import-segment` event keyed by the import id. The
//!    meeting window's `startImportStream` path subscribes to this
//!    stream and feeds chunks into the existing batch loop.
//! 4. On completion: emit `audio-import-done`. On failure or cancel:
//!    emit `audio-import-error`.
//! 5. The saved snapshot still tags `MeetingSource::AudioImport` and
//!    forces `ExtractionMode::Substance` (see AIZ-14 note below).
//!
//! Cancellation: `cancel_audio_import(id)` flips the abort flag; the
//! whisper worker checks it via `set_abort_callback_safe` between graph
//! evaluations and aborts cleanly. Used by the meeting window's close
//! handler so we don't burn CPU on a transcription whose output goes
//! nowhere.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio;
use crate::transcript_import::{self, ExtractionMode, ImportedChunk, MeetingSource};

/// Per-import abort flags. The whisper worker thread reads its flag via
/// `set_abort_callback_safe`; `cancel_audio_import` flips it from the
/// meeting window's close handler.
#[derive(Default)]
pub struct AudioImportsState {
    pub aborts: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Per-segment payload for the `audio-import-segment` Tauri event. The
/// shape mirrors `ImportedChunk` (camelCase) so the frontend feeder can
/// consume it without an extra mapping step.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportSegmentPayload {
    pub import_id: String,
    pub chunk: ImportedChunk,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportDonePayload {
    pub import_id: String,
    pub segment_count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportProgressPayload {
    pub import_id: String,
    /// 0..=100. Driven by whisper.cpp's progress callback, which fires
    /// repeatedly during inference; the frontend coalesces these into
    /// the status-pill progress bar.
    pub percent: i32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportErrorPayload {
    pub import_id: String,
    pub message: String,
}

/// AIZ-38 — named-phase progress event for the meeting status panel.
/// Phase IDs are stable strings the frontend matches against:
/// - `downloading-model` — first-run only; `bytes` / `total` populated.
///   `total` may be `None` for servers that omit `Content-Length`.
/// - `decoding` — symphonia/hound is converting the file to mono 16k f32.
///   No progress; the file is read end-to-end before whisper starts.
/// - `transcribing` — whisper inference. `percent` mirrors the existing
///   `audio-import-progress` event so the pill can pick whichever it
///   prefers; we keep both for backwards compatibility.
/// - `staging` — final hand-off; the meeting window is about to flip
///   from "transcribing" to "thinking" as the last batch lands.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioImportPhasePayload {
    pub import_id: String,
    pub phase: &'static str,
    /// Human-readable label for the status pill. Backend-owned so we can
    /// tweak copy without a frontend redeploy.
    pub label: String,
    /// Bytes downloaded so far (only set during `downloading-model`).
    pub bytes: Option<u64>,
    /// Total bytes (only set during `downloading-model`, and only when
    /// the server sent `Content-Length`).
    pub total: Option<u64>,
    /// 0..=100 for `transcribing`; `None` otherwise.
    pub percent: Option<i32>,
}

/// AIZ-47 — public envelope returned by `start_streaming_audio_import`.
/// Mirrors the shape `StagedImport` had pre-streaming so callers
/// (Tauri command + IPC handler) keep the same response contract.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamingImportStarted {
    pub id: String,
    pub source_file: String,
    pub extraction_mode: ExtractionMode,
    pub source: MeetingSource,
}

/// Validate the path, stage an empty placeholder, open the meeting window,
/// and spawn the whisper worker. Returns immediately — the worker thread
/// drives the rest of the pipeline. Replaces the pre-AIZ-47
/// `stage_pending_audio_import` blocking call.
pub fn start_streaming_audio_import(
    app: &AppHandle,
    audio_path: &Path,
) -> Result<StreamingImportStarted, String> {
    if !audio_path.exists() {
        return Err(format!(
            "Audio file does not exist: {}",
            audio_path.display()
        ));
    }
    let basename = audio_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "Could not derive filename from path: {}",
                audio_path.display()
            )
        })?;

    let model_path = crate::notes_dir().join("models").join(audio::MODEL_FILENAME);
    crate::log(&format!(
        "[audio-import] start: {} (model={})",
        audio_path.display(),
        model_path.display()
    ));
    // AIZ-38 — model download is no longer pre-flighted on the IPC
    // thread. The 488MB first-run download blocked the palette for ~5min
    // with no UI feedback; we now stage immediately, open the meeting
    // window, and let the worker thread emit `audio-import-phase` events
    // (`downloading-model` → `decoding` → `transcribing` → `staging`)
    // that the status panel renders into a real progress bar. Any
    // download failure surfaces through `audio-import-error` exactly
    // like a whisper inference error already does.

    // AIZ-14 resolution: tinydiarize cannot identify speakers (no
    // embeddings) — its turn-flag is too noisy to drive labels. Both
    // file and live paths now emit a single `Speaker A` label, so
    // attribution mode would only ever produce one bogus `person`
    // node. Force Substance mode until a real embedding-based
    // diarizer lands.
    let extraction_mode = ExtractionMode::Substance;

    let id = transcript_import::stage_streaming_audio_pending(
        app,
        basename.clone(),
        extraction_mode,
    )?;

    // Register the abort flag before spawning so a fast cancel from the
    // meeting window (e.g. user closes immediately) can't race past the
    // worker's first abort-callback poll.
    let abort = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AudioImportsState>();
        let mut map = state
            .aborts
            .lock()
            .map_err(|e| format!("lock audio_imports: {e}"))?;
        map.insert(id.clone(), abort.clone());
    }

    let worker_app = app.clone();
    let worker_id = id.clone();
    let worker_path = audio_path.to_path_buf();
    let worker_abort = abort.clone();
    thread::spawn(move || {
        run_streaming_worker(worker_app, worker_id, worker_path, model_path, worker_abort);
    });

    Ok(StreamingImportStarted {
        id,
        source_file: basename,
        extraction_mode,
        source: MeetingSource::AudioImport,
    })
}

/// Drives the whisper worker thread. Emits per-segment events as
/// inference produces them; emits a terminal `audio-import-done` or
/// `audio-import-error` event when finished. AIZ-38 — also emits
/// `audio-import-phase` events at each stage (`downloading-model`,
/// `decoding`, `transcribing`, `staging`) so the meeting window's
/// status pill can render real progress instead of a single
/// "Transcribing…" message that blocks for 5+ minutes on first run.
fn run_streaming_worker(
    app: AppHandle,
    import_id: String,
    audio_path: PathBuf,
    model_path: PathBuf,
    abort: Arc<AtomicBool>,
) {
    // AIZ-38 — download the model on the worker thread so the IPC handler
    // can return immediately. Skip the `downloading-model` phase event
    // when the file already exists at the expected size; `ensure_model`
    // returns instantly in that case. We mirror the cached-file check
    // here purely so we can avoid emitting a misleading "Downloading
    // model…" event when we'll never download anything.
    let model_already_present = matches!(
        std::fs::metadata(&model_path),
        Ok(meta) if meta.len() >= audio::MIN_MODEL_BYTES
    );
    if !model_already_present {
        emit_phase(
            &app,
            &import_id,
            "downloading-model",
            "Downloading whisper model (first run, ~488MB)…",
            Some(0),
            None,
            None,
        );
        let phase_app = app.clone();
        let phase_id = import_id.clone();
        // Throttle: integer-percent change OR ~1MB downloaded since last
        // tick. Without throttling we'd fire ~7500 events on a 488MB
        // download (one per 64KB chunk).
        let last_emit = Arc::new(Mutex::new((0u64, -1i32)));
        let result = audio::ensure_model_with_progress(
            &model_path,
            audio::MODEL_URL,
            move |bytes, total| {
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| ((bytes.saturating_mul(100)) / t).min(100) as i32);
                if let Ok(mut last) = last_emit.lock() {
                    let percent_changed = match percent {
                        Some(p) => p > last.1,
                        None => false,
                    };
                    let bytes_changed = bytes >= last.0.saturating_add(1_000_000);
                    if !percent_changed && !bytes_changed {
                        return;
                    }
                    last.0 = bytes;
                    if let Some(p) = percent {
                        last.1 = p;
                    }
                }
                emit_phase(
                    &phase_app,
                    &phase_id,
                    "downloading-model",
                    "Downloading whisper model (first run, ~488MB)…",
                    Some(bytes),
                    total,
                    percent,
                );
            },
        );
        if let Err(message) = result {
            emit_error(&app, &import_id, &message);
            cleanup_abort(&app, &import_id);
            return;
        }
    }

    if abort.load(Ordering::Relaxed) {
        cleanup_abort(&app, &import_id);
        return;
    }

    emit_phase(
        &app,
        &import_id,
        "decoding",
        "Decoding audio…",
        None,
        None,
        None,
    );

    let segment_count = Arc::new(Mutex::new(0usize));

    let emit_app = app.clone();
    let emit_id = import_id.clone();
    let counter = segment_count.clone();
    let on_segment = move |seg: audio::TranscriptSegment| {
        let chunk = ImportedChunk {
            speaker: seg.speaker,
            text: seg.text,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
        };
        if let Ok(mut n) = counter.lock() {
            *n += 1;
        }
        if let Err(e) = emit_app.emit(
            "audio-import-segment",
            AudioImportSegmentPayload {
                import_id: emit_id.clone(),
                chunk,
            },
        ) {
            crate::log(&format!(
                "[audio-import] emit segment failed for {emit_id}: {e}"
            ));
        }
    };

    // Whisper.cpp's progress callback fires *very* frequently (10-20+ Hz
    // during inference). The frontend cares about visible deltas, so we
    // only emit a Tauri event when the integer percent advances. This
    // also keeps the IPC channel from drowning in noise when the model
    // is hot. AIZ-38 — also fold the first observed percent into a
    // `transcribing` phase event so the status pill flips off
    // "decoding" the moment whisper starts producing.
    let prog_app = app.clone();
    let prog_id = import_id.clone();
    let last_percent = Arc::new(Mutex::new(-1i32));
    let phase_app_for_prog = app.clone();
    let phase_id_for_prog = import_id.clone();
    let on_progress = move |percent: i32| {
        let prev = if let Ok(mut last) = last_percent.lock() {
            if percent <= *last {
                return;
            }
            let prev = *last;
            *last = percent;
            prev
        } else {
            return;
        };
        if prev < 0 {
            emit_phase(
                &phase_app_for_prog,
                &phase_id_for_prog,
                "transcribing",
                "Transcribing…",
                None,
                None,
                Some(percent),
            );
        }
        if let Err(e) = prog_app.emit(
            "audio-import-progress",
            AudioImportProgressPayload {
                import_id: prog_id.clone(),
                percent,
            },
        ) {
            crate::log(&format!(
                "[audio-import] emit progress failed for {prog_id}: {e}"
            ));
        }
    };

    let result = audio::transcribe_audio_file_streaming(
        &model_path,
        &audio_path,
        on_segment,
        on_progress,
        abort.clone(),
    );

    // Drop the abort registration regardless of how we got here so a
    // late `cancel_audio_import` doesn't try to flip a stale flag.
    cleanup_abort(&app, &import_id);

    let total = segment_count.lock().map(|n| *n).unwrap_or(0);
    let aborted = abort.load(Ordering::Relaxed);
    match result {
        Ok(_duration_ms) => {
            crate::log(&format!(
                "[audio-import] done: {import_id} ({total} segment(s))"
            ));
            // AIZ-38 — flip the pill to "staging" between whisper hitting
            // 100% and the final batch landing in gemma. Short-lived but
            // makes the transition explicit so the user knows the bar
            // hasn't stalled.
            emit_phase(
                &app,
                &import_id,
                "staging",
                "Building meeting graph…",
                None,
                None,
                None,
            );
            if let Err(e) = app.emit(
                "audio-import-done",
                AudioImportDonePayload {
                    import_id: import_id.clone(),
                    segment_count: total,
                },
            ) {
                crate::log(&format!("[audio-import] emit done failed: {e}"));
            }
        }
        Err(_) if aborted => {
            // The meeting window flipped the abort flag (closed mid-import).
            // No `done` event and no `error` event — both would just
            // re-render against a closed window. ggml's exact error code
            // on abort varies (-1, -6, etc.), so we read the abort flag
            // here instead of trying to parse the error string.
            crate::log(&format!(
                "[audio-import] aborted: {import_id} ({total} segment(s) emitted)"
            ));
        }
        Err(message) => {
            emit_error(&app, &import_id, &message);
        }
    }
}

/// AIZ-38 — emit a `audio-import-phase` event scoped to one import.
fn emit_phase(
    app: &AppHandle,
    import_id: &str,
    phase: &'static str,
    label: &str,
    bytes: Option<u64>,
    total: Option<u64>,
    percent: Option<i32>,
) {
    if let Err(e) = app.emit(
        "audio-import-phase",
        AudioImportPhasePayload {
            import_id: import_id.to_string(),
            phase,
            label: label.to_string(),
            bytes,
            total,
            percent,
        },
    ) {
        crate::log(&format!(
            "[audio-import] emit phase {phase} failed for {import_id}: {e}"
        ));
    }
}

fn emit_error(app: &AppHandle, import_id: &str, message: &str) {
    crate::log(&format!("[audio-import] error: {import_id}: {message}"));
    if let Err(e) = app.emit(
        "audio-import-error",
        AudioImportErrorPayload {
            import_id: import_id.to_string(),
            message: message.to_string(),
        },
    ) {
        crate::log(&format!("[audio-import] emit error failed: {e}"));
    }
}

fn cleanup_abort(app: &AppHandle, import_id: &str) {
    if let Some(state) = app.try_state::<AudioImportsState>() {
        if let Ok(mut map) = state.aborts.lock() {
            map.remove(import_id);
        }
    }
}

/// Flip the abort flag for an in-flight import. Idempotent and safe to
/// call from anywhere (meeting window close handler, palette retry, etc).
pub fn cancel_streaming_audio_import(app: &AppHandle, import_id: &str) {
    if let Some(state) = app.try_state::<AudioImportsState>() {
        if let Ok(map) = state.aborts.lock() {
            if let Some(flag) = map.get(import_id) {
                flag.store(true, Ordering::Relaxed);
                crate::log(&format!("[audio-import] cancel requested: {import_id}"));
            }
        }
    }
}
