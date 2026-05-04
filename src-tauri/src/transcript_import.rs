//! Transcript-import parsing + transient staging state (AIZ-30).
//!
//! Two accepted formats:
//!
//! - **Plain text** (`.txt`, `.md`) — chunks separated by blank lines.
//!   Optional `Speaker: ` prefix at the start of a chunk attributes it.
//!   Everything before the first `:` on the first line is the speaker.
//!   No prefix → `unknown`.
//!
//! - **JSON** (`.json`) — `[{ text, speaker?, t? }]`. `t` is seconds-from-start
//!   (float). Missing fields default to `unknown` / synthesized timestamps.
//!
//! All formats normalize to `Vec<ImportedChunk>` with monotonic
//! `startMs` / `endMs` so the existing batch / extraction loop on the
//! React side can consume them unchanged. Timestamp synthesis allocates
//! `max(1000ms, word_count * 400ms)` per chunk — enough simulated time
//! that the 25s time-based batch threshold fires naturally.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const UNKNOWN_SPEAKER: &str = "unknown";
const MIN_CHUNK_DURATION_MS: i64 = 1_000;
const MS_PER_WORD: i64 = 400;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedChunk {
    pub speaker: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Transcript chunks + originating filename, staged by `POST /v1/meetings/import`
/// awaiting pickup by the freshly-opened meeting window. Cleared on first read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingImport {
    pub chunks: Vec<ImportedChunk>,
    pub source_file: String,
}

/// Tauri-managed state. Both the IPC import handler (which writes) and the
/// `take_pending_import` Tauri command (which the meeting window calls on
/// mount) access this.
#[derive(Default)]
pub struct PendingImportsState {
    pub map: Mutex<HashMap<String, PendingImport>>,
}

/// Returned by `stage_pending_import` — what the IPC import endpoint and
/// the path-based Tauri command both surface to the caller.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImport {
    pub id: String,
    pub chunk_count: usize,
    pub source_file: String,
}

/// Parse `content`, stage it under a fresh meeting id, and open the
/// meeting window with `?autostart=import`. Shared by the IPC import
/// endpoint (CLI / external clients post content+filename) and the
/// `import_meeting_from_path` Tauri command (palette picks a path,
/// Rust reads the file).
pub fn stage_pending_import(
    app: &tauri::AppHandle,
    content: &str,
    filename: &str,
) -> Result<StagedImport, String> {
    use tauri::Manager;

    if content.trim().is_empty() {
        return Err("content is empty".into());
    }
    if filename.trim().is_empty() {
        return Err("filename is empty".into());
    }
    let basename = std::path::Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| filename.to_string());

    let chunks = parse(content, &basename)?;
    let chunk_count = chunks.len();

    let id = format!("meeting-{}", uuid::Uuid::new_v4());
    crate::log(&format!(
        "[import] stage_pending_import: parsed {chunk_count} chunks from {basename}, id={id}"
    ));
    {
        let state = app.state::<PendingImportsState>();
        let mut map = state
            .map
            .lock()
            .map_err(|e| format!("lock pending_imports: {e}"))?;
        map.insert(
            id.clone(),
            PendingImport {
                chunks,
                source_file: basename.clone(),
            },
        );
    }

    crate::open_meeting_window_with_query(app, Some(&id), Some("autostart=import"));

    Ok(StagedImport {
        id,
        chunk_count,
        source_file: basename,
    })
}

/// Parse a transcript file's content into normalized chunks. Dispatches
/// on filename extension. Filenames without an extension are treated as
/// plain text.
pub fn parse(content: &str, filename: &str) -> Result<Vec<ImportedChunk>, String> {
    let ext = filename
        .rsplit('.')
        .next()
        .filter(|s| *s != filename)
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "json" => parse_json(content),
        "txt" | "md" | "" => parse_text(content),
        other => Err(format!(
            "Unsupported file extension: .{other}. Use .txt, .md, or .json"
        )),
    }
}

