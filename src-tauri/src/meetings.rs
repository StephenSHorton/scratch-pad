use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::log;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMeta {
    pub id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub mode: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub thought_count: usize,
    pub transcript_duration_ms: i64,
    /// AIZ-16: AI-generated or user-overridden meeting name.
    /// `None` for legacy snapshots written before naming shipped — the
    /// browser falls back to the id in that case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// AIZ-16: True when the user typed the name in the status panel.
    /// Once true, the AI naming loop stops re-proposing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_locked_by_user: Option<bool>,
}

const SUPPORTED_SCHEMA_VERSION: i64 = 1;

fn meetings_dir(base: &Path) -> PathBuf {
    base.join("meetings")
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("Invalid meeting id: {id}"));
    }
    Ok(())
}

pub fn save_snapshot(base: &Path, snapshot: serde_json::Value) -> Result<String, String> {
    let id = snapshot
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Snapshot missing 'id' field".to_string())?
        .to_string();
    validate_id(&id)?;

    let dir = meetings_dir(base);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.json"));
    let json = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    log(&format!("save_meeting: wrote {path:?}"));
    Ok(id)
}

pub fn list_snapshots(base: &Path) -> Result<Vec<MeetingMeta>, String> {
    let dir = meetings_dir(base);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut metas: Vec<MeetingMeta> = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log(&format!("list_meetings: skip entry: {e}"));
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let data = match fs::read_to_string(&path) {
            Ok(d) => d,
            Err(e) => {
                log(&format!("list_meetings: skip {path:?}: {e}"));
                continue;
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(e) => {
                log(&format!("list_meetings: skip {path:?}: parse {e}"));
                continue;
            }
        };
        let id = match value.get("id").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let started_at = value.get("startedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let ended_at = value.get("endedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let mode = value
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("live")
            .to_string();
        let node_count = value
            .get("graph")
            .and_then(|g| g.get("nodes"))
            .and_then(|n| n.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let edge_count = value
            .get("graph")
            .and_then(|g| g.get("edges"))
            .and_then(|n| n.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let thought_count = value
            .get("thoughts")
            .and_then(|n| n.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let transcript_duration_ms = value
            .get("transcript")
            .and_then(|n| n.as_array())
            .and_then(|arr| {
                let first = arr
                    .first()
                    .and_then(|c| c.get("startMs"))
                    .and_then(|v| v.as_i64())?;
                let last = arr
                    .last()
                    .and_then(|c| c.get("endMs"))
                    .and_then(|v| v.as_i64())?;
                Some(last - first)
            })
            .unwrap_or(0);
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let name_locked_by_user = value.get("nameLockedByUser").and_then(|v| v.as_bool());
        metas.push(MeetingMeta {
            id,
            started_at,
            ended_at,
            mode,
            node_count,
            edge_count,
            thought_count,
            transcript_duration_ms,
            name,
            name_locked_by_user,
        });
    }
    // Newest first — by endedAt, falling back to startedAt.
    metas.sort_by(|a, b| {
        let a_key = if a.ended_at != 0 { a.ended_at } else { a.started_at };
        let b_key = if b.ended_at != 0 { b.ended_at } else { b.started_at };
        b_key.cmp(&a_key)
    });
    Ok(metas)
}

pub fn load_snapshot(base: &Path, id: &str) -> Result<serde_json::Value, String> {
    validate_id(id)?;
    let path = meetings_dir(base).join(format!("{id}.json"));
    if !path.exists() {
        return Err(format!("Meeting not found: {id}"));
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let version = value.get("schemaVersion").and_then(|v| v.as_i64());
    if version != Some(SUPPORTED_SCHEMA_VERSION) {
        return Err(format!(
            "Unsupported meeting schemaVersion: {version:?} (expected {SUPPORTED_SCHEMA_VERSION})"
        ));
    }
    Ok(value)
}

pub fn delete_snapshot(base: &Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let path = meetings_dir(base).join(format!("{id}.json"));
    if !path.exists() {
        return Err(format!("Meeting not found: {id}"));
    }
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    log(&format!("delete_meeting: removed {path:?}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_base(name: &str) -> PathBuf {
        let mut base = env::temp_dir();
        base.push(format!("aizuchi-meetings-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn sample(id: &str, mode: &str, started_at: i64, ended_at: i64) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "schemaVersion": 1,
            "startedAt": started_at,
            "endedAt": ended_at,
            "mode": mode,
            "graph": { "nodes": [{"id": "a", "label": "A", "type": "topic"}], "edges": [] },
            "thoughts": [{"id": "t1", "text": "x", "intent": "fyi"}],
            "transcript": [
                {"speaker": "a", "text": "hi", "startMs": 0, "endMs": 1000},
                {"speaker": "b", "text": "yo", "startMs": 1000, "endMs": 2500},
            ],
            "passes": [],
            "stats": {
                "totalBatches": 1,
                "totalLatencyMs": 0,
                "totalInputTokens": 0,
                "totalOutputTokens": 0,
                "providerLabel": "test",
            }
        })
    }

    #[test]
    fn round_trip_snapshot() {
        let base = fresh_base("round-trip");
        let snap = sample("meeting-abc", "live", 1000, 2000);
        let id = save_snapshot(&base, snap.clone()).unwrap();
        assert_eq!(id, "meeting-abc");
        let loaded = load_snapshot(&base, "meeting-abc").unwrap();
        assert_eq!(loaded["id"], "meeting-abc");
        assert_eq!(loaded["mode"], "live");
        assert_eq!(loaded["graph"]["nodes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn list_sorts_newest_first() {
        let base = fresh_base("sort");
        save_snapshot(&base, sample("m-old", "demo", 100, 200)).unwrap();
        save_snapshot(&base, sample("m-mid", "live", 300, 400)).unwrap();
        save_snapshot(&base, sample("m-new", "live", 500, 600)).unwrap();
        let metas = list_snapshots(&base).unwrap();
        let ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m-new", "m-mid", "m-old"]);
        assert_eq!(metas[0].node_count, 1);
        assert_eq!(metas[0].thought_count, 1);
        assert_eq!(metas[0].transcript_duration_ms, 2500);
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let base = fresh_base("schema");
        let mut snap = sample("meeting-future", "live", 1, 2);
        snap["schemaVersion"] = serde_json::json!(99);
        save_snapshot(&base, snap).unwrap();
        let err = load_snapshot(&base, "meeting-future").unwrap_err();
        assert!(err.contains("schemaVersion"), "got: {err}");
    }

    #[test]
    fn rejects_path_traversal() {
        let base = fresh_base("traversal");
        assert!(load_snapshot(&base, "../etc/passwd").is_err());
        assert!(load_snapshot(&base, "a/b").is_err());
        let bad = serde_json::json!({"id": "../bad", "schemaVersion": 1});
        assert!(save_snapshot(&base, bad).is_err());
    }

    #[test]
    fn list_empty_when_dir_missing() {
        let base = fresh_base("missing");
        // Don't write anything; meetings dir won't exist yet.
        let metas = list_snapshots(&base).unwrap();
        assert!(metas.is_empty());
    }

    #[test]
    fn delete_meeting_removes_file() {
        let base = fresh_base("delete");
        save_snapshot(&base, sample("m-keep", "live", 100, 200)).unwrap();
        save_snapshot(&base, sample("m-doomed", "live", 300, 400)).unwrap();
        assert_eq!(list_snapshots(&base).unwrap().len(), 2);

        delete_snapshot(&base, "m-doomed").unwrap();

        let metas = list_snapshots(&base).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, "m-keep");

        // Loading the deleted id should now fail.
        assert!(load_snapshot(&base, "m-doomed").is_err());
    }

    #[test]
    fn delete_meeting_rejects_path_traversal() {
        let base = fresh_base("delete-traversal");
        assert!(delete_snapshot(&base, "../etc/passwd").is_err());
        assert!(delete_snapshot(&base, "a/b").is_err());
        assert!(delete_snapshot(&base, "a\\b").is_err());
        assert!(delete_snapshot(&base, "").is_err());
    }

    #[test]
    fn delete_meeting_errors_when_missing() {
        let base = fresh_base("delete-missing");
        let err = delete_snapshot(&base, "nope").unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn legacy_snapshot_without_name_loads() {
        // AIZ-11 / AIZ-19 era snapshots have no `name` or `nameLockedByUser`.
        // They must still load and list cleanly (name surfaced as None).
        let base = fresh_base("legacy-name");
        let snap = sample("meeting-legacy", "live", 100, 200);
        save_snapshot(&base, snap).unwrap();
        let loaded = load_snapshot(&base, "meeting-legacy").unwrap();
        assert_eq!(loaded["id"], "meeting-legacy");
        assert!(loaded.get("name").is_none());
        let metas = list_snapshots(&base).unwrap();
        assert_eq!(metas.len(), 1);
        assert!(metas[0].name.is_none());
        assert!(metas[0].name_locked_by_user.is_none());
    }

    #[test]
    fn snapshot_with_name_surfaces_in_meta() {
        let base = fresh_base("named");
        let mut snap = sample("meeting-named", "live", 100, 200);
        snap["name"] = serde_json::json!("Postgres migration sync");
        snap["nameLockedByUser"] = serde_json::json!(true);
        save_snapshot(&base, snap).unwrap();
        let metas = list_snapshots(&base).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].name.as_deref(), Some("Postgres migration sync"));
        assert_eq!(metas[0].name_locked_by_user, Some(true));
    }
}
