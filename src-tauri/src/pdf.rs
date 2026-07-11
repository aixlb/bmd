// PDF V2 静默导出（DESIGN.md D8 V2）
//
// 流程：前端把自包含导出 HTML 交给 export_pdf 命令 → 注册到 PdfState →
// 隐藏窗口经 bmdexport:// 自定义协议加载（文档目录里的相对图片也由协议按需服务）→
// 页面加载完成后走平台原生 API 出 PDF：
//   - macOS：WKWebView printOperationWithPrintInfo + NSPrintSaveJob（分页由打印管线负责）
//   - Windows：ICoreWebView2_7::PrintToPdf
// 自定义协议经 wry 的 workaround 在 Windows 映射为 http://bmdexport.localhost/…，
// 处理器两平台看到的 URI path 一致：/<id>/index.html 或 /<id>/<相对资源>。

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

pub const PROTOCOL: &str = "bmdexport";

#[derive(Default)]
pub struct PdfState {
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
}

struct Pending {
    html: String,
    /// 文档所在目录：导出 HTML 中相对路径图片的解析基准
    base_dir: Option<PathBuf>,
}

// ---------- 自定义协议 ----------

pub fn handle_protocol<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let path = request.uri().path().to_owned();
    let Some((id, rest)) = parse_request_path(&path) else {
        return resp(404, "text/plain", b"bad path".to_vec());
    };
    let state = ctx.app_handle().state::<PdfState>();
    let pending = state.pending.lock().unwrap();
    let Some(p) = pending.get(&id) else {
        return resp(404, "text/plain", b"unknown export".to_vec());
    };
    if rest == "index.html" {
        return resp(200, "text/html; charset=utf-8", p.html.clone().into_bytes());
    }
    // 相对资源：仅图片，按文档目录解析
    let Some(mime) = image_mime(rest) else {
        return resp(404, "text/plain", b"unsupported resource".to_vec());
    };
    let Some(base) = &p.base_dir else {
        return resp(404, "text/plain", b"no base dir".to_vec());
    };
    match resolve_asset(base, rest).and_then(|f| std::fs::read(f).ok()) {
        Some(bytes) => resp(200, mime, bytes),
        None => resp(404, "text/plain", b"not found".to_vec()),
    }
}

pub(crate) fn resp(
    status: u16,
    mime: &str,
    body: Vec<u8>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", mime)
        .body(Cow::Owned(body))
        .unwrap()
}

/// "/<id>/<rest>" → (id, rest)；空 rest 视为 index.html
pub(crate) fn parse_request_path(path: &str) -> Option<(u64, &str)> {
    let mut it = path.trim_start_matches('/').splitn(2, '/');
    let id = it.next()?.parse::<u64>().ok()?;
    let rest = it.next().unwrap_or("");
    Some((id, if rest.is_empty() { "index.html" } else { rest }))
}

/// 路径上下文的百分号解码（不把 '+' 当空格）
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            let hi = (hex[0] as char).to_digit(16)?;
            let lo = (hex[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 与编辑器一致：允许 ../ 引用工作区外资源，但只服务真实存在的文件
pub(crate) fn resolve_asset(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = percent_decode(rel)?;
    if Path::new(&rel).is_absolute() {
        return None;
    }
    let target = base.join(rel).canonicalize().ok()?;
    target.is_file().then_some(target)
}

pub(crate) fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        _ => return None,
    })
}

// ---------- 导出命令 ----------

#[tauri::command]
pub async fn export_pdf<R: Runtime>(
    app: AppHandle<R>,
    html: String,
    base_dir: Option<String>,
    out_path: String,
) -> Result<(), String> {
    export_html_to_pdf(app, html, base_dir.map(PathBuf::from), PathBuf::from(out_path)).await
}

pub async fn export_html_to_pdf<R: Runtime>(
    app: AppHandle<R>,
    html: String,
    base_dir: Option<PathBuf>,
    out_path: PathBuf,
) -> Result<(), String> {
    let state = app.state::<PdfState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state
        .pending
        .lock()
        .unwrap()
        .insert(id, Pending { html, base_dir });

    let result = run_export(&app, id, &out_path).await;

    app.state::<PdfState>().pending.lock().unwrap().remove(&id);
    if let Some(w) = app.get_webview_window(&format!("pdf-export-{id}")) {
        let _ = w.destroy();
    }
    result
}

