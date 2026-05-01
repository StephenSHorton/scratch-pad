mod audio;
mod network;

use chrono::{DateTime, Utc};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::webview::Color;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const TRANSPARENT_BG: Color = Color(0, 0, 0, 0);
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_updater::UpdaterExt;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: Option<String>,
    pub body: String,
    pub color: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub position: Option<Position>,
    pub size: Option<Size>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

pub struct NotesState {
    pub notes: Mutex<Vec<Note>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub always_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { always_on_top: false }
    }
}

pub struct SettingsState {
    pub settings: Mutex<Settings>,
}

pub struct PaletteState {
    pub source_label: Mutex<Option<String>>,
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

fn notes_dir() -> PathBuf {
    let home = dirs::home_dir().expect("could not resolve home directory");
    home.join(".scratch-pad")
}

fn log_file() -> PathBuf {
    notes_dir().join("scratch-pad.log")
}

pub(crate) fn log(msg: &str) {
    use std::io::Write;
    let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{timestamp}] {msg}\n");
    eprint!("{line}");
    let path = log_file();
    // Rotate if log exceeds 1MB
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 1_000_000 {
            let old = path.with_extension("log.old");
            fs::rename(&path, &old).ok();
        }
    }
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        f.write_all(line.as_bytes()).ok();
    }
}

fn notes_file() -> PathBuf {
    notes_dir().join("notes.json")
}

fn read_notes() -> Vec<Note> {
    let path = notes_file();
    if !path.exists() {
        return vec![];
    }
    let data = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

fn settings_file() -> PathBuf {
    notes_dir().join("settings.json")
}

fn read_settings() -> Settings {
    let path = settings_file();
    if !path.exists() {
        return Settings::default();
    }
    let data = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

fn write_settings(settings: &Settings) {
    let dir = notes_dir();
    fs::create_dir_all(&dir).ok();
    let json = serde_json::to_string_pretty(settings).unwrap_or_default();
    fs::write(settings_file(), json).ok();
}

fn write_notes(notes: &[Note]) {
    let dir = notes_dir();
    fs::create_dir_all(&dir).ok();
    let json = serde_json::to_string_pretty(notes).unwrap_or_default();
    fs::write(notes_file(), json).ok();
}

fn create_blank_note() {
    log("Creating blank note");
    let note = Note {
        id: uuid::Uuid::new_v4().to_string(),
        title: None,
        body: String::new(),
        color: "yellow".to_string(),
        created_at: Utc::now().to_rfc3339(),
        expires_at: None,
        position: None,
        size: None,
    };
    let mut notes = read_notes();
    notes.push(note);
    write_notes(&notes);
}

fn create_note_with_body(title: Option<String>, body: String, color: &str) {
    log("Creating note with body");
    let note = Note {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        body,
        color: color.to_string(),
        created_at: Utc::now().to_rfc3339(),
        expires_at: None,
        position: None,
        size: None,
    };
    let mut notes = read_notes();
    notes.push(note);
    write_notes(&notes);
}

fn always_on_top_setting(app: &AppHandle) -> bool {
    app.try_state::<SettingsState>()
        .and_then(|s| s.settings.lock().ok().map(|s| s.always_on_top))
        .unwrap_or(false)
}

fn open_logs_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("logs") {
        window.set_focus().ok();
        return;
    }
    WebviewWindowBuilder::new(app, "logs", WebviewUrl::default())
        .title("Scratch Pad Logs")
        .decorations(false)
        .transparent(true)
        .background_color(TRANSPARENT_BG)
        .always_on_top(always_on_top_setting(app))
        .inner_size(520.0, 400.0)
        .build()
        .ok();
}

fn open_lobby_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("lobby") {
        window.set_focus().ok();
        return;
    }
    WebviewWindowBuilder::new(app, "lobby", WebviewUrl::default())
        .title("Multiplayer")
        .decorations(false)
        .transparent(true)
        .background_color(TRANSPARENT_BG)
        .always_on_top(always_on_top_setting(app))
        .inner_size(400.0, 500.0)
        .center()
        .build()
        .ok();
}

fn open_meeting_window(app: &AppHandle) {
    // Compute monitor-relative geometry so the graph + outline windows
    // are paired on-screen with safe edge margins and reasonable caps.
    let (sw, sh, sx, sy) = match app.primary_monitor() {
        Ok(Some(m)) => {
            let size = m.size();
            let pos = m.position();
            let scale = m.scale_factor();
            (
                size.width as f64 / scale,
                size.height as f64 / scale,
                pos.x as f64 / scale,
                pos.y as f64 / scale,
            )
        }
        _ => (1440.0, 900.0, 0.0, 0.0),
    };

    let margin = (sw * 0.05).max(40.0);
    let avail_w = (sw - 2.0 * margin).max(960.0);
    let total_h = (sh * 0.85).min(1000.0);
    let gap = 16.0;

    let outline_w = (avail_w * 0.28).clamp(360.0, 480.0);
    let graph_w = (avail_w - outline_w - gap).min(1400.0);
    let pair_w = graph_w + gap + outline_w;

    let x_graph = sx + (sw - pair_w) / 2.0;
    let x_outline = x_graph + graph_w + gap;
    let y = sy + (sh - total_h) / 2.0;

    if let Some(window) = app.get_webview_window("meeting-test") {
        window.set_focus().ok();
    } else {
        WebviewWindowBuilder::new(
            app,
            "meeting-test",
            WebviewUrl::App("meeting/test".into()),
        )
        .title("Aizuchi — meeting prototype")
        .inner_size(graph_w, total_h)
        .position(x_graph, y)
        .build()
        .ok();
    }

    if let Some(window) = app.get_webview_window("meeting-outline-test") {
        window.set_focus().ok();
    } else {
        WebviewWindowBuilder::new(app, "meeting-outline-test", WebviewUrl::default())
            .title("Aizuchi — outline")
            .inner_size(outline_w, total_h)
            .position(x_outline, y)
            .build()
            .ok();
    }
}

