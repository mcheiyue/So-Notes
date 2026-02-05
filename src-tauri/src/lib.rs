use std::{fs, sync::Mutex, thread, time::Duration};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

// Define AppState to hold "pinned" and "throttle" status
struct AppState {
    is_pinned: Mutex<bool>,
    last_toggle_time: Mutex<u128>, // SystemTime as u128 millis
    pin_menu_item: Mutex<Option<MenuItem<tauri::Wry>>>, // Store the menu item
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
async fn save_content(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<(), String> {
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
            }
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
        }
        Err(e) => Err(format!(
            "Atomic save failed ({}). Direct save failed: {}",
            last_rename_err, e
        )),
    }
}

#[tauri::command]
fn check_hide_on_leave(window: tauri::Window, state: tauri::State<AppState>) {
    let is_pinned = state.is_pinned.lock().map(|p| *p).unwrap_or(false);
    if !is_pinned {
        // 如果当前窗口未聚焦（说明可能处于死锁状态），此时鼠标移出，应立即隐藏
        if let Ok(false) = window.is_focused() {
            let _ = window.hide();
        }
    }
}

#[tauri::command]
fn frontend_unpin(app: tauri::AppHandle, state: tauri::State<AppState>) {
    // 1. Update State
    if let Ok(mut is_pinned) = state.is_pinned.lock() {
        *is_pinned = false;
    }

    // 2. Update Menu Text
    if let Ok(guard) = state.pin_menu_item.lock() {
        if let Some(item) = guard.as_ref() {
             let _ = item.set_text("钉住窗口");
        }
    }
    
    // 3. Update Window Behavior & Emit Event
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(false);
        let _ = window.emit("pin-state-changed", false);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .manage(AppState {
            is_pinned: Mutex::new(false),
            last_toggle_time: Mutex::new(0),
            pin_menu_item: Mutex::new(None),
        })
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let pin_i = MenuItem::with_id(app, "pin", "钉住窗口", true, None::<&str>)?;
            
            // Store the pin menu item in AppState
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut guard) = state.pin_menu_item.lock() {
                    *guard = Some(pin_i.clone());
                }
            }
            
            let reset_i = MenuItem::with_id(app, "reset", "重置窗口", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&pin_i, &reset_i, &quit_i])?;

            // 克隆 MenuItem 句柄以便在事件闭包中使用
            let pin_i_clone = pin_i.clone();

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "pin" => {
                            let state = app.state::<AppState>();
                            let mut is_pinned = false;
                            {
                                let mut is_pinned_guard = state.is_pinned.lock().unwrap();
                                *is_pinned_guard = !*is_pinned_guard;
                                is_pinned = *is_pinned_guard;
                            }

                            // Update menu item text
                            let pin_text = if is_pinned { "取消钉住" } else { "钉住窗口" };
                            let _ = pin_i_clone.set_text(pin_text);

                            // Update window behavior
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.set_always_on_top(is_pinned);
                                // Emit event to frontend
                                let _ = window.emit("pin-state-changed", is_pinned);

                                if is_pinned {
                                    // Fix: Ensure window is in correct position before pinning
                                    let _ = window.move_window(Position::BottomRight);
                                    if let Ok(pos) = window.outer_position() {
                                        let new_pos = tauri::PhysicalPosition {
                                            x: pos.x - 16,
                                            y: pos.y - 48,
                                        };
                                        let _ = window.set_position(new_pos);
                                    }
                                    
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        "reset" => {
                            if let Some(window) = app.get_webview_window("main") {
                                // 1. Reset Size
                                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                                    width: 400.0,
                                    height: 600.0,
                                }));

                                // 2. Move to Bottom-Right (Tray Area)
                                if let Ok(Some(monitor)) = window.current_monitor() {
                                    let screen_size = monitor.size();
                                    let scale_factor = monitor.scale_factor();

                                    let screen_w = screen_size.width as f64 / scale_factor;
                                    let screen_h = screen_size.height as f64 / scale_factor;

                                    // Calculate position: Bottom-Right with margin
                                    let new_x = screen_w - 400.0 - 20.0;
                                    let new_y = screen_h - 600.0 - 50.0; // 50px for taskbar safety

                                    let _ = window.set_position(tauri::Position::Logical(
                                        tauri::LogicalPosition { x: new_x, y: new_y },
                                    ));
                                }

                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let state = app.state::<AppState>();
                        let now = now_millis();
                        let mut last = state.last_toggle_time.lock().unwrap();
                        if now - *last < 300 {
                            return;
                        }
                        *last = now;

                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.move_window(Position::BottomRight);
                            if let Ok(pos) = window.outer_position() {
                                let new_pos = tauri::PhysicalPosition {
                                    x: pos.x - 16,
                                    y: pos.y - 48,
                                };
                                let _ = window.set_position(new_pos);
                            }
                            let is_visible = window.is_visible().unwrap_or(false);
                            let is_focused = window.is_focused().unwrap_or(false);
                            if is_visible && is_focused {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                if *focused {
                    let state = window.state::<AppState>();
                    {
                        if let Ok(mut last_time) = state.last_toggle_time.lock() {
                            *last_time = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis();
                        };
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            set_pin_mode,
            save_content,
            load_content,
            check_hide_on_leave,
            frontend_unpin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
