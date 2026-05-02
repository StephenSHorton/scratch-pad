//! `GET /v1/app/status` — unauthenticated probe used by CLIs to detect
//! whether the app is running and which IPC version it speaks.

use std::sync::Arc;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::Serialize;

use crate::cli_server::error::{json_response, IpcError};
use crate::cli_server::IpcCtx;

#[derive(Serialize)]
struct StatusResponse<'a> {
    ok: bool,
    app: AppMeta<'a>,
    ipc: IpcMeta,
}

#[derive(Serialize)]
struct AppMeta<'a> {
    version: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
struct IpcMeta {
    version: u32,
    #[serde(rename = "startedAt")]
    started_at: i64,
}

pub async fn status(ctx: &Arc<IpcCtx>) -> Result<Response<Full<Bytes>>, IpcError> {
    let body = StatusResponse {
        ok: true,
        app: AppMeta {
            version: ctx.app_version.as_str(),
            name: ctx.app_name.as_str(),
        },
        ipc: IpcMeta {
            version: super::super::IPC_PROTOCOL_VERSION,
            started_at: ctx.started_at_ms,
        },
    };
    Ok(json_response(StatusCode::OK, &body))
}