fn open_palette_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("palette") {
        window.set_focus().ok();
        return;
    }
    // Pure-transparent window — the glass is CSS (backdrop-filter + bg-black/40)
    // so it animates in as one unit with the motion fade. Native vibrancy
    // would render before React mounts, causing a visible two-step appear.
    WebviewWindowBuilder::new(app, "palette", WebviewUrl::default())
        .title("Command Palette")
        .decorations(false)
        .transparent(true)
        .background_color(TRANSPARENT_BG)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(640.0, 420.0)
        .center()
        .focused(true)
        .build()
        .ok();
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_note(id: String, state: tauri::State<'_, NotesState>) -> Option<Note> {
    let notes = state.notes.lock().ok()?;
    notes.iter().find(|n| n.id == id).cloned()
}

#[tauri::command]
fn dismiss_note(id: String, app: AppHandle, state: tauri::State<'_, NotesState>) {
    // Remove from state
    if let Ok(mut notes) = state.notes.lock() {
        notes.retain(|n| n.id != id);
        write_notes(&notes);
    }

    // Close the window
    if let Some(window) = app.get_webview_window(&id) {
        window.close().ok();
    }
}

#[tauri::command]
fn update_note_color(id: String, color: String, state: tauri::State<'_, NotesState>) -> Option<Note> {
    if let Ok(mut notes) = state.notes.lock() {
        if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
            note.color = color;
            let updated = note.clone();
            write_notes(&notes);
            return Some(updated);
        }
    }
    None
}

#[tauri::command]
fn update_note_body(id: String, body: String, title: Option<String>, state: tauri::State<'_, NotesState>) -> Option<Note> {
    if let Ok(mut notes) = state.notes.lock() {
        if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
            note.body = body;
            if let Some(t) = title {
                note.title = Some(t);
            }
            let updated = note.clone();
            write_notes(&notes);
            return Some(updated);
        }
    }
    None
}

#[tauri::command]
fn update_note_position(id: String, x: f64, y: f64, state: tauri::State<'_, NotesState>) {
    if let Ok(mut notes) = state.notes.lock() {
        if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
            note.position = Some(Position { x, y });
        }
        write_notes(&notes);
    }
}

// ---------------------------------------------------------------------------
// Highlight commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn clear_note_highlight(id: String) -> Result<(), String> {
    let path = notes_dir().join("highlights.json");
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut highlights: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&content).unwrap_or_default();
    highlights.remove(&id);
    let json = serde_json::to_string_pretty(&highlights).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

#[tauri::command]
fn open_palette(
    app: AppHandle,
    source_label: Option<String>,
    palette_state: tauri::State<'_, PaletteState>,
) {
    if let Ok(mut slot) = palette_state.source_label.lock() {
        *slot = source_label;
    }
    open_palette_window(&app);
}

#[tauri::command]
fn close_palette(app: AppHandle) {
    if let Some(window) = app.get_webview_window("palette") {
        window.close().ok();
    }
}

#[tauri::command]
fn get_palette_context(palette_state: tauri::State<'_, PaletteState>) -> Option<String> {
    palette_state
        .source_label
        .lock()
        .ok()
        .and_then(|s| s.clone())
}

#[tauri::command]
fn dispatch_action(app: AppHandle, id: String, state: tauri::State<'_, NotesState>) {
    log(&format!("dispatch_action: {id}"));
    match id.as_str() {
        "new_pad" => create_blank_note(),
        "organize" => organize_windows(&app, &state),
        "show_logs" => open_logs_window(&app),
        "lobby" => open_lobby_window(&app),
        "aizuchi" => open_meeting_window(&app),
        _ => log(&format!("dispatch_action: unknown id {id}")),
    }
}

// ---------------------------------------------------------------------------
// Audio commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn record_test_audio(duration_secs: Option<u32>) -> Result<String, String> {
    let secs = duration_secs.unwrap_or(5);
    let path = notes_dir().join("test-recording.wav");
    let path_clone = path.clone();
    log(&format!("record_test_audio: starting {secs}s capture → {path:?}"));
    tauri::async_runtime::spawn_blocking(move || audio::record_to_file(secs, path_clone, |_| {}))
        .await
        .map_err(|e| format!("Recording task failed: {e}"))??;
    log(&format!("record_test_audio: completed → {path:?}"));
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn record_and_transcribe(
    app: AppHandle,
    duration_secs: Option<u32>,
) -> Result<String, String> {
    let secs = duration_secs.unwrap_or(5);
    let wav_path = notes_dir().join("test-recording.wav");
    let model_path = notes_dir().join("models").join(audio::MODEL_FILENAME);
    log(&format!(
        "record_and_transcribe: starting {secs}s capture → {wav_path:?}"
    ));

    open_recording_session_window(&app);
    let app_record = app.clone();
    let app_status = app.clone();
    emit_phase(&app, "recording", &format!("Recording — {secs}s"));

    let wav = wav_path.clone();
    let model = model_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let level_cb = move |level: f32| {
            let _ = app_record.emit("audio-level", level);
        };
        audio::record_to_file(secs, wav.clone(), level_cb)?;
        emit_phase(&app_status, "downloading", "Loading model…");
        audio::ensure_model(&model, audio::MODEL_URL)?;
        emit_phase(&app_status, "transcribing", "Transcribing…");
        let segments = audio::transcribe_file(&model, &wav)?;
        Ok(segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string())
    })
    .await
    .map_err(|e| format!("Audio task failed: {e}"))?;

    match result {
        Ok(text) => {
            log(&format!("record_and_transcribe: result = {text:?}"));
            let body = if text.is_empty() {
                "(empty transcript — try recording again)".to_string()
            } else {
                text.clone()
            };
            create_note_with_body(Some("Transcript".to_string()), body, "blue");
            emit_phase(&app, "done", "Transcript ready");
            schedule_close_recording_session(app.clone(), 1200);
            Ok(text)
        }
        Err(e) => {
            log(&format!("record_and_transcribe: error = {e}"));
            emit_phase(&app, "error", &e);
            schedule_close_recording_session(app.clone(), 4000);
            Err(e)
        }
    }
}

fn emit_phase(app: &AppHandle, phase: &str, label: &str) {
    let _ = app.emit(
        "audio-phase",
        serde_json::json!({ "phase": phase, "label": label }),
    );
}

