#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod commands;
mod pdf;
mod preview;
mod rag;
mod watcher;

use tauri::Manager;

/// 启动参数里的文件路径（Windows/Linux「打开方式」）
#[tauri::command]
fn initial_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // 不恢复 DECORATIONS：Windows 无边框由配置决定，避免旧状态把原生标题栏带回来
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .manage(watcher::WatchState::default())
        .manage(pdf::PdfState::default())
        .manage(preview::PreviewState::default())
        .register_uri_scheme_protocol(pdf::PROTOCOL, pdf::handle_protocol)
        .register_uri_scheme_protocol(preview::PROTOCOL, preview::handle_protocol)
        .invoke_handler(tauri::generate_handler![
            commands::scan_dir,
            commands::search_text,
            commands::read_doc,
            commands::write_doc_atomic,
            commands::create_entry,
            commands::rename_entry,
            commands::trash_entry,
            commands::reveal_in_os,
            commands::canon_in_root,
            commands::load_session,
            commands::save_session,
            commands::save_pasted_image,
            watcher::start_watch,
            watcher::stop_watch,
            initial_files,
            ai::set_api_key,
            ai::has_api_key,
            ai::ai_chat,
            ai::ai_cancel,
            ai::load_chats,
            ai::save_chats,
            rag::rag_index,
            rag::rag_search,
            pdf::export_pdf,
            preview::register_html_preview,
        ])
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
            {
                // 双保险：无论旧窗口状态如何，Windows 一律无边框（标题栏由前端自绘）
                window.set_decorations(false).ok();
                window_vibrancy::apply_mica(&window, None).ok();
            }

            let _ = window;

            // 本机冒烟：BMD_PDF_SMOKE=/path/out.pdf 走完整静默导出链路后退出
            if let Ok(out) = std::env::var("BMD_PDF_SMOKE") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let r =
                        pdf::export_html_to_pdf(handle.clone(), pdf::smoke_html(), None, out.into())
                            .await;
                    match r {
                        Ok(()) => {
                            eprintln!("BMD_PDF_SMOKE: ok");
                            handle.exit(0);
                        }
                        Err(e) => {
                            eprintln!("BMD_PDF_SMOKE: failed: {e}");
                            handle.exit(1);
                        }
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building bmd")
        .run(|app, event| {
            // macOS「打开方式」/ 拖到 Dock 图标（FR-24）
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                use tauri::Emitter;
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    let _ = app.emit("open-file", paths);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}