async fn run_export<R: Runtime>(app: &AppHandle<R>, id: u64, out_path: &Path) -> Result<(), String> {
    // 覆盖语义；完成检测依赖文件出现，先清掉旧文件
    if out_path.exists() {
        std::fs::remove_file(out_path).map_err(|e| format!("无法覆盖目标文件：{e}"))?;
    }

    let (load_tx, load_rx) = tokio::sync::oneshot::channel::<()>();
    let load_tx = Mutex::new(Some(load_tx));
    let url: tauri::Url = format!("{PROTOCOL}://localhost/{id}/index.html")
        .parse()
        .map_err(|e| format!("导出 URL 非法：{e}"))?;

    let window = tauri::WebviewWindowBuilder::new(
        app,
        format!("pdf-export-{id}"),
        tauri::WebviewUrl::CustomProtocol(url),
    )
    .title("导出 PDF")
    .inner_size(860.0, 1100.0)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .on_page_load(move |_w, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            if let Some(tx) = load_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })
    .build()
    .map_err(|e| format!("创建导出窗口失败：{e}"))?;

    tokio::time::timeout(Duration::from_secs(20), load_rx)
        .await
        .map_err(|_| "导出页面加载超时".to_string())?
        .map_err(|_| "导出窗口提前关闭".to_string())?;
    // 与 V1 打印管线相同的布局等待：样式 / 内嵌 SVG / 字体 settle
    tokio::time::sleep(Duration::from_millis(500)).await;

    platform_print(&window, out_path).await
}

/// 轮询等待打印管线写完产物（macOS NSPrintOperation 无委托时的完成信号）
#[cfg(target_os = "macos")]
async fn wait_for_file(path: &Path, timeout: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut last_len = 0u64;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        let len = meta.len();
        if len > 0 && len == last_len {
            return Ok(());
        }
        last_len = len;
    }
    Err("导出超时：未生成 PDF".to_string())
}

// ---------- macOS：WKWebView printOperation → NSPrintSaveJob ----------

#[cfg(target_os = "macos")]
async fn platform_print<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    out_path: &Path,
) -> Result<(), String> {
    let out_s = out_path.to_string_lossy().into_owned();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            let r = unsafe { mac_start_print(wv.inner(), wv.ns_window(), &out_s) };
            let _ = tx.send(r);
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "打印启动超时".to_string())?
        .map_err(|_| "打印回调丢失".to_string())??;
    wait_for_file(out_path, Duration::from_secs(60)).await
}

#[cfg(target_os = "macos")]
unsafe fn mac_start_print(
    webview: *mut std::ffi::c_void,
    ns_window: *mut std::ffi::c_void,
    out_path: &str,
) -> Result<(), String> {
    use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
    use objc2::sel;
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow,
    };
    use objc2_foundation::{NSString, NSURL};
    use objc2_web_kit::WKWebView;

    let wk: &WKWebView = &*webview.cast::<WKWebView>();
    let win: &NSWindow = &*ns_window.cast::<NSWindow>();

    // printOperationWithPrintInfo: 需要 macOS 11+
    if !wk.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
        return Err("静默导出 PDF 需要 macOS 11 或更高".to_string());
    }

    let info = NSPrintInfo::new();
    info.setJobDisposition(NSPrintSaveJob);
    let url = NSURL::fileURLWithPath(&NSString::from_str(out_path));
    let url_any: &AnyObject = &url;
    info.dictionary()
        .setObject_forKey(url_any, ProtocolObject::from_ref(NSPrintJobSavingURL));
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticallyCentered(false);
    info.setTopMargin(36.0);
    info.setBottomMargin(36.0);
    info.setLeftMargin(36.0);
    info.setRightMargin(36.0);

    let op = wk.printOperationWithPrintInfo(&info);
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    // 已知怪癖：打印视图 frame 必须非零，否则输出空白
    match op.view() {
        Some(view) => view.setFrame(wk.bounds()),
        None => return Err("打印操作无渲染视图".to_string()),
    }
    // 无委托：完成与否由调用方轮询产物文件
    op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
        win,
        None,
        None,
        std::ptr::null_mut(),
    );
    Ok(())
}