fn schedule_close_recording_session(app: AppHandle, delay_ms: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        if let Some(window) = app.get_webview_window("recording-session") {
            window.close().ok();
        }
    });
}

fn open_recording_session_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("recording-session") {
        window.set_focus().ok();
        return;
    }
    WebviewWindowBuilder::new(app, "recording-session", WebviewUrl::default())
        .title("Recording")
        .decorations(false)
        .transparent(true)
        .background_color(TRANSPARENT_BG)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(360.0, 240.0)
        .center()
        .focused(false)
        .build()
        .ok();
}

#[tauri::command]
async fn transcribe_test_audio() -> Result<String, String> {
    let wav_path = notes_dir().join("test-recording.wav");
    if !wav_path.exists() {
        return Err(
            "No test-recording.wav found. Run 'Test mic recording' first.".into(),
        );
    }
    let model_path = notes_dir().join("models").join(audio::MODEL_FILENAME);
    log(&format!(
        "transcribe_test_audio: starting (model={model_path:?}, wav={wav_path:?})"
    ));

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        audio::ensure_model(&model_path, audio::MODEL_URL)?;
        let segments = audio::transcribe_file(&model_path, &wav_path)?;
        Ok(segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string())
    })
    .await
    .map_err(|e| format!("Transcription task failed: {e}"))??;

    log(&format!("transcribe_test_audio: result = {result:?}"));

    let body = if result.is_empty() {
        "(empty transcript — try recording again)".to_string()
    } else {
        result.clone()
    };
    create_note_with_body(Some("Transcript".to_string()), body, "blue");

    Ok(result)
}

// ---------------------------------------------------------------------------
// Log viewer command
// ---------------------------------------------------------------------------

#[tauri::command]
fn read_log_tail(lines: Option<usize>) -> String {
    let max_lines = lines.unwrap_or(200);
    let path = log_file();
    match fs::read_to_string(&path) {
        Ok(content) => {
            let all_lines: Vec<&str> = content.lines().collect();
            let start = all_lines.len().saturating_sub(max_lines);
            all_lines[start..].join("\n")
        }
        Err(_) => String::from("No log file found."),
    }
}

// ---------------------------------------------------------------------------
// Network commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_peers(
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<Vec<network::protocol::PeerInfo>, String> {
    Ok(network.peers())
}

