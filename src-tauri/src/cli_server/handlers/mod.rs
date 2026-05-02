//! Per-resource handler modules. Each public function returns
//! `Result<Response<Full<Bytes>>, IpcError>` and is dispatched to by
//! `cli_server::routes::dispatch`.

pub mod app;
pub mod meetings;
pub mod pads;
