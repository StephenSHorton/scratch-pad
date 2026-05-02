//! Pad CRUD + window operations for the IPC server.
//!
//! The `Note` struct (defined at the top of `lib.rs`) is the wire shape
//! for every endpoint here — it's already `serde(rename_all = "camelCase")`
//! so we can serialise it directly. Mutation endpoints take a small
//! patch type so the wire shape stays explicit.

use std::sync::Arc;

use chrono::Utc;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::cli_server::error::{json_response, no_content, IpcError};
use crate::cli_server::IpcCtx;
use crate::{Note, NotesState, Position, Size};

// ---------------------------------------------------------------------------
// GET /v1/pads
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct PadList<'a> {
    pads: &'a [Note],
}

pub async fn list(ctx: &Arc<IpcCtx>, query: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    let mode = parse_visibility(query)?;
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    let notes = {
        let guard = state
            .notes
            .lock()
            .map_err(|e| IpcError::Internal(format!("lock notes: {e}")))?;
        guard
            .iter()
            .filter(|n| match mode {
                Visibility::VisibleOnly => !n.hidden,
                Visibility::HiddenOnly => n.hidden,
                Visibility::All => true,
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    Ok(json_response(StatusCode::OK, &PadList { pads: &notes }))
}

enum Visibility {
    VisibleOnly,
    HiddenOnly,
    All,
}

fn parse_visibility(query: &str) -> Result<Visibility, IpcError> {
    let mut include_hidden = false;
    let mut only_hidden = false;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None => (pair, ""),
        };
        match (k, v) {
            ("include", "hidden") => include_hidden = true,
            ("only", "hidden") => only_hidden = true,
            _ => {}
        }
    }
    if only_hidden {
        Ok(Visibility::HiddenOnly)
    } else if include_hidden {
        Ok(Visibility::All)
    } else {
        Ok(Visibility::VisibleOnly)
    }
}

// ---------------------------------------------------------------------------
// POST /v1/pads
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePadBody {
    title: Option<String>,
    body: String,
    color: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    ttl_hours: Option<i64>,
    /// Reserved for future routing; accepted but currently ignored at
    /// the IPC layer (LAN sharing is wired through MCP today).
    #[allow(dead_code)]
    scope: Option<String>,
    #[allow(dead_code)]
    intent: Option<String>,
}

pub async fn create(ctx: &Arc<IpcCtx>, body: &Bytes) -> Result<Response<Full<Bytes>>, IpcError> {
    let payload: CreatePadBody = parse_body(body)?;
    let color = payload
        .color
        .as_deref()
        .unwrap_or("yellow")
        .to_string();

    let size = match (payload.width, payload.height) {
        (Some(w), Some(h)) => Some(Size {
            width: w,
            height: h,
        }),
        _ => None,
    };

    let expires_at = payload.ttl_hours.map(|h| {
        let dur = chrono::Duration::hours(h.max(0));
        (Utc::now() + dur).to_rfc3339()
    });

    let note = Note {
        id: uuid::Uuid::new_v4().to_string(),
        title: payload.title,
        body: payload.body,
        color,
        created_at: Utc::now().to_rfc3339(),
        expires_at,
        position: None,
        size,
        hidden: false,
        hidden_at: None,
    };

    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    {
        let mut guard = state
            .notes
            .lock()
            .map_err(|e| IpcError::Internal(format!("lock notes: {e}")))?;
        guard.push(note.clone());
        crate::write_notes(&guard);
    }

    // Don't call sync_windows synchronously — it touches the webview
    // layer which must run on the main thread on macOS. The file watcher
    // (which observes notes.json) will pick this up and trigger sync
    // via its existing path.
    Ok(json_response(StatusCode::OK, &note))
}

// ---------------------------------------------------------------------------
// GET /v1/pads/:id
// ---------------------------------------------------------------------------

pub async fn get(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    validate_pad_id(id)?;
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    let guard = state
        .notes
        .lock()
        .map_err(|e| IpcError::Internal(format!("lock notes: {e}")))?;
    let note = guard
        .iter()
        .find(|n| n.id == id)
        .cloned()
        .ok_or(IpcError::NotFound)?;
    drop(guard);
    Ok(json_response(StatusCode::OK, &note))
}

// ---------------------------------------------------------------------------
// PATCH /v1/pads/:id
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchPadBody {
    title: Option<String>,
    body: Option<String>,
    color: Option<String>,
    position: Option<Position>,
    size: Option<Size>,
}

impl PatchPadBody {
    fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.body.is_none()
            && self.color.is_none()
            && self.position.is_none()
            && self.size.is_none()
    }
}

pub async fn patch(
    ctx: &Arc<IpcCtx>,
    id: &str,
    body: &Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    validate_pad_id(id)?;
    let payload: PatchPadBody = parse_body(body)?;
    if payload.is_empty() {
        return Err(IpcError::ValidationError(
            "PATCH body must include at least one field".into(),
        ));
    }
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;

    let updated = {
        let mut guard = state
            .notes
            .lock()
            .map_err(|e| IpcError::Internal(format!("lock notes: {e}")))?;
        let Some(idx) = guard.iter().position(|n| n.id == id) else {
            return Err(IpcError::NotFound);
        };
        if let Some(t) = payload.title {
            guard[idx].title = Some(t);
        }
        if let Some(b) = payload.body {
            guard[idx].body = b;
        }
        if let Some(c) = payload.color {
            guard[idx].color = c;
        }
        if let Some(p) = payload.position {
            guard[idx].position = Some(p);
        }
        if let Some(s) = payload.size {
            guard[idx].size = Some(s);
        }
        let cloned = guard[idx].clone();
        crate::write_notes(&guard);
        cloned
    };

    Ok(json_response(StatusCode::OK, &updated))
}