#[tauri::command]
async fn get_remote_notes(
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<Vec<network::protocol::NoteEnvelope>, String> {
    Ok(network.remote_notes())
}

#[tauri::command]
async fn get_remote_note(
    id: String,
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<Option<network::protocol::NoteEnvelope>, String> {
    Ok(network.remote_notes().into_iter().find(|n| n.id == id))
}

#[tauri::command]
async fn share_note(
    id: String,
    scope: String,
    intent: String,
    network: tauri::State<'_, network::NetworkHandle>,
    notes_state: tauri::State<'_, NotesState>,
) -> Result<(), String> {
    let note = {
        let notes = notes_state
            .notes
            .lock()
            .map_err(|e| format!("Failed to lock notes: {e}"))?;
        notes
            .iter()
            .find(|n| n.id == id)
            .cloned()
            .ok_or_else(|| format!("Note {id} not found"))?
    };

    let parsed_scope = match scope.as_str() {
        "team" => network::protocol::NoteScope::Team,
        "local" => network::protocol::NoteScope::Local,
        s if s.starts_with("group:") => {
            network::protocol::NoteScope::Group(s[6..].to_string())
        }
        _ => network::protocol::NoteScope::Team,
    };

    let parsed_intent = match intent.as_str() {
        "decision" => network::protocol::NoteIntent::Decision,
        "question" => network::protocol::NoteIntent::Question,
        "context" => network::protocol::NoteIntent::Context,
        "handoff" => network::protocol::NoteIntent::Handoff,
        "fyi" => network::protocol::NoteIntent::Fyi,
        _ => network::protocol::NoteIntent::Fyi,
    };

    let envelope = network::protocol::NoteEnvelope {
        id: note.id,
        sender: network.display_name.clone(),
        sender_id: network.node_id.clone(),
        scope: parsed_scope,
        intent: parsed_intent,
        title: note.title,
        body: note.body,
        color: note.color,
        timestamp: Utc::now().timestamp_millis(),
        ttl: 0,
    };

    network.share_note(envelope);
    Ok(())
}

#[tauri::command]
async fn retract_note(
    id: String,
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<(), String> {
    network.retract_note(&id);
    Ok(())
}

#[derive(serde::Serialize)]
struct HostRoomResult {
    code: String,
    ip: String,
    port: u16,
}

#[tauri::command]
async fn host_room(
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<HostRoomResult, String> {
    let (ip, port) = network.local_addr()?;
    let code = network.host_room()?;
    log(&format!("[network] Hosting room: {code} ({ip}:{port})"));
    Ok(HostRoomResult {
        code,
        ip: ip.to_string(),
        port,
    })
}

#[derive(serde::Serialize)]
struct JoinRoomResult {
    peer_name: String,
    peer_id: String,
}

#[tauri::command]
async fn join_room(
    code: String,
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<JoinRoomResult, String> {
    let (peer_id, peer_name) = network.join_room(&code).await?;
    log(&format!("[network] Joined room — connected to {peer_name} ({peer_id})"));
    Ok(JoinRoomResult { peer_name, peer_id })
}

#[tauri::command]
async fn disconnect_peer(
    node_id: String,
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<(), String> {
    network.disconnect_peer(&node_id).await
}

#[derive(serde::Serialize)]
struct LocalNetworkInfo {
    node_id: String,
    display_name: String,
    ip: String,
    port: u16,
    room_code: String,
}

#[tauri::command]
async fn get_local_network_info(
    network: tauri::State<'_, network::NetworkHandle>,
) -> Result<LocalNetworkInfo, String> {
    let (ip, port) = network.local_addr()?;
    let room_code = network.host_room()?;
    Ok(LocalNetworkInfo {
        node_id: network.node_id.clone(),
        display_name: network.display_name.clone(),
        ip: ip.to_string(),
        port,
        room_code,
    })
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

fn clamp_to_screen(app: &AppHandle, x: f64, y: f64, win_w: f64, win_h: f64) -> (f64, f64) {
    // Try to get the monitor at the note's position, fall back to primary
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten();

    let (screen_x, screen_y, screen_w, screen_h) = match &monitor {
        Some(m) => {
            let pos = m.position();
            let size = m.size();
            let scale = m.scale_factor();
            (
                pos.x as f64,
                pos.y as f64,
                size.width as f64 / scale,
                size.height as f64 / scale,
            )
        }
        None => (0.0, 0.0, 1920.0, 1080.0), // fallback
    };

    // Leave some padding for the macOS menu bar (30px) and dock
    let pad_top = 30.0;
    let pad_bottom = 80.0;
    let pad_side = 10.0;

    let clamped_x = x
        .max(screen_x + pad_side)
        .min(screen_x + screen_w - win_w - pad_side);
    let clamped_y = y
        .max(screen_y + pad_top)
        .min(screen_y + screen_h - win_h - pad_bottom);

    (clamped_x, clamped_y)
}

fn organize_windows(app: &AppHandle, state: &NotesState) {
    log("Organizing windows");
    let note_ids: Vec<String> = {
        let notes = state.notes.lock().unwrap();
        notes.iter().map(|n| n.id.clone()).collect()
    };

    let count = note_ids.len();
    if count == 0 {
        return;
    }

    // Get screen dimensions
    let monitor = app.primary_monitor().ok().flatten();
    let (screen_x, screen_y, screen_w, screen_h) = match &monitor {
        Some(m) => {
            let pos = m.position();
            let size = m.size();
            let scale = m.scale_factor();
            (
                pos.x as f64,
                pos.y as f64,
                size.width as f64 / scale,
                size.height as f64 / scale,
            )
        }
        None => (0.0, 0.0, 1920.0, 1080.0),
    };

    // Account for menu bar and dock
    let pad_top = 30.0;
    let pad_bottom = 80.0;
    let pad_side = 10.0;
    let gap = 8.0;

    let usable_w = screen_w - (2.0 * pad_side);
    let usable_h = screen_h - pad_top - pad_bottom;

    // Calculate grid: cols = ceil(sqrt(n)), rows = ceil(n / cols)
    let cols = (count as f64).sqrt().ceil() as usize;
    let rows = (count as f64 / cols as f64).ceil() as usize;

    let win_w = (usable_w - (gap * (cols as f64 - 1.0))) / cols as f64;
    let win_h = (usable_h - (gap * (rows as f64 - 1.0))) / rows as f64;

    for (i, id) in note_ids.iter().enumerate() {
        if let Some(window) = app.get_webview_window(id) {
            let col = i % cols;
            let row = i / cols;
            let x = screen_x + pad_side + (col as f64 * (win_w + gap));
            let y = screen_y + pad_top + (row as f64 * (win_h + gap));

            window.set_size(tauri::LogicalSize::new(win_w, win_h)).ok();
            window.set_position(tauri::LogicalPosition::new(x, y)).ok();
            window.set_focus().ok();
        }
    }

    // Also persist positions
    if let Ok(mut notes) = state.notes.lock() {
        for (i, note) in notes.iter_mut().enumerate() {
            let col = i % cols;
            let row = i / cols;
            let x = screen_x + pad_side + (col as f64 * (win_w + gap));
            let y = screen_y + pad_top + (row as f64 * (win_h + gap));
            note.position = Some(Position { x, y });
        }
        write_notes(&notes);
    }
}

fn create_note_window(app: &AppHandle, note: &Note, _index: usize) {
    // Skip if a window with this label already exists
    if app.get_webview_window(&note.id).is_some() {
        return;
    }
    log(&format!("Creating window for note {}", note.id));

    let win_w = note.size.as_ref().map(|s| s.width).unwrap_or(380.0);
    let win_h = note.size.as_ref().map(|s| s.height).unwrap_or(320.0);

    let always_on_top = app
        .try_state::<SettingsState>()
        .and_then(|s| s.settings.lock().ok().map(|s| s.always_on_top))
        .unwrap_or(false);

    let builder = WebviewWindowBuilder::new(app, &note.id, WebviewUrl::default())
        .title(note.title.as_deref().unwrap_or("Scratch Pad"))
        .decorations(false)
        .transparent(true)
        .background_color(TRANSPARENT_BG)
        .always_on_top(always_on_top)
        .inner_size(win_w, win_h);

    // Clamp position so the note is fully visible on screen
    let builder = match &note.position {
        Some(pos) => {
            let (x, y) = clamp_to_screen(app, pos.x, pos.y, win_w, win_h);
            builder.position(x, y)
        }
        None => builder.center(),
    };

    if let Ok(window) = builder.build() {
        window.set_focus().ok();
    }
}

fn sync_windows(app: &AppHandle, state: &NotesState) {
    let mut notes = read_notes();
    let now = Utc::now();

    // Filter out expired notes
    notes.retain(|note| {
        if let Some(ref expires) = note.expires_at {
            if let Ok(exp) = expires.parse::<DateTime<Utc>>() {
                return exp > now;
            }
        }
        true
    });

    // Sanitize absurd positions (e.g. from coordinate system mismatches)
    let mut needs_write = false;
    for note in notes.iter_mut() {
        if let Some(ref pos) = note.position {
            if pos.x.abs() > 20000.0 || pos.y.abs() > 20000.0 {
                log(&format!("Resetting absurd position for note {}: ({}, {})", note.id, pos.x, pos.y));
                note.position = None;
                needs_write = true;
            }
        }
    }
    if needs_write {
        write_notes(&notes);
    }

    // Collect IDs of current notes
    let note_ids: Vec<String> = notes.iter().map(|n| n.id.clone()).collect();

    // Close windows for notes that no longer exist
    if let Ok(existing) = state.notes.lock() {
        for old_note in existing.iter() {
            if !note_ids.contains(&old_note.id) {
                if let Some(window) = app.get_webview_window(&old_note.id) {
                    window.close().ok();
                }
            }
        }
    }

    // Create windows for new notes, update existing ones
    for (i, note) in notes.iter().enumerate() {
        if let Some(window) = app.get_webview_window(&note.id) {
            // Window already exists — push updated data to the frontend
            window.emit("note-updated", note.clone()).ok();
            // Apply position/size if set (e.g. from MCP move/resize)
            if let Some(ref pos) = note.position {
                window.set_position(tauri::LogicalPosition::new(pos.x, pos.y)).ok();
            }
            if let Some(ref size) = note.size {
                window.set_size(tauri::LogicalSize::new(size.width, size.height)).ok();
            }
        } else {
            create_note_window(app, note, i);
        }
    }

    // Update the shared state
    if let Ok(mut state_notes) = state.notes.lock() {
        *state_notes = notes;
    }

    // Handle remote notes (if network is available)
    if let Some(network) = app.try_state::<network::NetworkHandle>() {
        let remote_notes = network.remote_notes();
        let remote_ids: Vec<String> = remote_notes
            .iter()
            .map(|n| format!("remote-{}", n.id))
            .collect();

        // Close windows for remote notes that no longer exist
        // Collect all window labels that start with "remote-"
        // We check against the remote_ids list
        for envelope in &remote_notes {
            let label = format!("remote-{}", envelope.id);
            if let Some(window) = app.get_webview_window(&label) {
                // Window exists — emit update
                window.emit("note-updated", &envelope).ok();
            } else {
                // Create a window for this remote note
                let remote_note = Note {
                    id: label.clone(),
                    title: envelope.title.clone(),
                    body: envelope.body.clone(),
                    color: envelope.color.clone(),
                    created_at: chrono::DateTime::from_timestamp_millis(envelope.timestamp)
                        .unwrap_or_else(|| Utc::now())
                        .to_rfc3339(),
                    expires_at: None,
                    position: None,
                    size: None,
                };
                create_note_window(app, &remote_note, 0);
            }
        }

        // Close remote windows that are no longer in the remote notes list
        // We need to check all windows and close ones with "remote-" prefix not in remote_ids
        if let Ok(existing_local) = state.notes.lock() {
            // Get all window labels we know about
            for local_note in existing_local.iter() {
                // Skip local notes (handled above)
                if !local_note.id.starts_with("remote-") {
                    continue;
                }
                if !remote_ids.contains(&local_note.id) {
                    if let Some(window) = app.get_webview_window(&local_note.id) {
                        window.close().ok();
                    }
                }
            }
        }

        // Also check for stale remote windows by reading remote-notes from disk
        // and closing any windows whose IDs are gone
        let remote_notes_file = notes_dir().join("remote-notes.json");
        if remote_notes_file.exists() {
            // We already have remote_ids from the network handle
            // Close any "remote-*" windows not in that set
            // This is best-effort via the webview window listing
        }
    }
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(NotesState {
            notes: Mutex::new(vec![]),
        })
        .manage(SettingsState {
            settings: Mutex::new(read_settings()),
        })
        .manage(PaletteState {
            source_label: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_note,
            dismiss_note,
            update_note_body,
            update_note_color,
            update_note_position,
            read_log_tail,
            clear_note_highlight,
            get_peers,
            get_remote_notes,
            get_remote_note,
            share_note,
            retract_note,
            host_room,
            join_room,
            disconnect_peer,
            get_local_network_info,
            open_palette,
            close_palette,
            get_palette_context,
            dispatch_action,
            record_test_audio,
            transcribe_test_audio,
            record_and_transcribe,
        ])
        .setup(|app| {
            // Build the macOS menu bar
            let app_submenu = Submenu::with_items(
                app,
                "Scratch Pad",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Scratch Pad"), Some(tauri::menu::AboutMetadata {
                        version: Some(app.config().version.clone().unwrap_or_default()),
                        ..Default::default()
                    }))?,
                    &MenuItem::with_id(app, "check_updates", "Check for Updates...", true, None::<&str>)?,
                    &MenuItem::with_id(app, "show_logs", "Show Logs", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            let file_submenu = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "new_pad", "New Pad", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(app, "organize", "Organize Pads", true, Some("CmdOrCtrl+Shift+O"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "lobby", "Multiplayer...", true, Some("CmdOrCtrl+Shift+M"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "clear_all", "Clear All Pads", true, None::<&str>)?,
                ],
            )?;

            let edit_submenu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let initial_settings = read_settings();
            let view_submenu = Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &CheckMenuItem::with_id(app, "always_on_top", "Always on Top", true, initial_settings.always_on_top, None::<&str>)?,
                ],
            )?;

            let menu = Menu::with_items(app, &[&app_submenu, &file_submenu, &edit_submenu, &view_submenu])?;
            app.set_menu(menu)?;

            // Handle menu events
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                match event.id().as_ref() {
                    "new_pad" | "tray_new_pad" => {
                        create_blank_note();
                    }
                    "organize" | "tray_organize" => {
                        let state = handle.state::<NotesState>();
                        organize_windows(&handle, &state);
                    }
                    "clear_all" => {
                        write_notes(&[]);
                        let state = handle.state::<NotesState>();
                        sync_windows(&handle, &state);
                    }
                    "check_updates" => {
                        let h = handle.clone();
                        tauri::async_runtime::spawn(check_for_updates(h, false));
                    }
                    "show_logs" => open_logs_window(&handle),
                    "lobby" | "tray_lobby" => open_lobby_window(&handle),
                    "tray_aizuchi" => open_meeting_window(&handle),
                    "always_on_top" => {
                        let on_top = {
                            let settings_state = handle.state::<SettingsState>();
                            let mut settings = settings_state.settings.lock().unwrap();
                            settings.always_on_top = !settings.always_on_top;
                            write_settings(&settings);
                            settings.always_on_top
                        };

                        // Apply to all open windows
                        let note_ids: Vec<String> = {
                            let notes_state = handle.state::<NotesState>();
                            let notes = notes_state.notes.lock().unwrap();
                            notes.iter().map(|n| n.id.clone()).collect()
                        };
                        for id in &note_ids {
                            if let Some(window) = handle.get_webview_window(id) {
                                window.set_always_on_top(on_top).ok();
                            }
                        }
                    }
                    "tray_quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            });

            // System tray icon
            let tray_menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "tray_new_pad", "New Pad", true, None::<&str>)?,
                    &MenuItem::with_id(app, "tray_organize", "Organize Pads", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "tray_lobby", "Multiplayer...", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "tray_aizuchi", "Aizuchi prototype", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "tray_quit", "Quit Scratch Pad", true, None::<&str>)?,
                ],
            )?;

            let tray_icon_bytes = include_bytes!("../icons/tray-icon.png");
            let tray_icon = tauri::image::Image::from_bytes(tray_icon_bytes)?;
            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .build(app)?;

            // Ensure the notes directory exists
            fs::create_dir_all(notes_dir()).ok();

            // Create a welcome note if no notes exist yet
            let notes = read_notes();
            if notes.is_empty() {
                let welcome = Note {
                    id: uuid::Uuid::new_v4().to_string(),
                    title: Some("Welcome to Scratch Pad".to_string()),
                    body: "Floating desktop notes for Claude Code.\n\n\
                           **Quick start:**\n\
                           - Double-click text to edit\n\
                           - Drag anywhere to move\n\
                           - Click \u{2715} to delete\n\n\
                           **Connect to Claude Code:**\n\
                           ```\n\
                           claude mcp add --transport stdio --scope user scratch-pad -- \"/Applications/Scratch Pad.app/Contents/MacOS/scratch-pad-mcp\"\n\
                           ```\n\n\
                           Then restart Claude Code and say:\n\
                           *\"Write that to a scratch pad\"*"
                        .to_string(),
                    color: "yellow".to_string(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                    expires_at: None,
                    position: None,
                    size: None,
                };
                write_notes(&[welcome]);
            }

            // Initial sync + file watcher — delay slightly so the app is fully ready,
            // and start the watcher AFTER the initial sync to avoid races
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                // Wait for the app to finish setup
                thread::sleep(Duration::from_millis(500));

                // Initial sync
                let state = app_handle.state::<NotesState>();
                sync_windows(&app_handle, &state);

                // Now start the file watcher
                let handle = app_handle.clone();
                let mut watcher =
                    notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                        if let Ok(event) = res {
                            match event.kind {
                                EventKind::Modify(_) | EventKind::Create(_) => {
                                    // Small debounce to avoid rapid re-reads
                                    thread::sleep(Duration::from_millis(100));

                                    // Check for organize signal from MCP
                                    let organize_signal = notes_dir().join(".organize");
                                    if organize_signal.exists() {
                                        fs::remove_file(&organize_signal).ok();
                                        let state = handle.state::<NotesState>();
                                        sync_windows(&handle, &state);
                                        organize_windows(&handle, &state);
                                        return;
                                    }

                                    // Check for show-logs signal from MCP
                                    let show_logs_signal = notes_dir().join(".show-logs");
                                    if show_logs_signal.exists() {
                                        let signal_data = fs::read_to_string(&show_logs_signal).unwrap_or_default();
                                        fs::remove_file(&show_logs_signal).ok();
                                        // Parse optional filter from signal payload
                                        let filter: Option<String> = serde_json::from_str::<serde_json::Value>(&signal_data)
                                            .ok()
                                            .and_then(|v| v.get("filter").and_then(|f| f.as_str().map(String::from)));

                                        if let Some(window) = handle.get_webview_window("logs") {
                                            window.set_focus().ok();
                                            if let Some(f) = filter {
                                                window.emit("log-filter", f).ok();
                                            }
                                        } else {
                                            let always_on_top = handle
                                                .try_state::<SettingsState>()
                                                .and_then(|s| s.settings.lock().ok().map(|s| s.always_on_top))
                                                .unwrap_or(false);
                                            if let Ok(window) = WebviewWindowBuilder::new(&handle, "logs", WebviewUrl::default())
                                                .title("Scratch Pad Logs")
                                                .decorations(false)
                                                .transparent(true)
                                                .always_on_top(always_on_top)
                                                .inner_size(520.0, 400.0)
                                                .build()
                                            {
                                                if let Some(f) = filter {
                                                    // Wait briefly for the window to mount, then send filter
                                                    let w = window.clone();
                                                    std::thread::spawn(move || {
                                                        std::thread::sleep(Duration::from_millis(800));
                                                        w.emit("log-filter", f).ok();
                                                    });
                                                }
                                            }
                                        }
                                        return;
                                    }

                                    // Check for close-logs signal from MCP
                                    let close_logs_signal = notes_dir().join(".close-logs");
                                    if close_logs_signal.exists() {
                                        fs::remove_file(&close_logs_signal).ok();
                                        if let Some(window) = handle.get_webview_window("logs") {
                                            window.close().ok();
                                        }
                                        return;
                                    }

                                    // Check for open-lobby signal from MCP
                                    let open_lobby_signal = notes_dir().join(".open-lobby");
                                    if open_lobby_signal.exists() {
                                        fs::remove_file(&open_lobby_signal).ok();
                                        if let Some(window) = handle.get_webview_window("lobby") {
                                            window.set_focus().ok();
                                        } else {
                                            let always_on_top = handle
                                                .try_state::<SettingsState>()
                                                .and_then(|s| s.settings.lock().ok().map(|s| s.always_on_top))
                                                .unwrap_or(false);
                                            WebviewWindowBuilder::new(&handle, "lobby", WebviewUrl::default())
                                                .title("Multiplayer")
                                                .decorations(false)
                                                .transparent(true)
                                                .always_on_top(always_on_top)
                                                .inner_size(400.0, 500.0)
                                                .center()
                                                .build()
                                                .ok();
                                        }
                                        return;
                                    }

                                    // Check for join-room signal from MCP
                                    let join_room_signal = notes_dir().join(".join-room");
                                    if join_room_signal.exists() {
                                        if let Ok(content) = fs::read_to_string(&join_room_signal) {
                                            fs::remove_file(&join_room_signal).ok();
                                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                                                if let Some(code) = data.get("code").and_then(|v| v.as_str()) {
                                                    let code = code.to_string();
                                                    let network = handle.state::<network::NetworkHandle>();
                                                    let network = network.inner().clone();
                                                    let h = handle.clone();
                                                    tauri::async_runtime::spawn(async move {
                                                        match network.join_room(&code).await {
                                                            Ok((peer_id, peer_name)) => {
                                                                crate::log(&format!("[network] MCP joined room — connected to {peer_name} ({peer_id})"));
                                                                // Write result for MCP to read
                                                                let result = serde_json::json!({
                                                                    "success": true,
                                                                    "peer_name": peer_name,
                                                                    "peer_id": peer_id,
                                                                });
                                                                let result_file = notes_dir().join("room-result.json");
                                                                fs::write(&result_file, serde_json::to_string_pretty(&result).unwrap()).ok();
                                                                h.emit("peer-connected", serde_json::json!({"node_id": peer_id, "name": peer_name})).ok();
                                                            }
                                                            Err(e) => {
                                                                crate::log(&format!("[network] MCP join room failed: {e}"));
                                                                let result = serde_json::json!({
                                                                    "success": false,
                                                                    "error": e,
                                                                });
                                                                let result_file = notes_dir().join("room-result.json");
                                                                fs::write(&result_file, serde_json::to_string_pretty(&result).unwrap()).ok();
                                                            }
                                                        }
                                                    });
                                                }
                                            }
                                        }
                                        return;
                                    }

                                    // Check for host-room signal from MCP
                                    let host_room_signal = notes_dir().join(".host-room");
                                    if host_room_signal.exists() {
                                        fs::remove_file(&host_room_signal).ok();
                                        let network = handle.state::<network::NetworkHandle>();
                                        match network.host_room() {
                                            Ok(code) => {
                                                let (ip, port) = network.local_addr().unwrap_or((std::net::Ipv4Addr::UNSPECIFIED, 0));
                                                let result = serde_json::json!({
                                                    "code": code,
                                                    "ip": ip.to_string(),
                                                    "port": port,
                                                });
                                                let result_file = notes_dir().join("room-code.json");
                                                fs::write(&result_file, serde_json::to_string_pretty(&result).unwrap()).ok();
                                                crate::log(&format!("[network] MCP hosted room: {code}"));
                                            }
                                            Err(e) => {
                                                crate::log(&format!("[network] MCP host room failed: {e}"));
                                            }
                                        }
                                        return;
                                    }

                                    // Check for disconnect-peer signal from MCP
                                    let disconnect_signal = notes_dir().join(".disconnect-peer");
                                    if disconnect_signal.exists() {
                                        if let Ok(content) = fs::read_to_string(&disconnect_signal) {
                                            fs::remove_file(&disconnect_signal).ok();
                                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                                                if let Some(node_id) = data.get("nodeId").and_then(|v| v.as_str()) {
                                                    let node_id = node_id.to_string();
                                                    let network = handle.state::<network::NetworkHandle>();
                                                    let network = network.inner().clone();
                                                    let h = handle.clone();
                                                    tauri::async_runtime::spawn(async move {
                                                        if let Ok(()) = network.disconnect_peer(&node_id).await {
                                                            h.emit("peer-disconnected", serde_json::json!({"node_id": node_id})).ok();
                                                        }
                                                    });
                                                }
                                            }
                                        }
                                        return;
                                    }

                                    // Check for highlights.json changes — emit to all note windows
                                    let highlights_file = notes_dir().join("highlights.json");
                                    if highlights_file.exists() {
                                        if let Ok(content) = fs::read_to_string(&highlights_file) {
                                            if let Ok(highlights) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content) {
                                                for (note_id, pattern) in highlights.iter() {
                                                    if let Some(p) = pattern.as_str() {
                                                        if let Some(window) = handle.get_webview_window(note_id) {
                                                            window.emit("note-highlight", p.to_string()).ok();
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // Check for share signal files (.share-{noteId})
                                    let dir = notes_dir();
                                    if let Ok(entries) = fs::read_dir(&dir) {
                                        for entry in entries.flatten() {
                                            let fname = entry.file_name().to_string_lossy().to_string();
                                            if let Some(note_id) = fname.strip_prefix(".share-") {
                                                let note_id = note_id.to_string();
                                                let signal_path = entry.path();

                                                // Read signal file contents (JSON with scope, intent)
                                                let signal_data = fs::read_to_string(&signal_path).unwrap_or_default();
                                                fs::remove_file(&signal_path).ok();

                                                #[derive(serde::Deserialize)]
                                                struct ShareSignal {
                                                    #[serde(default = "default_scope")]
                                                    scope: String,
                                                    #[serde(default = "default_intent")]
                                                    intent: String,
                                                }
                                                fn default_scope() -> String { "team".to_string() }
                                                fn default_intent() -> String { "fyi".to_string() }

                                                let signal: ShareSignal = serde_json::from_str(&signal_data)
                                                    .unwrap_or(ShareSignal {
                                                        scope: "team".to_string(),
                                                        intent: "fyi".to_string(),
                                                    });

                                                if let Some(network) = handle.try_state::<network::NetworkHandle>() {
                                                    // Find the note
                                                    let notes = read_notes();
                                                    if let Some(note) = notes.iter().find(|n| n.id == note_id) {
                                                        let parsed_scope = match signal.scope.as_str() {
                                                            "team" => network::protocol::NoteScope::Team,
                                                            "local" => network::protocol::NoteScope::Local,
                                                            s if s.starts_with("group:") => {
                                                                network::protocol::NoteScope::Group(s[6..].to_string())
                                                            }
                                                            _ => network::protocol::NoteScope::Team,
                                                        };

                                                        let parsed_intent = match signal.intent.as_str() {
                                                            "decision" => network::protocol::NoteIntent::Decision,
                                                            "question" => network::protocol::NoteIntent::Question,
                                                            "context" => network::protocol::NoteIntent::Context,
                                                            "handoff" => network::protocol::NoteIntent::Handoff,
                                                            _ => network::protocol::NoteIntent::Fyi,
                                                        };

                                                        let envelope = network::protocol::NoteEnvelope {
                                                            id: note.id.clone(),
                                                            sender: network.display_name.clone(),
                                                            sender_id: network.node_id.clone(),
                                                            scope: parsed_scope,
                                                            intent: parsed_intent,
                                                            title: note.title.clone(),
                                                            body: note.body.clone(),
                                                            color: note.color.clone(),
                                                            timestamp: chrono::Utc::now().timestamp_millis(),
                                                            ttl: 0,
                                                        };
                                                        network.share_note(envelope);
                                                        log(&format!("Shared note {note_id} via signal file"));
                                                    }
                                                }
                                            } else if let Some(note_id) = fname.strip_prefix(".retract-") {
                                                let note_id = note_id.to_string();
                                                fs::remove_file(entry.path()).ok();

                                                if let Some(network) = handle.try_state::<network::NetworkHandle>() {
                                                    network.retract_note(&note_id);
                                                    log(&format!("Retracted note {note_id} via signal file"));
                                                }
                                            }
                                        }
                                    }

                                    let state = handle.state::<NotesState>();
                                    sync_windows(&handle, &state);
                                }
                                _ => {}
                            }
                        }
                    })
                    .expect("failed to create file watcher");

                watcher
                    .watch(&notes_dir(), RecursiveMode::NonRecursive)
                    .ok();

                // Keep the watcher alive for the lifetime of the app
                loop {
                    thread::sleep(Duration::from_secs(60));
                }
            });

            // Start P2P network
            let network_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let network = network::start_network(network_handle.clone()).await;
                network_handle.manage(network);
            });

            // macOS: create a blank note when app is re-focused with no notes
            #[cfg(target_os = "macos")]
            {
                use objc2_app_kit::NSApplicationDidBecomeActiveNotification;
                use std::ptr::NonNull;
                use std::sync::atomic::{AtomicBool, Ordering};

                let activation_handle = app.handle().clone();
                // Skip the first activation (app startup) — the welcome note handles that
                let first_activation = AtomicBool::new(true);

                let block = block2::RcBlock::new(move |_notification: NonNull<objc2_foundation::NSNotification>| {
                    if first_activation.swap(false, Ordering::Relaxed) {
                        return;
                    }
                    log("App activated — raising all windows");
                    let state = activation_handle.state::<NotesState>();
                    let notes = read_notes();
                    if notes.is_empty() {
                        create_blank_note();
                        sync_windows(&activation_handle, &state);
                    } else {
                        // Bring all note windows to front
                        let note_ids: Vec<String> = {
                            let locked = state.notes.lock().unwrap();
                            locked.iter().map(|n| n.id.clone()).collect()
                        };
                        for id in &note_ids {
                            if let Some(w) = activation_handle.get_webview_window(id) {
                                w.set_focus().ok();
                            }
                        }
                    }
                });

                unsafe {
                    let center = objc2_foundation::NSNotificationCenter::defaultCenter();
                    let _observer = center.addObserverForName_object_queue_usingBlock(
                        Some(NSApplicationDidBecomeActiveNotification),
                        None,
                        Some(&objc2_foundation::NSOperationQueue::mainQueue()),
                        &block,
                    );
                    std::mem::forget(_observer);
                }
            }

            // Check for updates on startup (after a short delay)
            let update_handle = app.handle().clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(5));
                tauri::async_runtime::block_on(check_for_updates(update_handle, true));
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        match event {
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                // Spotlight / dock icon click with no visible windows
                let notes = read_notes();
                if notes.is_empty() {
                    create_blank_note();
                    let state = _app_handle.state::<NotesState>();
                    sync_windows(_app_handle, &state);
                }
            }
            _ => {}
        }
    });
}

