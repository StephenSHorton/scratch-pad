//! Atomic write of `cli.port` and `cli.json` discovery files in
//! `~/.scratch-pad/`. Both are mode 0600. Removed by the lifecycle
//! hook on graceful shutdown — see `lib.rs`'s `RunEvent::ExitRequested`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::Serialize;

pub const PORT_FILENAME: &str = "cli.port";
pub const META_FILENAME: &str = "cli.json";

#[derive(Serialize)]
struct CliMeta {
    port: u16,
    version: u32,
    pid: u32,
    #[serde(rename = "startedAt")]
    started_at: i64,
}

/// Write both discovery files atomically. Caller passes the bound port,
/// the IPC protocol version, and the start timestamp (epoch ms).
pub fn write_discovery_files(
    base: &Path,
    port: u16,
    version: u32,
    started_at_ms: i64,
) -> Result<(), String> {
    fs::create_dir_all(base).map_err(|e| format!("create discovery dir: {e}"))?;

    write_atomic(&base.join(PORT_FILENAME), format!("{port}\n").as_bytes())?;

    let meta = CliMeta {
        port,
        version,
        pid: std::process::id(),
        started_at: started_at_ms,
    };
    let json = serde_json::to_vec_pretty(&meta).map_err(|e| format!("serialise cli.json: {e}"))?;
    write_atomic(&base.join(META_FILENAME), &json)?;

    Ok(())
}

/// Best-effort cleanup. Logs but doesn't propagate errors — discovery
/// files are advisory; a stale one will just confuse the next CLI call
/// until the new app instance overwrites it.
pub fn remove_discovery_files(base: &Path) {
    for name in [PORT_FILENAME, META_FILENAME] {
        let path = base.join(name);
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                crate::log(&format!("[ipc] remove {path:?}: {e}"));
            }
        }
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create {tmp:?}: {e}"))?;
        f.write_all(data)
            .map_err(|e| format!("write {tmp:?}: {e}"))?;
        f.sync_all().map_err(|e| format!("sync {tmp:?}: {e}"))?;
    }
    // chmod the tmp file before rename so the destination never has lax perms.
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&tmp)
            .map_err(|e| format!("stat {tmp:?}: {e}"))?
            .permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms).map_err(|e| format!("chmod {tmp:?}: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename {tmp:?}: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub fn discovery_paths(base: &Path) -> (PathBuf, PathBuf) {
    (base.join(PORT_FILENAME), base.join(META_FILENAME))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!(
            "aizuchi-ipc-discovery-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn write_then_remove_round_trip() {
        let base = fresh_base("round-trip");
        write_discovery_files(&base, 1234, 1, 1_700_000_000_000).unwrap();
        let port = fs::read_to_string(base.join(PORT_FILENAME)).unwrap();
        assert_eq!(port.trim(), "1234");

        let meta_raw = fs::read_to_string(base.join(META_FILENAME)).unwrap();
        let meta: serde_json::Value = serde_json::from_str(&meta_raw).unwrap();
        assert_eq!(meta["port"], 1234);
        assert_eq!(meta["version"], 1);
        assert_eq!(meta["startedAt"], 1_700_000_000_000_i64);
        assert!(meta["pid"].as_u64().is_some());

        remove_discovery_files(&base);
        assert!(!base.join(PORT_FILENAME).exists());
        assert!(!base.join(META_FILENAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn discovery_files_are_0600() {
        let base = fresh_base("perms");
        write_discovery_files(&base, 4321, 1, 0).unwrap();
        for name in [PORT_FILENAME, META_FILENAME] {
            let mode =
                fs::metadata(base.join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "expected 0o600 on {name}, got {mode:o}");
        }
    }
}
