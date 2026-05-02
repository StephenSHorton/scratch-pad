//! Error envelope, status mapping, and the IpcError enum used by every
//! handler. The `code` strings are frozen as part of the v1 IPC contract —
//! downstream CLIs and the MCP server (AIZ-21/22/23) switch on them.

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::CONTENT_TYPE;
use hyper::{Response, StatusCode};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub enum IpcError {
    /// Request had no `Authorization` header.
    AuthRequired,
    /// Header present but token didn't match.
    AuthInvalid,
    /// Unknown id (note/meeting), or a route that doesn't exist.
    NotFound,
    /// Malformed body, missing required field, type mismatch, etc.
    ValidationError(String),
    /// Path-traversal attempt, empty id, or otherwise unsafe id.
    IdInvalid(String),
    /// Conflicting state — e.g. starting live capture while already running.
    Conflict(String),
    /// Known route, wrong method (e.g. POST on a GET-only path).
    MethodNotAllowed,
    /// Catch-all internal error. The string is included verbatim — keep
    /// it sanitised at the call site.
    Internal(String),
}

impl IpcError {
    pub fn code(&self) -> &'static str {
        match self {
            IpcError::AuthRequired => "auth_required",
            IpcError::AuthInvalid => "auth_invalid",
            IpcError::NotFound => "not_found",
            IpcError::ValidationError(_) => "validation_error",
            IpcError::IdInvalid(_) => "id_invalid",
            IpcError::Conflict(_) => "conflict",
            IpcError::MethodNotAllowed => "method_not_allowed",
            IpcError::Internal(_) => "internal",
        }
    }

    pub fn status(&self) -> StatusCode {
        match self {
            IpcError::AuthRequired => StatusCode::UNAUTHORIZED,
            IpcError::AuthInvalid => StatusCode::FORBIDDEN,
            IpcError::NotFound => StatusCode::NOT_FOUND,
            IpcError::ValidationError(_) => StatusCode::BAD_REQUEST,
            IpcError::IdInvalid(_) => StatusCode::BAD_REQUEST,
            IpcError::Conflict(_) => StatusCode::CONFLICT,
            IpcError::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            IpcError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn message(&self) -> String {
        match self {
            IpcError::AuthRequired => "Missing Authorization header".to_string(),
            IpcError::AuthInvalid => "Invalid token".to_string(),
            IpcError::NotFound => "Not found".to_string(),
            IpcError::ValidationError(m) => m.clone(),
            IpcError::IdInvalid(m) => m.clone(),
            IpcError::Conflict(m) => m.clone(),
            IpcError::MethodNotAllowed => "Method not allowed".to_string(),
            IpcError::Internal(m) => m.clone(),
        }
    }

    pub fn into_response(self) -> Response<Full<Bytes>> {
        let status = self.status();
        let envelope = ErrorEnvelope {
            error: ErrorPayload {
                code: self.code(),
                message: self.message(),
                details: None,
            },
        };
        json_response(status, &envelope)
    }
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorPayload<'a>,
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

/// Build a JSON response with the given status. Used both for happy-path
/// payloads and the error envelope.
pub fn json_response<T: Serialize>(status: StatusCode, body: &T) -> Response<Full<Bytes>> {
    let bytes = match serde_json::to_vec(body) {
        Ok(b) => b,
        Err(e) => {
            // Last-ditch: serialise a hard-coded fallback. Should never
            // happen since all our payloads are simple structs.
            crate::log(&format!("[ipc] failed to serialise response: {e}"));
            br#"{"error":{"code":"internal","message":"failed to serialise response"}}"#.to_vec()
        }
    };
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(bytes)))
        .expect("response builder")
}

/// 204 No Content shortcut, used by DELETE endpoints.
pub fn no_content() -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Full::new(Bytes::new()))
        .expect("response builder")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_status_mapping_is_stable() {
        // These are the v1 frozen contract. Don't break them.
        assert_eq!(IpcError::AuthRequired.code(), "auth_required");
        assert_eq!(IpcError::AuthRequired.status(), StatusCode::UNAUTHORIZED);

        assert_eq!(IpcError::AuthInvalid.code(), "auth_invalid");
        assert_eq!(IpcError::AuthInvalid.status(), StatusCode::FORBIDDEN);

        assert_eq!(IpcError::NotFound.code(), "not_found");
        assert_eq!(IpcError::NotFound.status(), StatusCode::NOT_FOUND);

        assert_eq!(
            IpcError::ValidationError("x".into()).code(),
            "validation_error"
        );
        assert_eq!(
            IpcError::ValidationError("x".into()).status(),
            StatusCode::BAD_REQUEST
        );

        assert_eq!(IpcError::IdInvalid("x".into()).code(), "id_invalid");
        assert_eq!(
            IpcError::IdInvalid("x".into()).status(),
            StatusCode::BAD_REQUEST
        );

        assert_eq!(IpcError::Conflict("x".into()).code(), "conflict");
        assert_eq!(
            IpcError::Conflict("x".into()).status(),
            StatusCode::CONFLICT
        );

        assert_eq!(IpcError::MethodNotAllowed.code(), "method_not_allowed");
        assert_eq!(
            IpcError::MethodNotAllowed.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );

        assert_eq!(IpcError::Internal("x".into()).code(), "internal");
        assert_eq!(
            IpcError::Internal("x".into()).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[tokio::test]
    async fn error_envelope_has_correct_shape() {
        use http_body_util::BodyExt;

        let resp = IpcError::AuthRequired.into_response();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["error"]["code"], "auth_required");
        assert!(parsed["error"]["message"].is_string());
    }
}