async fn check_for_updates(handle: AppHandle, silent: bool) {
    let updater = match handle.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("Failed to get updater: {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!(
                "Update available: {} -> {}",
                update.current_version, update.version
            );
            // Show update note
            let note = Note {
                id: "update-status".to_string(),
                title: Some("Updating Scratch Pad".to_string()),
                body: format!(
                    "Downloading **v{}**...\n\nThe update will take effect next time you launch the app.",
                    update.version
                ),
                color: "blue".to_string(),
                created_at: Utc::now().to_rfc3339(),
                expires_at: None,
                position: None,
                size: None,
            };
            let mut notes = read_notes();
            notes.retain(|n| n.id != "update-status");
            notes.push(note);
            write_notes(&notes);

            if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                eprintln!("Failed to install update: {e}");
            } else {
                // Update the note to show success
                let mut notes = read_notes();
                if let Some(n) = notes.iter_mut().find(|n| n.id == "update-status") {
                    n.body = format!(
                        "**v{}** installed! Restart Scratch Pad to use the new version.",
                        update.version
                    );
                    n.title = Some("Update Ready".to_string());
                    n.color = "green".to_string();
                }
                write_notes(&notes);
            }
        }
        Ok(None) => {
            eprintln!("No update available");
            if !silent {
                let note = Note {
                    id: "update-status".to_string(),
                    title: Some("No Updates".to_string()),
                    body: "You're on the latest version.".to_string(),
                    color: "green".to_string(),
                    created_at: Utc::now().to_rfc3339(),
                    expires_at: Some(
                        (Utc::now() + chrono::Duration::seconds(10)).to_rfc3339(),
                    ),
                    position: None,
                    size: None,
                };
                let mut notes = read_notes();
                notes.retain(|n| n.id != "update-status");
                notes.push(note);
                write_notes(&notes);
            }
        }
        Err(e) => {
            eprintln!("Update check failed: {e}");
            if !silent {
                let note = Note {
                    id: "update-status".to_string(),
                    title: Some("Update Check Failed".to_string()),
                    body: format!("{e}"),
                    color: "pink".to_string(),
                    created_at: Utc::now().to_rfc3339(),
                    expires_at: Some(
                        (Utc::now() + chrono::Duration::seconds(15)).to_rfc3339(),
                    ),
                    position: None,
                    size: None,
                };
                let mut notes = read_notes();
                notes.retain(|n| n.id != "update-status");
                notes.push(note);
                write_notes(&notes);
            }
        }
    }
}