/// Parse the plain-text / markdown shape. Public for tests.
///
/// Recognises an optional `[H:MM:SS]` (or `[MM:SS]`) timestamp prefix at
/// the start of a chunk — common in exports from Otter, Granola, Whisper,
/// etc. — and uses it to seed the chunk's `start_ms`. The speaker prefix
/// (if any) follows immediately after.
pub fn parse_text(content: &str) -> Result<Vec<ImportedChunk>, String> {
    let mut chunks: Vec<(Option<f64>, String, String)> = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();

    let push =
        |buf: &mut Vec<&str>, out: &mut Vec<(Option<f64>, String, String)>| {
            if buf.is_empty() {
                return;
            }
            let joined = buf.join("\n");
            let trimmed = joined.trim();
            if !trimmed.is_empty() {
                let (t_seconds, after_bracket) = extract_timestamp_prefix(trimmed);
                let (speaker, text) = split_speaker(&after_bracket);
                out.push((t_seconds, speaker, text));
            }
            buf.clear();
        };

    for line in content.lines() {
        if line.trim().is_empty() {
            push(&mut current_lines, &mut chunks);
        } else {
            current_lines.push(line);
        }
    }
    push(&mut current_lines, &mut chunks);

    if chunks.is_empty() {
        return Err("Transcript is empty".into());
    }

    Ok(synthesize_timestamps(
        chunks
            .into_iter()
            .map(|(t_seconds, speaker, text)| RawChunk {
                speaker,
                text,
                t_seconds,
            })
            .collect(),
    ))
}

/// Strip a leading `[H:MM:SS]` (or `[MM:SS]` / `[SS]`) timestamp marker
/// and return the parsed seconds plus the remaining chunk text. If the
/// bracket isn't a parseable timestamp (e.g. `[crosstalk]`), the original
/// text is returned untouched.
fn extract_timestamp_prefix(chunk_text: &str) -> (Option<f64>, String) {
    let trimmed = chunk_text.trim_start();
    if !trimmed.starts_with('[') {
        return (None, chunk_text.to_string());
    }
    let close = match trimmed.find(']') {
        Some(i) => i,
        None => return (None, chunk_text.to_string()),
    };
    let inside = &trimmed[1..close];
    let after = trimmed[close + 1..].trim_start();
    match parse_hms(inside) {
        Some(t) => (Some(t), after.to_string()),
        None => (None, chunk_text.to_string()),
    }
}