// ---------------------------------------------------------------------------
// DELETE /v1/pads/:id
// ---------------------------------------------------------------------------

pub async fn delete(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    validate_pad_id(id)?;
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    // Existence check first so 404 takes precedence over a side-effecting
    // window close.
    {
        let guard = state
            .notes
            .lock()
            .map_err(|e| IpcError::Internal(format!("lock notes: {e}")))?;
        if !guard.iter().any(|n| n.id == id) {
            return Err(IpcError::NotFound);
        }
    }
    let removed = crate::dismiss_note_inner(id, &ctx.app, &state);
    if !removed {
        return Err(IpcError::NotFound);
    }
    Ok(no_content())
}

// ---------------------------------------------------------------------------
// POST /v1/pads/:id/hide
// ---------------------------------------------------------------------------

pub async fn hide(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    validate_pad_id(id)?;
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    let updated = crate::hide_note_inner(id, &ctx.app, &state).ok_or(IpcError::NotFound)?;
    Ok(json_response(StatusCode::OK, &updated))
}

// ---------------------------------------------------------------------------
// POST /v1/pads/:id/show
// ---------------------------------------------------------------------------

pub async fn show(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    validate_pad_id(id)?;
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    let updated = crate::show_note_inner(id, &ctx.app, &state).ok_or(IpcError::NotFound)?;
    Ok(json_response(StatusCode::OK, &updated))
}

// ---------------------------------------------------------------------------
// POST /v1/pads/show-hidden
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ShowHiddenResponse {
    restored: usize,
}

pub async fn show_hidden(ctx: &Arc<IpcCtx>) -> Result<Response<Full<Bytes>>, IpcError> {
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    let restored = crate::restore_hidden_pads(&ctx.app, &state);
    Ok(json_response(
        StatusCode::OK,
        &ShowHiddenResponse { restored },
    ))
}

// ---------------------------------------------------------------------------
// POST /v1/pads/:id/focus
// ---------------------------------------------------------------------------

pub async fn focus(ctx: &Arc<IpcCtx>, id: &str) -> Result<Response<Full<Bytes>>, IpcError> {
    validate_pad_id(id)?;
    // Existence check via state, then focus the window if it's open.
    let state = ctx
        .app
        .try_state::<NotesState>()
        .ok_or_else(|| IpcError::Internal("NotesState missing".into()))?;
    {
        let guard = state
            .notes
            .lock()
            .map_err(|e| IpcError::Internal(format!("lock notes: {e}")))?;
        if !guard.iter().any(|n| n.id == id) {
            return Err(IpcError::NotFound);
        }
    }
    if let Some(window) = ctx.app.get_webview_window(id) {
        let _ = window.set_focus();
    }
    Ok(json_response(StatusCode::OK, &json!({"ok": true})))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_body<T: for<'de> Deserialize<'de>>(body: &Bytes) -> Result<T, IpcError> {
    if body.is_empty() {
        return Err(IpcError::ValidationError(
            "Request body must be a JSON object".into(),
        ));
    }
    serde_json::from_slice(body).map_err(|e| IpcError::ValidationError(format!("body: {e}")))
}

fn validate_pad_id(id: &str) -> Result<(), IpcError> {
    if id.is_empty() {
        return Err(IpcError::IdInvalid("empty id".into()));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(IpcError::IdInvalid(format!("invalid id: {id}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_visibility_defaults_to_visible_only() {
        assert!(matches!(
            parse_visibility("").unwrap(),
            Visibility::VisibleOnly
        ));
        assert!(matches!(
            parse_visibility("foo=bar").unwrap(),
            Visibility::VisibleOnly
        ));
    }

    #[test]
    fn parse_visibility_include_hidden() {
        assert!(matches!(
            parse_visibility("include=hidden").unwrap(),
            Visibility::All
        ));
    }

    #[test]
    fn parse_visibility_only_hidden_wins() {
        assert!(matches!(
            parse_visibility("include=hidden&only=hidden").unwrap(),
            Visibility::HiddenOnly
        ));
        assert!(matches!(
            parse_visibility("only=hidden").unwrap(),
            Visibility::HiddenOnly
        ));
    }

    #[test]
    fn validate_pad_id_rejects_traversal() {
        assert!(validate_pad_id("").is_err());
        assert!(validate_pad_id("../etc").is_err());
        assert!(validate_pad_id("a/b").is_err());
        assert!(validate_pad_id("a\\b").is_err());
        assert!(validate_pad_id("normal-uuid-1234").is_ok());
    }

    #[test]
    fn empty_patch_body_rejected() {
        let p = PatchPadBody {
            title: None,
            body: None,
            color: None,
            position: None,
            size: None,
        };
        assert!(p.is_empty());
    }
}
