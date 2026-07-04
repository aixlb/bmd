#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            // 窗口质感（DESIGN.md D9）：macOS vibrancy；Windows 仅 Win11 Mica，
            // 失败静默降级为纯色背景。
            #[cfg(target_os = "macos")]
            window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::Sidebar,
                None,
                None,
            )
            .ok();

            #[cfg(target_os = "windows")]
            window_vibrancy::apply_mica(&window, None).ok();

            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running bmd");
}
