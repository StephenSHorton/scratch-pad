//! Audio/video-import staging (AIZ-31).
//!
//! Sister of `transcript_import` — same destination (`PendingImport` in
//! shared state, picked up by the meeting window via `take_pending_import`),
//! but the input is a media file. The path is:
//!
//! 1. Decode the file (`.wav` / `.mp3` / `.m4a` / `.flac` / `.mp4` /
//!    `.mov`) to mono 16k f32. Video files have their audio track pulled
//!    out by symphonia; the video stream is ignored.
//! 2. Run whisper.cpp + tinydiarize, getting `Vec<TranscriptSegment>` with
//!    real ms timestamps and cycling speaker labels.
//! 3. Convert segments → `ImportedChunk` (the shape the React batch loop
//!    consumes), preserving the real timestamps. AIZ-30's word-count
//!    timestamp synthesis is bypassed — whisper already gives us truth.
//! 4. Force `ExtractionMode::Substance` regardless of how many speakers
//!    tinydiarize labelled. AIZ-14 (over-segmentation in live diarization)
//!    is open; until that's fixed, the attribution prompt would amplify
//!    bogus speaker boundaries. Once AIZ-14 lands, swap this for
//!    `compute_extraction_mode(&chunks)` like the transcript path does.
//! 5. Stage with `MeetingSource::AudioImport` so the saved snapshot
//!    carries the right origin tag.

use std::path::Path;

use crate::audio;
use crate::transcript_import::{
    self, ImportedChunk, MeetingSource, StagedImport,
};

/// Validate, transcribe, and stage an audio file for offline import.
/// Blocking — caller should run on the async-runtime blocking pool so
/// whisper inference doesn't block the IPC server.
pub fn stage_pending_audio_import(
    app: &tauri::AppHandle,
    audio_path: &Path,
) -> Result<StagedImport, String> {
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
    audio::ensure_model(&model_path, audio::MODEL_URL)?;

    let segments = audio::transcribe_audio_file(&model_path, audio_path)?;
    if segments.is_empty() {
        return Err("Whisper produced no transcript segments".into());
    }
    crate::log(&format!(
        "[audio-import] transcribed {} segment(s) from {}",
        segments.len(),
        basename
    ));

    let chunks: Vec<ImportedChunk> = segments
        .into_iter()
        .filter(|s| !s.text.is_empty())
        .map(|s| ImportedChunk {
            speaker: s.speaker,
            text: s.text,
            start_ms: s.start_ms,
            end_ms: s.end_ms,
        })
        .collect();
    if chunks.is_empty() {
        return Err("Whisper produced segments with no text".into());
    }

    // AIZ-31 deliberately forces Substance mode. AIZ-14 (live-diarization
    // over-segmentation) is open; tinydiarize on file input may inherit
    // the same bug, and the attribution prompt would treat bogus speaker
    // boundaries as real participants. Once AIZ-14 is verified fixed for
    // file input, switch to `compute_extraction_mode(&chunks)`.
    let extraction_mode = transcript_import::ExtractionMode::Substance;

    transcript_import::stage_chunks(
        app,
        chunks,
        basename,
        extraction_mode,
        MeetingSource::AudioImport,
    )
}
