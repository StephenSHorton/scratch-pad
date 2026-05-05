//! Meeting endpoints.
//!
//! The CRUD endpoints (`list`, `get`, `delete`, `patch`) are direct
//! pass-throughs to `crate::meetings::*` running on the blocking pool.
//!
//! `start` and `stop` are the interesting ones — they bridge the IPC
//! caller to the React meeting route.
//!
//! ## Start (POST /v1/meetings)
//!
//! 1. Generate a fresh meeting id (`meeting-<uuid>`).
//! 2. Open the meeting window with `?autostart=live` (or `=demo`) so the
//!    React route reads `window.location.search` on mount and kicks off
//!    `startLive()` / `startDemo()` itself.
//! 3. Return `{ id, openedWindow: true }` immediately. We don't wait for
//!    capture to actually begin — that's async on the React side.
//!
//! ## Stop (POST /v1/meetings/:id/stop)
//!
//! 1. Emit a Tauri event `cli:meeting-stop { id }` to all windows. The
//!    meeting route's session hook listens and calls `stopLive()` if the
//!    id matches.
//! 2. The existing `audio-phase: done` listener inside `useMeetingSession`
//!    finishes the save, then the React side emits `cli:meeting-stopped { id }`
//!    back to us.
//! 3. We poll the snapshot file for the post-save `endedAt` for up to ~3s.
//!    This is option (b) from the AIZ-20 plan: simple and robust against
//!    React-side restart races. If we time out, we still return the most
//!    recent meta with a 500 wrapped in `internal`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager};

use crate::audio_import;
use crate::cli_server::error::{json_response, no_content, IpcError};
use crate::cli_server::IpcCtx;
use crate::meetings::{self, MeetingMeta};
use crate::transcript_import;

// ---------------------------------------------------------------------------
// GET /v1/meetings
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct MeetingList {
    meetings: Vec<MeetingMeta>,
}

pub async fn list(ctx: &Arc<IpcCtx>) -> Result<Response<Full<Bytes>>, IpcError> {
    let base = ctx.notes_dir.clone();
    let metas = tauri::async_runtime::spawn_blocking(move || meetings::list_snapshots(&base))
        .await
        .map_err(|e| IpcError::Internal(format!("join: {e}")))?
        .map_err(IpcError::Internal)?;
    Ok(json_response(StatusCode::OK, &MeetingList { meetings: metas }))
}

// ---------------------------------------------------------------------------
// GET /v1/meetings/:id
// ---------------------------------------------------------------------------

pub async fn get(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    let id = id.to_string();
    let base = ctx.notes_dir.clone();
    let snap = tauri::async_runtime::spawn_blocking(move || meetings::load_snapshot(&base, &id))
        .await
        .map_err(|e| IpcError::Internal(format!("join: {e}")))?;
    match snap {
        Ok(value) => Ok(json_response(StatusCode::OK, &value)),
        Err(e) => Err(map_meeting_err(e)),
    }
}

// ---------------------------------------------------------------------------
// DELETE /v1/meetings/:id
// ---------------------------------------------------------------------------

pub async fn delete(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    let id = id.to_string();
    let base = ctx.notes_dir.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || meetings::delete_snapshot(&base, &id))
            .await
            .map_err(|e| IpcError::Internal(format!("join: {e}")))?;
    match result {
        Ok(()) => Ok(no_content()),
        Err(e) => Err(map_meeting_err(e)),
    }
}

// ---------------------------------------------------------------------------
// PATCH /v1/meetings/:id
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchMeetingBody {
    name: Option<String>,
    name_locked_by_user: Option<bool>,
}

pub async fn patch(
    ctx: &Arc<IpcCtx>,
    id: &str,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let payload: PatchMeetingBody =
        serde_json::from_slice(body).map_err(|e| IpcError::ValidationError(format!("body: {e}")))?;
    if payload.name.is_none() && payload.name_locked_by_user.is_none() {
        return Err(IpcError::ValidationError(
            "PATCH body must include name or nameLockedByUser".into(),
        ));
    }
    let id = id.to_string();
    let base = ctx.notes_dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        meetings::rename_snapshot(&base, &id, payload.name, payload.name_locked_by_user)
    })
    .await
    .map_err(|e| IpcError::Internal(format!("join: {e}")))?;
    match result {
        Ok(meta) => Ok(json_response(StatusCode::OK, &meta)),
        Err(e) => Err(map_meeting_err(e)),
    }
}

// ---------------------------------------------------------------------------
// POST /v1/meetings — start a new meeting
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StartMeetingBody {
    /// Either "live" or "demo".
    mode: String,
}

