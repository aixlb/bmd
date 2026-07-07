// HTML 文件只读预览：
// 前端打开 .html/.htm 标签时调用 register_html_preview 换取预览 URL，
// 主窗口 iframe 经 bmdpreview:// 自定义协议加载磁盘上的 HTML。
// 文件内的相对资源（图片 / CSS / JS / 字体等）以文档目录为基准解析，
// 扩展名白名单服务；每次请求都从磁盘现读，外部修改后 iframe 重载即生效。
// 与 pdf.rs 相同：Windows 下 wry 把协议映射为 http://bmdpreview.localhost/…，
// 两平台处理器看到的 URI path 一致：/<id>/index.html 或 /<id>/<相对资源>。

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::Manager;

use crate::pdf::{image_mime, parse_request_path, resolve_asset, resp};

pub const PROTOCOL: &str = "bmdpreview";

#[derive(Default)]
pub struct PreviewState {
    /// id → 已注册的 HTML 文件绝对路径
    files: Mutex<HashMap<u64, PathBuf>>,
    next_id: AtomicU64,
}

/// 注册待预览的文件（HTML 或图片），返回 iframe/<img> 可直接加载的 URL。
/// 同一路径重复注册复用同一 id（会话内常驻，代价可忽略）。
#[tauri::command]
pub fn register_html_preview<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.is_file() {
        return Err(format!("无效的预览路径: {path}"));
    }
    let ext = main_ext(&p);
    let state = app.state::<PreviewState>();
    let mut files = state.files.lock().unwrap();
    let id = match files.iter().find(|(_, v)| **v == p) {
        Some((k, _)) => *k,
        None => {
            let id = state.next_id.fetch_add(1, Ordering::Relaxed);
            files.insert(id, p);
            id
        }
    };
    Ok(preview_url(id, &ext))
}

/// 主文件在 URL 中的扩展名（决定协议端回什么 MIME；未知扩展按 html 兜底）
fn main_ext(p: &std::path::Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "html".into())
}

/// 平台差异见文件头注释：Windows 走 wry 的 http://<scheme>.localhost 映射
fn preview_url(id: u64, ext: &str) -> String {
    if cfg!(windows) {
        format!("http://{PROTOCOL}.localhost/{id}/index.{ext}")
    } else {
        format!("{PROTOCOL}://localhost/{id}/index.{ext}")
    }
}

pub fn handle_protocol<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path().to_owned();
    let Some((id, rest)) = parse_request_path(&path) else {
        return resp(404, "text/plain", b"bad path".to_vec());
    };
    let file = {
        let state = ctx.app_handle().state::<PreviewState>();
        let files = state.files.lock().unwrap();
        files.get(&id).cloned()
    };
    let Some(file) = file else {
        return resp(404, "text/plain", b"unknown preview".to_vec());
    };
    // 主文件（index.<ext>）：现读磁盘，外部修改后重载即最新；MIME 按扩展名
    if rest == format!("index.{}", main_ext(&file)) {
        let mime = asset_mime(rest).unwrap_or("text/html; charset=utf-8");
        return match std::fs::read(&file) {
            Ok(bytes) => resp(200, mime, bytes),
            Err(_) => resp(404, "text/plain", b"not found".to_vec()),
        };
    }
    // 相对资源：扩展名白名单 + 仅相对路径（resolve_asset 拒绝绝对路径）
    let Some(mime) = asset_mime(rest) else {
        return resp(404, "text/plain", b"unsupported resource".to_vec());
    };
    let Some(base) = file.parent() else {
        return resp(404, "text/plain", b"no base dir".to_vec());
    };
    match resolve_asset(base, rest).and_then(|f| std::fs::read(f).ok()) {
        Some(bytes) => resp(200, mime, bytes),
        None => resp(404, "text/plain", b"not found".to_vec()),
    }
}

/// 预览可服务的资源类型：图片沿用 pdf.rs 的表，另加网页常见文本/字体资源
fn asset_mime(path: &str) -> Option<&'static str> {
    if let Some(m) = image_mime(path) {
        return Some(m);
    }
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_mime_table() {
        assert_eq!(asset_mime("a/b.CSS"), Some("text/css; charset=utf-8"));
        assert_eq!(asset_mime("x.js"), Some("text/javascript; charset=utf-8"));
        assert_eq!(asset_mime("x.woff2"), Some("font/woff2"));
        assert_eq!(asset_mime("p.png"), Some("image/png"));
        assert_eq!(asset_mime("x.exe"), None);
        assert_eq!(asset_mime("noext"), None);
    }

    #[test]
    fn preview_url_shape() {
        let url = preview_url(7, "html");
        #[cfg(windows)]
        assert_eq!(url, "http://bmdpreview.localhost/7/index.html");
        #[cfg(not(windows))]
        assert_eq!(url, "bmdpreview://localhost/7/index.html");
        // 图片主文件：URL 带真实扩展名，协议端按扩展回 MIME
        let img = preview_url(3, "png");
        assert!(img.ends_with("/3/index.png"));
    }

    #[test]
    fn main_ext_fallback() {
        assert_eq!(main_ext(std::path::Path::new("C:/a/b.PNG")), "png");
        assert_eq!(main_ext(std::path::Path::new("C:/a/页面.html")), "html");
        assert_eq!(main_ext(std::path::Path::new("C:/a/noext")), "html");
    }
}
