//! Hand-rolled `(method, path) → handler` dispatcher for the IPC server.
//!
//! Routes live under `/v1/`. Path params are pulled out of the segments
//! manually (we have ~25 endpoints; pulling in axum or matchit just for
//! that would be a big dep for very little payoff). Each endpoint is
//! authenticated except `GET /v1/app/status`, which is the unauth
//! "is the app running" probe.

use std::sync::Arc;

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::AUTHORIZATION;
use hyper::{Method, Request, Response};

use super::error::IpcError;
use super::handlers;
use super::IpcCtx;

/// Top-level dispatcher. Returns `Ok(response)` for both happy and
/// error paths — the server only sees a hard error if the connection
/// itself blows up.
pub async fn dispatch(
    ctx: Arc<IpcCtx>,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|s| s.to_string()).unwrap_or_default();

    let segments: Vec<&str> = path
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    // Auth gate. The status endpoint is the only one that's reachable
    // without a token. Everything else needs `Authorization: Bearer <token>`.
    let needs_auth = !is_status_route(&method, &segments);
    if needs_auth {
        if let Err(err) = check_auth(&ctx, &req) {
            return Ok(err.into_response());
        }
    }

    // Read body up to 1 MB. Larger bodies are a configuration error;
    // CLIs shouldn't be POSTing megabyte-sized JSON to us.
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return Ok(e.into_response()),
    };

    let result = route(&ctx, method.clone(), &segments, &query, body).await;
    Ok(match result {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    })
}

fn is_status_route(_method: &Method, segments: &[&str]) -> bool {
    // The status path itself is unauthenticated for any method — the
    // dispatcher will turn non-GET into a method_not_allowed without us
    // needing to leak auth state. Without this, an unauthenticated POST
    // to /v1/app/status would return 401 instead of the expected 405.
    segments == ["v1", "app", "status"]
}

fn check_auth(ctx: &IpcCtx, req: &Request<Incoming>) -> Result<(), IpcError> {
    let header = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let token = match header {
        Some(h) => h
            .strip_prefix("Bearer ")
            .ok_or(IpcError::AuthRequired)?
            .trim(),
        None => return Err(IpcError::AuthRequired),
    };
    if super::auth::token_matches(&ctx.token, token) {
        Ok(())
    } else {
        Err(IpcError::AuthInvalid)
    }
}

async fn read_body(req: Request<Incoming>) -> Result<Bytes, IpcError> {
    let collected = req
        .into_body()
        .collect()
        .await
        .map_err(|e| IpcError::Internal(format!("read body: {e}")))?;
    Ok(collected.to_bytes())
}

/// The actual route table. Keep this small and obvious — every line
/// corresponds to one endpoint in the AIZ-13 plan.
async fn route(
    ctx: &Arc<IpcCtx>,
    method: Method,
    segments: &[&str],
    query: &str,
    body: Bytes,
) -> Result<Response<Full<Bytes>>, IpcError> {
    // Empty path → not found
    if segments.is_empty() {
        return Err(IpcError::NotFound);
    }
    if segments[0] != "v1" {
        return Err(IpcError::NotFound);
    }

    let rest = &segments[1..];
    match (method.clone(), rest) {
        // ---- App ----
        (Method::GET, ["app", "status"]) => handlers::app::status(ctx).await,
        (_, ["app", "status"]) => Err(IpcError::MethodNotAllowed),

        // ---- Pads ----
        (Method::GET, ["pads"]) => handlers::pads::list(ctx, query).await,
        (Method::POST, ["pads"]) => handlers::pads::create(ctx, &body).await,
        (_, ["pads"]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["pads", "show-hidden"]) => handlers::pads::show_hidden(ctx).await,
        (_, ["pads", "show-hidden"]) => Err(IpcError::MethodNotAllowed),

        (Method::GET, ["pads", id]) => handlers::pads::get(ctx, id).await,
        (Method::PATCH, ["pads", id]) => handlers::pads::patch(ctx, id, &body).await,
        (Method::DELETE, ["pads", id]) => handlers::pads::delete(ctx, id).await,
        (_, ["pads", _]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["pads", id, "hide"]) => handlers::pads::hide(ctx, id).await,
        (_, ["pads", _, "hide"]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["pads", id, "show"]) => handlers::pads::show(ctx, id).await,
        (_, ["pads", _, "show"]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["pads", id, "focus"]) => handlers::pads::focus(ctx, id).await,
        (_, ["pads", _, "focus"]) => Err(IpcError::MethodNotAllowed),

        // ---- Meetings ----
        (Method::GET, ["meetings"]) => handlers::meetings::list(ctx).await,
        (Method::POST, ["meetings"]) => handlers::meetings::start(ctx, &body).await,
        (_, ["meetings"]) => Err(IpcError::MethodNotAllowed),

        // AIZ-30 — must come before the `["meetings", id]` arm so "import"
        // isn't matched as a meeting id.
        (Method::POST, ["meetings", "import"]) => handlers::meetings::import(ctx, &body).await,
        (_, ["meetings", "import"]) => Err(IpcError::MethodNotAllowed),

        (Method::GET, ["meetings", id]) => handlers::meetings::get(ctx, id).await,
        (Method::PATCH, ["meetings", id]) => handlers::meetings::patch(ctx, id, &body).await,
        (Method::DELETE, ["meetings", id]) => handlers::meetings::delete(ctx, id).await,
        (_, ["meetings", _]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["meetings", id, "stop"]) => handlers::meetings::stop(ctx, id).await,
        (_, ["meetings", _, "stop"]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["meetings", id, "resume"]) => handlers::meetings::resume(ctx, id).await,
        (_, ["meetings", _, "resume"]) => Err(IpcError::MethodNotAllowed),

        (Method::POST, ["meetings", id, "open"]) => handlers::meetings::open(ctx, id).await,
        (_, ["meetings", _, "open"]) => Err(IpcError::MethodNotAllowed),

        // Anything else under /v1/ is a 404. Avoids leaking internal
        // routes via the method_not_allowed signal.
        _ => Err(IpcError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_parse_correctly() {
        let cases: &[(&str, Vec<&str>)] = &[
            ("/v1/app/status", vec!["v1", "app", "status"]),
            ("/v1/pads", vec!["v1", "pads"]),
            ("/v1/pads/abc", vec!["v1", "pads", "abc"]),
            ("/v1/pads/abc/hide", vec!["v1", "pads", "abc", "hide"]),
            ("/v1/meetings/m-1/stop", vec!["v1", "meetings", "m-1", "stop"]),
            ("/", vec![]),
            ("//v1//pads//", vec!["v1", "pads"]),
        ];
        for (path, expected) in cases {
            let got: Vec<&str> = path
                .trim_start_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
                .collect();
            assert_eq!(&got, expected, "input: {path}");
        }
    }

    #[test]
    fn status_route_is_unauth() {
        // Both methods on the status path are unauth; the dispatcher
        // returns method_not_allowed for non-GET, which is more useful
        // than leaking a 401 for an obviously wrong method.
        assert!(is_status_route(&Method::GET, &["v1", "app", "status"]));
        assert!(is_status_route(&Method::POST, &["v1", "app", "status"]));
        assert!(!is_status_route(&Method::GET, &["v1", "pads"]));
        assert!(!is_status_route(&Method::GET, &["v1", "app"]));
    }
}
