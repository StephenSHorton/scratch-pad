use chrono::{DateTime, Utc};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
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

fn create_blank_note() {
    let note = Note {
        id: uuid::Uuid::new_v4().to_string(),
        title: None,
        body: String::new(),
        color: "yellow".to_string(),
        created_at: Utc::now().to_rfc3339(),
        expires_at: None,
        position: None,
    };
    let mut notes = read_notes();
    notes.push(note);
    write_notes(&notes);
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

fn create_note_window(app: &AppHandle, note: &Note, _index: usize) {
    // Skip if a window with this label already exists
    if app.get_webview_window(&note.id).is_some() {
        return;
    }

    let win_w: f64 = 380.0;
    let win_h: f64 = 320.0;

    let builder = WebviewWindowBuilder::new(app, &note.id, WebviewUrl::default())
        .title(note.title.as_deref().unwrap_or("Scratch Pad"))
        .decorations(false)
        .transparent(true)
        .inner_size(win_w, win_h);

    // Clamp position so the note is fully visible on screen
    let builder = match &note.position {
        Some(pos) => {
            let (x, y) = clamp_to_screen(app, pos.x, pos.y, win_w, win_h);
            builder.position(x, y)
        }
        None => builder.center(),
    };

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
            update_note_body,
            update_note_color,
            update_note_position
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

            let menu = Menu::with_items(app, &[&app_submenu, &file_submenu, &edit_submenu])?;
            app.set_menu(menu)?;

            // Handle menu events
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                match event.id().as_ref() {
                    "new_pad" | "tray_new_pad" => {
                        create_blank_note();
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
        if let RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
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
                };
                let mut notes = read_notes();
                notes.retain(|n| n.id != "update-status");
                notes.push(note);
                write_notes(&notes);
            }
        }
    }
}
