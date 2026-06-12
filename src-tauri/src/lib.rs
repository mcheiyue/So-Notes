use std::{
    fs,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};
use tokio::sync;

mod attachments;
pub mod backup;
mod persistence;
pub mod webdav;

struct AppState {
    is_pinned: Mutex<bool>,
    last_toggle_time: Mutex<u128>,
    pin_menu_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    tray_icon: Mutex<Option<TrayIcon<tauri::Wry>>>,
    global_shortcut_error: Mutex<Option<String>>,
    queue: persistence::IntentQueue,
    rx: Arc<sync::Mutex<sync::mpsc::UnboundedReceiver<persistence::WriteIntent>>>,
}

#[tauri::command]
fn set_pin_mode(state: tauri::State<AppState>, pinned: bool) {
    if let Ok(mut is_pinned) = state.is_pinned.lock() {
        *is_pinned = pinned;
    }
}

#[tauri::command]
fn get_pin_mode(state: tauri::State<AppState>) -> bool {
    state.is_pinned.lock().map(|p| *p).unwrap_or(false)
}

#[tauri::command]
fn get_global_shortcut_error(state: tauri::State<AppState>) -> Option<String> {
    state
        .global_shortcut_error
        .lock()
        .ok()
        .and_then(|error| error.clone())
}

#[tauri::command]
fn set_tray_tooltip(state: tauri::State<AppState>, tooltip: String) -> Result<(), String> {
    let tray_icon = state
        .tray_icon
        .lock()
        .map_err(|_| "托盘状态不可用".to_string())?
        .clone();

    if let Some(tray_icon) = tray_icon {
        tray_icon
            .set_tooltip(Some(tooltip))
            .map_err(|error| error.to_string())
    } else {
        Err("托盘图标尚未初始化".to_string())
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

fn position_window_near_tray(window: &WebviewWindow) {
    let _ = window.move_window(Position::BottomRight);
    if let Ok(pos) = window.outer_position() {
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let new_pos = tauri::PhysicalPosition {
            x: pos.x - (16.0 * scale_factor).round() as i32,
            y: pos.y - (48.0 * scale_factor).round() as i32,
        };
        let _ = window.set_position(new_pos);
    }
}

fn show_window_near_tray(window: &WebviewWindow) {
    let _ = window.unminimize();
    position_window_near_tray(window);
    let _ = window.show();
    let _ = window.set_focus();
}

fn emit_main_window(app: &tauri::AppHandle, event: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_minimized = window.is_minimized().unwrap_or(false);
        if is_visible && !is_minimized {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            show_window_near_tray(&window);
        }
        let _ = window.emit(event, ());
    }
}

fn emit_main_window_without_show(app: &tauri::AppHandle, event: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(event, ());
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;

    show_window_near_tray(&window);
    Ok(())
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
    state: tauri::State<'_, AppState>,
    filename: String,
    content: String,
    generation_id: u64,
) -> Result<persistence::WriteAck, String> {
    let doc_dir = app.path().document_dir().map_err(|e| e.to_string())?;
    let app_dir = doc_dir.join("SoNotes");
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    }
    let file_path = app_dir.join(&filename);
    state
        .queue
        .submit_save(content, file_path, generation_id)
        .await
}