#[derive(Serialize)]
struct StartMeetingResponse {
    id: String,
    #[serde(rename = "openedWindow")]
    opened_window: bool,
}

pub async fn start(
    ctx: &Arc<IpcCtx>,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let payload: StartMeetingBody =
        serde_json::from_slice(body).map_err(|e| IpcError::ValidationError(format!("body: {e}")))?;

    let autostart = match payload.mode.as_str() {
        "live" => "live",
        "demo" => "demo",
        other => {
            return Err(IpcError::ValidationError(format!(
                "mode must be \"live\" or \"demo\" (got {other:?})"
            )))
        }
    };

    // If a live capture is already running, refuse rather than racing.
    // Demo doesn't share that state, so it's always allowed.
    if autostart == "live" {
        if let Some(state) = ctx.app.try_state::<crate::LiveAudioState>() {
            let guard = state
                .capture
                .lock()
                .map_err(|e| IpcError::Internal(format!("lock capture: {e}")))?;
            if guard.is_some() {
                return Err(IpcError::Conflict(
                    "Live capture is already running".into(),
                ));
            }
        }
    }

    let id = format!("meeting-{}", uuid::Uuid::new_v4());
    // The React route subscribes to `window.location.search`. Use that
    // as the handshake channel — nothing fancier needed.
    let query = format!("autostart={autostart}");
    crate::open_meeting_window_with_query(&ctx.app, Some(&id), Some(&query));

    Ok(json_response(
        StatusCode::OK,
        &StartMeetingResponse {
            id,
            opened_window: true,
        },
    ))
}

// ---------------------------------------------------------------------------
// POST /v1/meetings/import — AIZ-30 transcript import
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ImportMeetingBody {
    /// Raw transcript content. CLI reads the file; palette reads via FileReader.
    /// Server-side filesystem access is intentionally out of scope so the
    /// endpoint stays format-agnostic and sandbox-friendly.
    content: String,
    /// Original filename, used for extension dispatch and surfaced in the
    /// snapshot's `sourceFile` field.
    filename: String,
}

#[derive(Serialize)]
struct ImportMeetingResponse {
    id: String,
    #[serde(rename = "openedWindow")]
    opened_window: bool,
    #[serde(rename = "chunkCount")]
    chunk_count: usize,
    #[serde(rename = "sourceFile")]
    source_file: String,
}

pub async fn import(
    ctx: &Arc<IpcCtx>,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let payload: ImportMeetingBody = serde_json::from_slice(body)
        .map_err(|e| IpcError::ValidationError(format!("body: {e}")))?;

    let staged =
        transcript_import::stage_pending_import(&ctx.app, &payload.content, &payload.filename)
            .map_err(IpcError::ValidationError)?;

    Ok(json_response(
        StatusCode::OK,
        &ImportMeetingResponse {
            id: staged.id,
            opened_window: true,
            chunk_count: staged.chunk_count,
            source_file: staged.source_file,
        },
    ))
}

// The matching pop happens inside the meeting window via the Tauri
// command `take_pending_import` (see lib.rs). Same process, same managed
// state, no extra IPC hop needed.

// ---------------------------------------------------------------------------
// POST /v1/meetings/import-audio — AIZ-31 audio import
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportAudioMeetingBody {
    /// Absolute path to a media file (`.wav`, `.mp3`, `.m4a`, `.flac`,
    /// `.mp4`, `.mov`). Video files are decoded for their audio track;
    /// the video stream is ignored. We deliberately take a path rather
    /// than a binary blob — media files routinely exceed the 1 MB
    /// request-body cap, and the CLI is already bound to localhost-only
    /// so there's no sandbox crossing.
    path: String,
}

pub async fn import_audio(
    ctx: &Arc<IpcCtx>,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    let payload: ImportAudioMeetingBody = serde_json::from_slice(body)
        .map_err(|e| IpcError::ValidationError(format!("body: {e}")))?;

    let path_buf = std::path::PathBuf::from(&payload.path);
    // AIZ-47 — start_streaming_audio_import is non-blocking: it stages
    // an empty PendingImport, opens the meeting window, and spawns the
    // whisper worker thread. Segments arrive over Tauri events keyed by
    // the import id. `chunkCount: 0` is reported up front; the meeting
    // window is the source of truth for streaming progress.
    let started = audio_import::start_streaming_audio_import(&ctx.app, &path_buf)
        .map_err(IpcError::ValidationError)?;

    Ok(json_response(
        StatusCode::OK,
        &ImportMeetingResponse {
            id: started.id,
            opened_window: true,
            chunk_count: 0,
            source_file: started.source_file,
        },
    ))
}

