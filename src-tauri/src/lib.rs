use std::{fs, sync::Mutex, thread, time::Duration};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

// Define AppState to hold "pinned" and "throttle" status
struct AppState {
    is_pinned: Mutex<bool>,
    last_toggle_time: Mutex<u128>, // SystemTime as u128 millis
}

#[tauri::command]
fn set_pin_mode(state: tauri::State<AppState>, pinned: bool) {
    if let Ok(mut is_pinned) = state.is_pinned.lock() {
        *is_pinned = pinned;
    }
}

// Helper to get current millis
fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn load_content(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let doc_dir = app.path().document_dir().map_err(|e| e.to_string())?;
    let app_dir = doc_dir.join("SoNotes");
    let file_path = app_dir.join(&filename);

    if !file_path.exists() {
        return Err("File not found".to_string());
    }

    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_content(app: tauri::AppHandle, filename: String, content: String) -> Result<(), String> {
    let doc_dir = app.path().document_dir().map_err(|e| e.to_string())?;
    let app_dir = doc_dir.join("SoNotes");
    
    // Ensure directory exists
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }

    let file_path = app_dir.join(&filename);
    let tmp_path = app_dir.join(format!("{}.tmp", filename));

    // 1. Try Atomic Write (Write Tmp -> Rename)
    if let Err(e) = fs::write(&tmp_path, &content) {
        return fs::write(&file_path, &content)
            .map_err(|e2| format!("Failed to write tmp: {}. Direct write failed: {}", e, e2));
    }

    // 2. Retry Rename Logic
    let max_retries = 5;
    let mut last_rename_err = String::new();
    let mut rename_success = false;

    for i in 0..max_retries {
        match fs::rename(&tmp_path, &file_path) {
            Ok(_) => {
                rename_success = true;
                break;
            },
            Err(e) => {
                last_rename_err = e.to_string();
                if e.kind() == std::io::ErrorKind::NotFound {
                    break;
                }
                thread::sleep(Duration::from_millis(100 * (i + 1) as u64));
            }
        }
    }

    if rename_success {
        return Ok(());
    }

    // 3. Fallback: Direct Write
    match fs::write(&file_path, &content) {
        Ok(_) => {
            let _ = fs::remove_file(&tmp_path);
            Ok(())
        },
        Err(e) => {
            Err(format!("Atomic save failed ({}). Direct save failed: {}", last_rename_err, e))
        }
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .manage(AppState {
            is_pinned: Mutex::new(false),
            last_toggle_time: Mutex::new(0),
        })
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        let state = app.state::<AppState>();
                        let now = now_millis();
                        let mut last = state.last_toggle_time.lock().unwrap();
                        if now - *last < 300 { return; }
                        *last = now;

                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.move_window(Position::BottomRight);
                            if let Ok(pos) = window.outer_position() {
                                let new_pos = tauri::PhysicalPosition { x: pos.x - 16, y: pos.y - 48 };
                                let _ = window.set_position(new_pos);
                            }
                            let is_visible = window.is_visible().unwrap_or(false);
                            let is_focused = window.is_focused().unwrap_or(false);
                            if is_visible && is_focused { let _ = window.hide(); }
                            else { let _ = window.show(); let _ = window.set_focus(); }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                if !focused {
                    let app_handle = window.app_handle();
                    let state = app_handle.state::<AppState>();
                    let is_pinned = state.is_pinned.lock().map(|p| *p).unwrap_or(false);
                    
                    if !is_pinned {
                        let should_hide = if let (Ok(cursor), Ok(pos), Ok(size)) = (
                            window.cursor_position(),
                            window.outer_position(),
                            window.outer_size(),
                        ) {
                            let cursor_x = cursor.x as i32;
                            let cursor_y = cursor.y as i32;
                            let win_x = pos.x;
                            let win_y = pos.y;
                            let win_w = size.width as i32;
                            let win_h = size.height as i32;
                            let buffer = 50;
                            let rel_x = cursor_x - win_x;
                            let rel_y = cursor_y - win_y;
                            
                            let is_in_window = rel_x >= -buffer && rel_x <= win_w + buffer 
                                            && rel_y >= -buffer && rel_y <= win_h + buffer;
                            !is_in_window
                        } else {
                            true
                        };

                        if should_hide { let _ = window.hide(); }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, set_pin_mode, save_content, load_content])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
