//! CLI token generation, persistence, and constant-time comparison.
//!
//! The token is 32 random bytes hex-encoded (64 chars), persisted to
//! `~/.aizuchi/cli-token` with mode 0600. It survives across launches
//! so already-authorised CLIs don't have to re-fetch on every restart.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use subtle::ConstantTimeEq;

/// Filename used inside `~/.aizuchi/`.
pub const TOKEN_FILENAME: &str = "cli-token";

/// Length of the random token, in bytes (hex-encoded length is 2x this).
pub const TOKEN_BYTES: usize = 32;

/// The full hex-encoded token length.
pub const TOKEN_HEX_LEN: usize = TOKEN_BYTES * 2;

/// Load an existing token, or generate + persist a fresh one.
///
/// On success returns the hex-encoded 64-char token. The file is created
/// (or repaired) with mode 0600. On Unix, if the existing file has wrong
/// permissions the function logs a warning and `chmod 0600` rather than
/// refusing — `cp -r` of `~/.aizuchi/` shouldn't brick the app.
pub fn load_or_generate(base: &Path) -> Result<String, String> {
    fs::create_dir_all(base).map_err(|e| format!("create token dir: {e}"))?;
    let path = token_path(base);

    if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("read token: {e}"))?
            .trim()
            .to_string();

        // Sanity check: token must be 64 hex chars. If not, regenerate.
        if raw.len() == TOKEN_HEX_LEN && raw.chars().all(|c| c.is_ascii_hexdigit()) {
            #[cfg(unix)]
            ensure_mode_0600(&path);
            return Ok(raw);
        }

        crate::log(&format!(
            "[ipc] cli-token at {path:?} is malformed (len={}); regenerating",
            raw.len()
        ));
    }

    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom: {e}"))?;
    let token = hex::encode(bytes);
    write_token(&path, &token)?;
    Ok(token)
}

/// Constant-time compare a user-supplied token against the canonical one.
pub fn token_matches(canonical: &str, supplied: &str) -> bool {
    // ConstantTimeEq requires equal-length slices. We mask the length
    // mismatch by comparing against an all-zero buffer of the canonical
    // length; the bool result is OR'd with a length check.
    let same_len = canonical.len() == supplied.len();
    if !same_len {
        // Run a dummy compare so the timing on length-mismatch is similar
        // to a real-but-wrong token compare. This is mostly belt-and-braces;
        // the real defence is HMAC-style, but for a 256-bit random secret
        // a CT compare is enough.
        let _ = canonical.as_bytes().ct_eq(canonical.as_bytes());
        return false;
    }
    canonical.as_bytes().ct_eq(supplied.as_bytes()).into()
}

fn token_path(base: &Path) -> PathBuf {
    base.join(TOKEN_FILENAME)
}

fn write_token(path: &Path, token: &str) -> Result<(), String> {
    // Atomic write: tmp file + rename. Then chmod 0600.
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp token: {e}"))?;
        f.write_all(token.as_bytes())
            .and_then(|_| f.write_all(b"\n"))
            .map_err(|e| format!("write tmp token: {e}"))?;
        f.sync_all().map_err(|e| format!("sync tmp token: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename tmp token: {e}"))?;
    #[cfg(unix)]
    ensure_mode_0600(path);
    Ok(())
}

#[cfg(unix)]
fn ensure_mode_0600(path: &Path) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            crate::log(&format!("[ipc] stat {path:?}: {e}"));
            return;
        }
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode == 0o600 {
        return;
    }
    crate::log(&format!(
        "[ipc] cli-token at {path:?} had mode {mode:o}; chmod 0600"
    ));
    let mut perms = meta.permissions();
    perms.set_mode(0o600);
    if let Err(e) = fs::set_permissions(path, perms) {
        crate::log(&format!("[ipc] failed to chmod 0600 on {path:?}: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!("aizuchi-ipc-auth-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn generates_64_hex_token() {
        let base = fresh_base("gen");
        let token = load_or_generate(&base).unwrap();
        assert_eq!(token.len(), TOKEN_HEX_LEN);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_persists_across_calls() {
        let base = fresh_base("persist");
        let a = load_or_generate(&base).unwrap();
        let b = load_or_generate(&base).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn malformed_token_regenerates() {
        let base = fresh_base("malformed");
        fs::write(token_path(&base), "not-a-real-token\n").unwrap();
        let token = load_or_generate(&base).unwrap();
        assert_eq!(token.len(), TOKEN_HEX_LEN);
        assert_ne!(token, "not-a-real-token");
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_0600() {
        let base = fresh_base("perms");
        load_or_generate(&base).unwrap();
        let mode = fs::metadata(token_path(&base))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn wrong_perms_get_repaired() {
        let base = fresh_base("repair");
        let token = load_or_generate(&base).unwrap();
        // Loosen the perms — simulating a `cp -r` from a less strict dir.
        let mut perms = fs::metadata(token_path(&base)).unwrap().permissions();
        perms.set_mode(0o644);
        fs::set_permissions(token_path(&base), perms).unwrap();
        // Reload — should keep the same token but fix the perms.
        let again = load_or_generate(&base).unwrap();
        assert_eq!(token, again);
        let mode = fs::metadata(token_path(&base))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn token_matches_constant_time() {
        let canonical = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(token_matches(canonical, canonical));
        assert!(!token_matches(canonical, "wrong"));
        assert!(!token_matches(canonical, ""));
        assert!(!token_matches(
            canonical,
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
        ));
    }
}