// ---------------------------------------------------------------------------
// POST /v1/meetings/:id/stop
// ---------------------------------------------------------------------------

pub async fn stop(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    // No live capture in flight = nothing to stop. Per the plan, treat
    // both "id doesn't exist" and "exists but not live" as 404 — keeps
    // the contract simple for v1.
    let live_running = ctx
        .app
        .try_state::<crate::LiveAudioState>()
        .and_then(|s| s.capture.lock().ok().map(|g| g.is_some()))
        .unwrap_or(false);
    if !live_running {
        return Err(IpcError::NotFound);
    }

    // Snapshot the current `endedAt` (if any) before stopping so we can
    // detect when the React side has finished saving.
    let prior_ended_at = read_ended_at(&ctx.notes_dir, id);

    // Tell React to stop. The session hook listens for this event and
    // calls stopLive() if the id matches its current meetingIdRef.
    let payload = json!({ "id": id });
    if let Err(e) = ctx.app.emit("cli:meeting-stop", payload) {
        crate::log(&format!("[ipc] emit cli:meeting-stop: {e}"));
    }

    // Poll for the snapshot to be rewritten with a fresh `endedAt`.
    // Three seconds is generous — typical save is well under 200ms.
    let deadline = Instant::now() + Duration::from_millis(3_000);
    let mut last_meta: Option<MeetingMeta> = None;
    while Instant::now() < deadline {
        let id_owned = id.to_string();
        let base = ctx.notes_dir.clone();
        let meta_result = tauri::async_runtime::spawn_blocking(move || {
            meetings::get_meta(&base, &id_owned)
        })
        .await
        .map_err(|e| IpcError::Internal(format!("join: {e}")))?;
        if let Ok(meta) = meta_result {
            let saved = match prior_ended_at {
                Some(prev) => meta.ended_at > prev,
                None => meta.ended_at > 0,
            };
            if saved {
                return Ok(json_response(StatusCode::OK, &meta));
            }
            last_meta = Some(meta);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    // Timed out. Return whatever the most recent meta is (or 404 if no
    // file exists at all). The CLI / MCP layer can decide whether to
    // retry — they have the meeting id and can poll `GET /meetings/:id`.
    match last_meta {
        Some(meta) => Ok(json_response(StatusCode::OK, &meta)),
        None => Err(IpcError::NotFound),
    }
}

fn read_ended_at(base: &std::path::Path, id: &str) -> Option<i64> {
    meetings::get_meta(base, id).ok().map(|m| m.ended_at)
}

// ---------------------------------------------------------------------------
// POST /v1/meetings/:id/resume
// ---------------------------------------------------------------------------

pub async fn resume(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    // Verify the meeting exists before opening windows.
    let id_owned = id.to_string();
    let base = ctx.notes_dir.clone();
    let exists = tauri::async_runtime::spawn_blocking(move || meetings::get_meta(&base, &id_owned))
        .await
        .map_err(|e| IpcError::Internal(format!("join: {e}")))?;
    if let Err(e) = exists {
        return Err(map_meeting_err(e));
    }

    crate::open_meeting_window(&ctx.app, Some(id));

    Ok(json_response(
        StatusCode::OK,
        &json!({ "ok": true, "windowOpened": true }),
    ))
}

// ---------------------------------------------------------------------------
// POST /v1/meetings/:id/open
// ---------------------------------------------------------------------------

pub async fn open(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    let id_owned = id.to_string();
    let base = ctx.notes_dir.clone();
    let exists = tauri::async_runtime::spawn_blocking(move || meetings::get_meta(&base, &id_owned))
        .await
        .map_err(|e| IpcError::Internal(format!("join: {e}")))?;
    if let Err(e) = exists {
        return Err(map_meeting_err(e));
    }

    crate::open_meeting_window(&ctx.app, Some(id));
    Ok(json_response(StatusCode::OK, &json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn map_meeting_err(msg: String) -> IpcError {
    let lower = msg.to_lowercase();
    if lower.contains("not found") {
        IpcError::NotFound
    } else if lower.contains("invalid meeting id") {
        IpcError::IdInvalid(msg)
    } else if lower.contains("schemaversion") {
        IpcError::ValidationError(msg)
    } else {
        IpcError::Internal(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_err_maps_to_correct_codes() {
        let cases = &[
            ("Meeting not found: x", "not_found"),
            ("Invalid meeting id: ../etc", "id_invalid"),
            ("Unsupported meeting schemaVersion: 99", "validation_error"),
            ("disk on fire", "internal"),
        ];
        for (msg, expected) in cases {
            let err = map_meeting_err((*msg).to_string());
            assert_eq!(err.code(), *expected, "msg: {msg}");
        }
    }
}
