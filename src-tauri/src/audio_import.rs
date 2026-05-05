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
pub struct AudioImportErrorPayload {
    pub import_id: String,
    pub message: String,
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
    // Pre-flight the model download synchronously so a missing model
    // fails fast (visible to the caller as a normal error) rather than
    // being swallowed by the worker thread on the way to an
    // `audio-import-error` event.
    audio::ensure_model(&model_path, audio::MODEL_URL)?;

    // AIZ-31 deliberately forces Substance mode. AIZ-14 (live-diarization
    // over-segmentation) is open; tinydiarize on file input may inherit
    // the same bug, and the attribution prompt would treat bogus speaker
    // boundaries as real participants. Once AIZ-14 is verified fixed for
    // file input, switch to a chunks-aware computation.
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
/// `audio-import-error` event when finished.
fn run_streaming_worker(
    app: AppHandle,
    import_id: String,
    audio_path: PathBuf,
    model_path: PathBuf,
    abort: Arc<AtomicBool>,
) {
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

    let abort_check = abort.clone();
    let on_abort = move || abort_check.load(Ordering::Relaxed);

    let result =
        audio::transcribe_audio_file_streaming(&model_path, &audio_path, on_segment, on_abort);

    // Drop the abort registration regardless of how we got here so a
    // late `cancel_audio_import` doesn't try to flip a stale flag.
    if let Some(state) = app.try_state::<AudioImportsState>() {
        if let Ok(mut map) = state.aborts.lock() {
            map.remove(&import_id);
        }
    }

    let total = segment_count.lock().map(|n| *n).unwrap_or(0);
    match result {
        Ok(_duration_ms) => {
            crate::log(&format!(
                "[audio-import] done: {import_id} ({total} segment(s))"
            ));
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
        Err(msg) if msg == "aborted" => {
            crate::log(&format!(
                "[audio-import] aborted: {import_id} ({total} segment(s) emitted)"
            ));
            // No `done` event — the meeting window already moved on
            // (it's the one who flipped the abort). An error event
            // would re-render an error pill against the closed window.
        }
        Err(message) => {
            crate::log(&format!("[audio-import] error: {import_id}: {message}"));
            if let Err(e) = app.emit(
                "audio-import-error",
                AudioImportErrorPayload {
                    import_id: import_id.clone(),
                    message,
                },
            ) {
                crate::log(&format!("[audio-import] emit error failed: {e}"));
            }
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