// ---------- Windows：ICoreWebView2_7::PrintToPdf ----------

#[cfg(windows)]
async fn platform_print<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    out_path: &Path,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_7;
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::Interface;

    let out_s = out_path.to_string_lossy().into_owned();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            let start = (|| -> Result<(), String> {
                let core = unsafe { wv.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
                let wv7: ICoreWebView2_7 = core.cast().map_err(|e| e.to_string())?;
                let path = windows_core::HSTRING::from(out_s.as_str());
                let done_tx = tx.clone();
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |ec, ok| {
                    let r = match (ec, ok) {
                        (Ok(()), true) => Ok(()),
                        (Ok(()), false) => Err("PrintToPdf 报告失败".to_string()),
                        (Err(e), _) => Err(e.to_string()),
                    };
                    let _ = done_tx.send(r);
                    Ok(())
                }));
                unsafe { wv7.PrintToPdf(&path, None, &handler) }.map_err(|e| e.to_string())
            })();
            if let Err(e) = start {
                let _ = tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(90), rx.recv())
        .await
        .map_err(|_| "导出超时：未生成 PDF".to_string())?
        .ok_or_else(|| "打印回调丢失".to_string())?
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn platform_print<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _out_path: &Path,
) -> Result<(), String> {
    Err("当前平台暂不支持静默导出 PDF".to_string())
}

// ---------- 冒烟样例（BMD_PDF_SMOKE） ----------

/// 覆盖分页（多页正文）与基本排版的最小样例
pub fn smoke_html() -> String {
    let mut body = String::from("<h1>bmd PDF 冒烟</h1>");
    for i in 1..=90 {
        body.push_str(&format!(
            "<p>第 {i} 段：静默导出验证正文。这一段足够长，用来撑出跨页分页效果，\
             同时检查中文排版、标点悬挂与行高是否正常。The quick brown fox jumps over the lazy dog.</p>"
        ));
    }
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <title>smoke</title><style>body{{font:16px/1.75 -apple-system,sans-serif;margin:0;}} \
         h1{{break-after:avoid;}}</style></head><body>{body}</body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_path_parsing() {
        assert_eq!(parse_request_path("/3/index.html"), Some((3, "index.html")));
        assert_eq!(parse_request_path("/3"), Some((3, "index.html")));
        assert_eq!(parse_request_path("/3/"), Some((3, "index.html")));
        assert_eq!(
            parse_request_path("/12/assets/%E5%9B%BE.png"),
            Some((12, "assets/%E5%9B%BE.png"))
        );
        assert_eq!(parse_request_path("/abc/x.png"), None);
        assert_eq!(parse_request_path("/"), None);
    }

    #[test]
    fn percent_decode_paths() {
        assert_eq!(percent_decode("a+b/c.png").as_deref(), Some("a+b/c.png"));
        assert_eq!(percent_decode("%E5%9B%BE.png").as_deref(), Some("图.png"));
        assert_eq!(percent_decode("bad%zz"), None);
    }

    #[test]
    fn asset_resolution_guards() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir(base.join("assets")).unwrap();
        std::fs::write(base.join("assets/a.png"), b"x").unwrap();

        assert!(resolve_asset(base, "assets/a.png").is_some());
        assert!(resolve_asset(base, "assets/missing.png").is_none());
        // 绝对路径拒绝；目录不是文件
        assert!(resolve_asset(base, "/etc/hosts").is_none());
        assert!(resolve_asset(base, "assets").is_none());
    }

    #[test]
    fn image_mime_table() {
        assert_eq!(image_mime("a/b.PNG"), Some("image/png"));
        assert_eq!(image_mime("x.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime("x.exe"), None);
        assert_eq!(image_mime("noext"), None);
    }
}