#[tauri::command]
fn check_hide_on_leave(window: tauri::Window, state: tauri::State<AppState>) {
    let is_pinned = state.is_pinned.lock().map(|p| *p).unwrap_or(false);
    if !is_pinned {
        if any_detached_window_focused(window.app_handle()) {
            return;
        }
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

fn detached_note_label(note_id: &str) -> String {
    format!("detached-note-{note_id}")
}

/// 判断窗口 label 是否属于 SoNotes 撕下便签窗口
fn is_detached_note_label(label: &str) -> bool {
    label.starts_with("detached-note-")
}

/// 检查是否有任一撕下便签窗口当前持有 OS 焦点
fn any_detached_window_focused(app: &tauri::AppHandle) -> bool {
    app.webview_windows().iter().any(|(label, window)| {
        is_detached_note_label(label) && window.is_focused().unwrap_or(false)
    })
}

fn restore_detached_note_window(
    window: &WebviewWindow,
    keep_always_on_top: bool,
) -> Result<(), String> {
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    window
        .show()
        .map_err(|e| format!("显示撕下窗口失败: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("聚焦撕下窗口失败: {e}"))?;

    if !keep_always_on_top {
        let window_for_restore = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = window_for_restore.set_always_on_top(false);
        });
    }

    Ok(())
}

#[tauri::command]
async fn open_detached_note_window(
    app: tauri::AppHandle,
    note_id: String,
    spawn_x: Option<f64>,
    spawn_y: Option<f64>,
    keep_always_on_top: Option<bool>,
) -> Result<(), String> {
    let label = detached_note_label(&note_id);

    if let Some(window) = app.get_webview_window(&label) {
        restore_detached_note_window(&window, keep_always_on_top.unwrap_or(false))?;
        return Ok(());
    }

    let detached_url = format!("detached.html?noteId={}", note_id);
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(detached_url.into()))
        .title("SoNotes - 便签")
        .inner_size(260.0, 280.0)
        .min_inner_size(260.0, 100.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(true)
        .visible(false)
        .skip_taskbar(true);

    if let (Some(sx), Some(sy)) = (spawn_x, spawn_y) {
        if let Some(main_win) = app.get_webview_window("main") {
            if let Ok(main_pos) = main_win.outer_position() {
                let sf = main_win.scale_factor().unwrap_or(1.0);
                let mut abs_x = main_pos.x as f64 / sf + sx;
                let mut abs_y = main_pos.y as f64 / sf + sy;

                if let Ok(Some(monitor)) = main_win.current_monitor() {
                    let monitor_sf = monitor.scale_factor();
                    let monitor_pos = monitor.position();
                    let monitor_size = monitor.size();
                    let min_x = monitor_pos.x as f64 / monitor_sf + 8.0;
                    let min_y = monitor_pos.y as f64 / monitor_sf + 8.0;
                    let max_x = min_x + monitor_size.width as f64 / monitor_sf - 260.0 - 16.0;
                    let max_y = min_y + monitor_size.height as f64 / monitor_sf - 280.0 - 16.0;
                    abs_x = abs_x.clamp(min_x, max_x.max(min_x));
                    abs_y = abs_y.clamp(min_y, max_y.max(min_y));
                }

                builder = builder.position(abs_x, abs_y);
            }
        }
    }

    let window = builder
        .build()
        .map_err(|e| format!("创建撕下窗口失败: {e}"))?;

    restore_detached_note_window(&window, keep_always_on_top.unwrap_or(false))?;

    Ok(())
}

#[tauri::command]
async fn show_detached_note_window(
    app: tauri::AppHandle,
    note_id: String,
    keep_always_on_top: Option<bool>,
) -> Result<(), String> {
    let label = detached_note_label(&note_id);

    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("撕下窗口 {label} 不存在"))?;

    restore_detached_note_window(&window, keep_always_on_top.unwrap_or(false))
}

#[tauri::command]
async fn close_detached_note_window(app: tauri::AppHandle, note_id: String) -> Result<(), String> {
    let label = detached_note_label(&note_id);

    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|e| format!("关闭撕下窗口失败: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn set_detached_note_always_on_top(
    app: tauri::AppHandle,
    note_id: String,
    always_on_top: bool,
) -> Result<bool, String> {
    let label = detached_note_label(&note_id);

    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("撕下窗口 {label} 不存在"))?;

    window
        .set_always_on_top(always_on_top)
        .map_err(|e| format!("设置置顶失败: {e}"))?;

    Ok(always_on_top)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .setup(|app| {
            // 初始化系统密钥链存储（跨平台）
            if let Err(e) = keyring::use_native_store(false) {
                eprintln!("初始化系统密钥链失败: {e}");
            }

            let (queue, rx) = persistence::IntentQueue::new();
            app.manage(AppState {
                is_pinned: Mutex::new(false),
                last_toggle_time: Mutex::new(0),
                pin_menu_item: Mutex::new(None),
                tray_icon: Mutex::new(None),
                global_shortcut_error: Mutex::new(None),
                queue,
                rx,
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let rx = state.rx.clone();
                persistence::IntentQueue::consumer_loop(rx).await;
            });

            if let Err(error) = webdav::cleanup_webdav_temp_files(app.handle()) {
                eprintln!("WebDAV 临时文件清理失败：{error}");
            }

            let quick_capture_shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
            let toggle_window_shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS);
            if let Err(error) = app.global_shortcut().on_shortcuts(
                [quick_capture_shortcut, toggle_window_shortcut],
                move |app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyN) {
                        emit_main_window(app, "open-quick-capture");
                        return;
                    }

                    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyS) {
                        if let Some(window) = app.get_webview_window("main") {
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                show_window_near_tray(&window);
                            }
                        }
                    }
                },
            ) {
                let message = format!("全局快捷键注册失败：{error}");
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut global_shortcut_error) = state.global_shortcut_error.lock() {
                        *global_shortcut_error = Some(message.clone());
                    }
                }

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("global-shortcut-register-failed", message);
                }
            }

            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let pin_i = MenuItem::with_id(app, "pin", "钉住窗口", true, None::<&str>)?;

            // Store the pin menu item in AppState
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut guard) = state.pin_menu_item.lock() {
                    *guard = Some(pin_i.clone());
                }
            }

            let quick_capture_i =
                MenuItem::with_id(app, "quick_capture", "快速捕获", true, None::<&str>)?;
            let clipboard_note_i = MenuItem::with_id(
                app,
                "clipboard_note",
                "从剪贴板创建便签",
                true,
                None::<&str>,
            )?;
            let new_note_i =
                MenuItem::with_id(app, "new_note", "新建空白便签", true, None::<&str>)?;
            let show_detached_notes_i = MenuItem::with_id(
                app,
                "show_detached_notes",
                "显示所有悬浮便签",
                true,
                None::<&str>,
            )?;
            let reset_i = MenuItem::with_id(app, "reset", "重置窗口", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &pin_i,
                    &show_detached_notes_i,
                    &quick_capture_i,
                    &clipboard_note_i,
                    &new_note_i,
                    &reset_i,
                    &quit_i,
                ],
            )?;

            // 克隆 MenuItem 句柄以便在事件闭包中使用
            let pin_i_clone = pin_i.clone();

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SoNotes")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "pin" => {
                            let state = app.state::<AppState>();
                            let is_pinned = {
                                let mut is_pinned_guard = state.is_pinned.lock().unwrap();
                                *is_pinned_guard = !*is_pinned_guard;
                                *is_pinned_guard
                            };

                            // Update menu item text
                            let pin_text = if is_pinned {
                                "取消钉住"
                            } else {
                                "钉住窗口"
                            };
                            let _ = pin_i_clone.set_text(pin_text);

                            // Update window behavior
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.set_always_on_top(is_pinned);
                                // Emit event to frontend
                                let _ = window.emit("pin-state-changed", is_pinned);

                                if is_pinned {
                                    show_window_near_tray(&window);
                                }
                            }
                        }
                        "quick_capture" => emit_main_window(app, "open-quick-capture"),
                        "clipboard_note" => emit_main_window(app, "create-note-from-clipboard"),
                        "new_note" => emit_main_window(app, "tray-new-note"),
                        "show_detached_notes" => {
                            emit_main_window_without_show(app, "detached-note:show-all")
                        }
                        "reset" => {
                            if let Some(window) = app.get_webview_window("main") {
                                // Emit reset-viewport event to frontend
                                let _ = window.emit("reset-viewport", ());

                                // 1. Reset Size
                                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                                    width: 400.0,
                                    height: 600.0,
                                }));

                                // 2. Move to Bottom-Right (Tray Area)
                                if let Ok(Some(monitor)) = window.current_monitor() {
                                    let screen_size = monitor.size();
                                    let scale_factor = monitor.scale_factor();
                                    let monitor_pos = monitor.position();

                                    let screen_w = screen_size.width as f64 / scale_factor;
                                    let screen_h = screen_size.height as f64 / scale_factor;
                                    let offset_x = monitor_pos.x as f64 / scale_factor;
                                    let offset_y = monitor_pos.y as f64 / scale_factor;

                                    let new_x = offset_x + screen_w - 400.0 - 20.0;
                                    let new_y = offset_y + screen_h - 600.0 - 50.0;

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
                            let is_visible = window.is_visible().unwrap_or(false);
                            if is_visible {
                                let _ = window.hide();
                            } else {
                                show_window_near_tray(&window);
                            }
                        }
                    }
                })
                .build(app)?;

            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut tray_icon) = state.tray_icon.lock() {
                    *tray_icon = Some(tray);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();

            // 撕下窗口销毁时通知主窗口清理运行态映射
            if is_detached_note_label(label) {
                if let WindowEvent::Destroyed = event {
                    if let Some(note_id) = label.strip_prefix("detached-note-") {
                        if let Some(main_window) = window.app_handle().get_webview_window("main") {
                            let _ = main_window.emit(
                                "detached-note:closed",
                                serde_json::json!({ "noteId": note_id }),
                            );
                        }
                    }
                }
                return;
            }

            if label != "main" {
                return;
            }
            if let WindowEvent::Focused(focused) = event {
                let state = window.state::<AppState>();
                if *focused {
                    if let Ok(mut last_time) = state.last_toggle_time.lock() {
                        *last_time = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis();
                    };
                } else {
                    let is_pinned = state.is_pinned.lock().map(|p| *p).unwrap_or(false);
                    if !is_pinned {
                        let window_handle = window.clone();
                        let app_handle = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                            if any_detached_window_focused(&app_handle) {
                                return;
                            }
                            if let Ok(false) = window_handle.is_focused() {
                                let _ = window_handle.hide();
                            }
                        });
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            set_pin_mode,
            get_pin_mode,
            get_global_shortcut_error,
            set_tray_tooltip,
            show_main_window,
            save_content,
            load_content,
            check_hide_on_leave,
            frontend_unpin,
            open_detached_note_window,
            show_detached_note_window,
            close_detached_note_window,
            set_detached_note_always_on_top,
            attachments::write_attachment_from_path,
            attachments::write_attachment_from_bytes,
            attachments::attachment_exists,
            attachments::read_attachment_metadata,
            attachments::save_image_from_system_clipboard,
            attachments::resolve_attachment_path,
            attachments::list_attachment_files,
            attachments::delete_attachment_file,
            backup::create_local_backup,
            backup::restore_local_backup,
            backup::validate_local_backup,
            webdav::webdav_load_config,
            webdav::webdav_save_config,
            webdav::webdav_clear_config,
            webdav::webdav_test_connection,
            webdav::webdav_list_backups,
            webdav::webdav_delete_backup,
            webdav::webdav_create_remote_backup,
            webdav::webdav_download_backup,
            webdav::resolve_downloaded_backup,
            webdav::cleanup_downloaded_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
