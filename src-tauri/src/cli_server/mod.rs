//! Localhost IPC HTTP/1.1 server for the Aizuchi CLI (AIZ-20, phase 1
//! of AIZ-13).
//!
//! Binds to `127.0.0.1:0` (OS-assigned ephemeral port). Authenticates
//! every endpoint except `GET /v1/app/status` via a 256-bit bearer
//! token persisted at `~/.aizuchi/cli-token`. The bound port is
//! published to `~/.aizuchi/cli.port` (and `cli.json`) so the CLI
//! can find us without a registry.
//!
//! The wire format (codes, paths, JSON shapes) is FROZEN by the v1
//! contract — downstream tickets (AIZ-21/22/23) consume it as-is. See
//! `error.rs` for the canonical code list.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use tauri::AppHandle;
use tokio::net::TcpListener;
use tokio::sync::Notify;

pub mod auth;
pub mod discovery;
pub mod error;
pub mod handlers;
pub mod routes;

/// IPC protocol version. Returned by `GET /v1/app/status`. Bump only
/// when the wire format changes in a backward-incompatible way.
pub const IPC_PROTOCOL_VERSION: u32 = 1;

/// Per-request context. Cheap to clone (everything is owned strings or
/// an `AppHandle`).
pub struct IpcCtx {
    pub app: AppHandle,
    pub notes_dir: PathBuf,
    pub token: String,
    pub started_at_ms: i64,
    pub app_version: String,
    pub app_name: String,
}

/// Held by the `App`'s state. Triggers graceful shutdown on drop or
/// when `notify_waiters()` is called.
pub struct IpcServerHandle {
    pub shutdown: Arc<Notify>,
    /// Public for diagnostic access via `app.state::<IpcServerHandle>()`.
    /// Currently unread internally.
    #[allow(dead_code)]
    pub bound_port: u16,
}

/// Spawn the IPC server. Returns the handle once the listener is bound
/// and the discovery files are written. The actual accept loop runs on
/// a Tauri async-runtime task.
pub async fn start_ipc_server(app: AppHandle) -> Result<IpcServerHandle, String> {
    let notes_dir = crate::notes_dir();
    std::fs::create_dir_all(&notes_dir).map_err(|e| format!("create notes dir: {e}"))?;

    let token = auth::load_or_generate(&notes_dir)?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 127.0.0.1: {e}"))?;
    let bound_port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();

    let started_at_ms = Utc::now().timestamp_millis();

    discovery::write_discovery_files(&notes_dir, bound_port, IPC_PROTOCOL_VERSION, started_at_ms)?;

    let app_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());
    let app_name = app.config().product_name.clone().unwrap_or_else(|| {
        app.config()
            .identifier
            .clone()
    });

    let ctx = Arc::new(IpcCtx {
        app: app.clone(),
        notes_dir: notes_dir.clone(),
        token,
        started_at_ms,
        app_version,
        app_name,
    });

    let shutdown = Arc::new(Notify::new());
    let accept_shutdown = shutdown.clone();
    let cleanup_dir = notes_dir.clone();

    crate::log(&format!(
        "[ipc] HTTP server listening on 127.0.0.1:{bound_port} (token in {})",
        notes_dir.join(auth::TOKEN_FILENAME).display()
    ));

    tauri::async_runtime::spawn(async move {
        accept_loop(listener, ctx, accept_shutdown).await;
        // Cleanup runs once the accept loop exits — either via the
        // ExitRequested hook or because the listener died.
        discovery::remove_discovery_files(&cleanup_dir);
        crate::log("[ipc] HTTP server stopped, discovery files cleared");
    });

    Ok(IpcServerHandle {
        shutdown,
        bound_port,
    })
}

async fn accept_loop(listener: TcpListener, ctx: Arc<IpcCtx>, shutdown: Arc<Notify>) {
    let graceful = GracefulShutdown::new();
    let connection_shutdown = shutdown.clone();

    loop {
        tokio::select! {
            res = listener.accept() => {
                match res {
                    Ok((stream, _peer)) => {
                        let io = TokioIo::new(stream);
                        let ctx = ctx.clone();
                        let svc = service_fn(move |req| {
                            let ctx = ctx.clone();
                            async move { routes::dispatch(ctx, req).await }
                        });

                        let conn = http1::Builder::new()
                            .timer(TokioTimer::new())
                            .serve_connection(io, svc);
                        let conn = graceful.watch(conn);

                        tokio::spawn(async move {
                            if let Err(e) = conn.await {
                                // Connection-level errors are usually just
                                // the client closing early — log at info.
                                crate::log(&format!("[ipc] connection: {e}"));
                            }
                        });
                    }
                    Err(e) => {
                        crate::log(&format!("[ipc] accept error: {e}"));
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
            _ = connection_shutdown.notified() => {
                crate::log("[ipc] shutdown notified, draining in-flight requests");
                break;
            }
        }
    }

    // Give in-flight requests up to 2s to finish, then drop.
    tokio::select! {
        _ = graceful.shutdown() => {}
        _ = tokio::time::sleep(Duration::from_secs(2)) => {
            crate::log("[ipc] graceful shutdown timeout (2s), dropping connections");
        }
    }
}
