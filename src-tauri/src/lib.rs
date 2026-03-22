use chrono::{DateTime, Utc};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

pub struct NotesState {
    pub notes: Mutex<Vec<Note>>,
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

fn notes_dir() -> PathBuf {
    let home = dirs::home_dir().expect("could not resolve home directory");
    home.join(".scratch-pad")
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

fn write_notes(notes: &[Note]) {
    let dir = notes_dir();
    fs::create_dir_all(&dir).ok();
    let json = serde_json::to_string_pretty(notes).unwrap_or_default();
    fs::write(notes_file(), json).ok();
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
fn update_note_position(id: String, x: f64, y: f64, state: tauri::State<'_, NotesState>) {
    if let Ok(mut notes) = state.notes.lock() {
        if let Some(note) = notes.iter_mut().find(|n| n.id == id) {
            note.position = Some(Position { x, y });
        }
        write_notes(&notes);
    }
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

fn create_note_window(app: &AppHandle, note: &Note, index: usize) {
    // Skip if a window with this label already exists
    if app.get_webview_window(&note.id).is_some() {
        return;
    }

    let (x, y) = match &note.position {
        Some(pos) => (pos.x, pos.y),
        None => {
            let offset = (index as f64) * 30.0;
            (100.0 + offset, 100.0 + offset)
        }
    };

    let builder = WebviewWindowBuilder::new(app, &note.id, WebviewUrl::default())
        .title(note.title.as_deref().unwrap_or("Scratch Pad"))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .inner_size(380.0, 320.0)
        .position(x, y);

    builder.build().ok();
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

    // Create windows for new/existing notes
    for (i, note) in notes.iter().enumerate() {
        create_note_window(app, note, i);
    }

    // Update the shared state
    if let Ok(mut state_notes) = state.notes.lock() {
        *state_notes = notes;
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_note,
            dismiss_note,
            update_note_position
        ])
        .setup(|app| {
            // Ensure the notes directory exists
            fs::create_dir_all(notes_dir()).ok();

            // Initial sync
            let state = app.state::<NotesState>();
            sync_windows(app.handle(), &state);

            // Spawn a file-system watcher thread
            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let handle = app_handle.clone();
                let mut watcher =
                    notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                        if let Ok(event) = res {
                            match event.kind {
                                EventKind::Modify(_) | EventKind::Create(_) => {
                                    // Small debounce to avoid rapid re-reads
                                    thread::sleep(Duration::from_millis(100));
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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
        }
    });
}