/// Parse `H:MM:SS`, `MM:SS`, or bare `SS` (with optional fractional part)
/// into seconds. Rejects malformed inputs by returning `None`.
fn parse_hms(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let nums: Vec<f64> = parts.iter().map(|p| p.parse::<f64>().ok()).collect::<Option<_>>()?;
    if nums.iter().any(|n| *n < 0.0) {
        return None;
    }
    match nums.as_slice() {
        [s] => Some(*s),
        [m, s] => Some(m * 60.0 + s),
        [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
        _ => None,
    }
}

/// Parse the JSON array shape. Public for tests.
pub fn parse_json(content: &str) -> Result<Vec<ImportedChunk>, String> {
    let raw: Vec<JsonChunkInput> = serde_json::from_str(content)
        .map_err(|e| format!("Invalid transcript JSON: {e}"))?;
    if raw.is_empty() {
        return Err("Transcript is empty".into());
    }
    let normalized: Vec<RawChunk> = raw
        .into_iter()
        .enumerate()
        .map(|(idx, c)| {
            let text = c.text.trim().to_string();
            if text.is_empty() {
                return Err(format!("Chunk {idx}: text is empty"));
            }
            Ok(RawChunk {
                speaker: c
                    .speaker
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| UNKNOWN_SPEAKER.into()),
                text,
                t_seconds: c.t,
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(synthesize_timestamps(normalized))
}

#[derive(Debug, Deserialize)]
struct JsonChunkInput {
    text: String,
    speaker: Option<String>,
    t: Option<f64>,
}

struct RawChunk {
    speaker: String,
    text: String,
    t_seconds: Option<f64>,
}

fn split_speaker(chunk_text: &str) -> (String, String) {
    let (first_line, rest) = match chunk_text.split_once('\n') {
        Some((a, b)) => (a, Some(b)),
        None => (chunk_text, None),
    };
    if let Some((maybe_speaker, after)) = first_line.split_once(':') {
        let speaker = maybe_speaker.trim();
        // Reject prefixes that don't look like a name (contain whitespace
        // characters that suggest it's actually mid-sentence punctuation).
        // A name token is short and alphanumeric-ish; a sentence like
        // "I think: foo" should NOT be parsed as speaker "I think".
        if is_speaker_label(speaker) {
            let mut text = after.trim().to_string();
            if let Some(extra) = rest {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(extra.trim_end());
            }
            return (speaker.to_string(), text);
        }
    }
    (UNKNOWN_SPEAKER.into(), chunk_text.to_string())
}

fn is_speaker_label(s: &str) -> bool {
    if s.is_empty() || s.len() > 40 {
        return false;
    }
    // Reject anything containing digits — names don't, but in-sentence
    // time references like "Yeah. At 10:00, ..." would otherwise be
    // matched as the speaker `"Yeah. At 10"`.
    if s.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    let words: Vec<&str> = s.split_whitespace().collect();
    // 1-3 words. Common shapes: "Stephen", "Stephen Horton", "Mary Beth Smith",
    // "Dr. Smith". Longer phrases are almost always sentences.
    if words.is_empty() || words.len() > 3 {
        return false;
    }
    // Every word must start with an uppercase letter and contain at
    // least one alphabetic character. This rejects sentence prefixes
    // like "I think we should" (the second word is lowercase).
    words.iter().all(|w| {
        let first_upper = w
            .chars()
            .next()
            .map(|c| c.is_uppercase())
            .unwrap_or(false);
        let has_alpha = w.chars().any(|c| c.is_alphabetic());
        first_upper && has_alpha
    })
}

fn synthesize_timestamps(raw: Vec<RawChunk>) -> Vec<ImportedChunk> {
    let mut out: Vec<ImportedChunk> = Vec::with_capacity(raw.len());
    let mut cursor: i64 = 0;
    for chunk in raw {
        let provided_start_ms = chunk
            .t_seconds
            .map(|t| (t * 1000.0).round() as i64)
            .filter(|ms| *ms >= 0);
        // Provided timestamps must be monotonically non-decreasing; if a
        // value would go backwards, ignore it and continue from the cursor.
        let start_ms = match provided_start_ms {
            Some(t) if t >= cursor => t,
            _ => cursor,
        };
        let duration = duration_for(&chunk.text);
        let end_ms = start_ms + duration;
        out.push(ImportedChunk {
            speaker: chunk.speaker,
            text: chunk.text,
            start_ms,
            end_ms,
        });
        cursor = end_ms;
    }
    out
}

fn duration_for(text: &str) -> i64 {
    let words = text.split_whitespace().count() as i64;
    (words * MS_PER_WORD).max(MIN_CHUNK_DURATION_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_labeled_speakers() {
        let input = "Travis: I think we should ship the import feature this week.\n\nPriya: Agreed.\n\nTravis: Cool.";
        let out = parse_text(input).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].speaker, "Travis");
        assert_eq!(out[0].text, "I think we should ship the import feature this week.");
        assert_eq!(out[1].speaker, "Priya");
        assert_eq!(out[2].speaker, "Travis");
    }

    #[test]
    fn text_unlabeled_defaults_to_unknown() {
        let input = "I think we should ship.\n\nAgreed.";
        let out = parse_text(input).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].speaker, "unknown");
        assert_eq!(out[0].text, "I think we should ship.");
        assert_eq!(out[1].speaker, "unknown");
    }

    #[test]
    fn text_mixed_labeled_and_unlabeled() {
        let input = "Travis: First thought.\n\nA stray paragraph.\n\nPriya: Reply.";
        let out = parse_text(input).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].speaker, "Travis");
        assert_eq!(out[1].speaker, "unknown");
        assert_eq!(out[1].text, "A stray paragraph.");
        assert_eq!(out[2].speaker, "Priya");
    }

    #[test]
    fn text_synthesizes_monotonic_timestamps() {
        let input = "A: hello world.\n\nB: hi there friend.";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].start_ms, 0);
        assert!(out[0].end_ms > 0);
        assert_eq!(out[1].start_ms, out[0].end_ms);
        assert!(out[1].end_ms > out[1].start_ms);
    }

    #[test]
    fn text_multiline_chunk_keeps_all_lines() {
        let input = "Travis: First line.\nSecond line of the same chunk.\n\nPriya: Reply.";
        let out = parse_text(input).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].speaker, "Travis");
        assert!(out[0].text.contains("First line."));
        assert!(out[0].text.contains("Second line"));
    }

    #[test]
    fn text_does_not_treat_sentence_with_colon_as_speaker() {
        // "I think we should ship: it's ready" — "I think we should ship"
        // is too long / has too many spaces to be a real speaker label.
        let input = "I think we should ship: it's ready.";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].speaker, "unknown");
        assert!(out[0].text.contains("I think"));
    }

    #[test]
    fn text_empty_input_errors() {
        let err = parse_text("\n\n\n").unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[test]
    fn json_full_shape() {
        let input = r#"[
            { "text": "Hello.", "speaker": "Travis", "t": 0.0 },
            { "text": "Hi.", "speaker": "Priya", "t": 4.2 }
        ]"#;
        let out = parse_json(input).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].speaker, "Travis");
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[1].speaker, "Priya");
        assert_eq!(out[1].start_ms, 4200);
    }

    #[test]
    fn json_missing_speaker_defaults_to_unknown() {
        let input = r#"[{ "text": "Solo monologue." }]"#;
        let out = parse_json(input).unwrap();
        assert_eq!(out[0].speaker, "unknown");
    }

    #[test]
    fn json_missing_t_synthesizes_timestamps() {
        let input = r#"[
            { "text": "First chunk." },
            { "text": "Second chunk." }
        ]"#;
        let out = parse_json(input).unwrap();
        assert_eq!(out[0].start_ms, 0);
        assert_eq!(out[1].start_ms, out[0].end_ms);
    }

    #[test]
    fn json_partial_t_keeps_provided_and_synthesizes_rest() {
        let input = r#"[
            { "text": "First.", "t": 1.0 },
            { "text": "Second." },
            { "text": "Third.", "t": 100.0 }
        ]"#;
        let out = parse_json(input).unwrap();
        assert_eq!(out[0].start_ms, 1000);
        assert_eq!(out[1].start_ms, out[0].end_ms);
        assert_eq!(out[2].start_ms, 100_000);
    }

    #[test]
    fn json_non_monotonic_t_falls_back_to_cursor() {
        let input = r#"[
            { "text": "First.", "t": 10.0 },
            { "text": "Backwards.", "t": 5.0 }
        ]"#;
        let out = parse_json(input).unwrap();
        assert_eq!(out[0].start_ms, 10_000);
        // Backwards `t` is ignored; second chunk picks up where first ended.
        assert!(out[1].start_ms >= out[0].end_ms);
    }

    #[test]
    fn json_empty_array_errors() {
        let err = parse_json("[]").unwrap_err();
        assert!(err.to_lowercase().contains("empty"));
    }

    #[test]
    fn json_empty_text_errors() {
        let input = r#"[{ "text": "" }]"#;
        let err = parse_json(input).unwrap_err();
        assert!(err.to_lowercase().contains("text"));
    }

    #[test]
    fn json_malformed_errors() {
        let err = parse_json("not json").unwrap_err();
        assert!(err.to_lowercase().contains("json"));
    }

    #[test]
    fn parse_dispatches_by_extension() {
        let txt = parse("Speaker: hello.", "fixture.txt").unwrap();
        assert_eq!(txt[0].speaker, "Speaker");

        let json = parse(r#"[{"text":"hi"}]"#, "fixture.json").unwrap();
        assert_eq!(json[0].speaker, "unknown");

        let md = parse("# heading\n\nbody text.", "fixture.md").unwrap();
        assert!(!md.is_empty());

        let unsupported = parse("hi", "fixture.csv").unwrap_err();
        assert!(unsupported.contains("Unsupported"));
    }

    #[test]
    fn parse_treats_missing_extension_as_text() {
        let out = parse("Speaker: hi.", "MeetingNotes").unwrap();
        assert_eq!(out[0].speaker, "Speaker");
    }

    #[test]
    fn text_with_bracket_timestamp_extracts_speaker_and_t() {
        let input = "[0:00:11] Stephen Horton: Uh,\n\n[0:00:14] Stephen Horton: hello.\n\n[0:00:51] Adrian Beria: Oh, interesting.";
        let out = parse_text(input).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].speaker, "Stephen Horton");
        assert_eq!(out[0].text, "Uh,");
        assert_eq!(out[0].start_ms, 11_000);
        assert_eq!(out[1].speaker, "Stephen Horton");
        // Provided timestamps are honored (not overwritten by the synthesized cursor).
        assert_eq!(out[1].start_ms, 14_000);
        assert_eq!(out[2].speaker, "Adrian Beria");
        assert_eq!(out[2].start_ms, 51_000);
    }

    #[test]
    fn text_with_mm_ss_timestamp() {
        let input = "[01:23] Travis: Halfway through.";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].start_ms, 83_000);
        assert_eq!(out[0].speaker, "Travis");
    }

    #[test]
    fn text_with_unparseable_bracket_treats_as_unknown() {
        // `[crosstalk]` isn't a timestamp; the bracket stays in the text and
        // the chunk falls into the unknown-speaker fallback.
        let input = "[crosstalk] something something";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].speaker, "unknown");
        assert!(out[0].text.contains("[crosstalk]"));
    }

    #[test]
    fn text_with_bracket_timestamp_no_speaker() {
        // Bracket timestamp followed by text but no `Speaker:` prefix.
        let input = "[0:00:11] solo monologue chunk.";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].speaker, "unknown");
        assert_eq!(out[0].text, "solo monologue chunk.");
        assert_eq!(out[0].start_ms, 11_000);
    }

    #[test]
    fn parse_hms_accepts_valid_forms() {
        assert_eq!(parse_hms("0:00:11"), Some(11.0));
        assert_eq!(parse_hms("1:02:03"), Some(3723.0));
        assert_eq!(parse_hms("01:02"), Some(62.0));
        assert_eq!(parse_hms("42"), Some(42.0));
        assert_eq!(parse_hms("0:00:11.5"), Some(11.5));
    }

    #[test]
    fn text_does_not_treat_time_reference_as_speaker() {
        // Reproduces a real-world bug: "Yeah. At 10:00, ..." would
        // otherwise be parsed as speaker "Yeah. At 10" and text "00, ...".
        let input = "[0:09:21] Yeah. At 10:00, yeah. I'm-";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].speaker, "unknown");
        assert!(out[0].text.contains("Yeah. At 10:00"));
        assert_eq!(out[0].start_ms, 9 * 60_000 + 21_000);
    }

    #[test]
    fn text_accepts_dr_smith_with_period() {
        // Honorifics with internal periods should still be treated as
        // a valid speaker label.
        let input = "Dr. Smith: Hello there.";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].speaker, "Dr. Smith");
        assert_eq!(out[0].text, "Hello there.");
    }

    #[test]
    fn text_rejects_long_phrase_as_speaker() {
        // Four words is too many for a speaker label.
        let input = "We Should Ship This: it's ready.";
        let out = parse_text(input).unwrap();
        assert_eq!(out[0].speaker, "unknown");
    }

    #[test]
    fn parse_hms_rejects_garbage() {
        assert_eq!(parse_hms("crosstalk"), None);
        assert_eq!(parse_hms(""), None);
        assert_eq!(parse_hms("a:b:c"), None);
        assert_eq!(parse_hms("1::3"), None);
        assert_eq!(parse_hms("1:2:3:4"), None);
    }
}
