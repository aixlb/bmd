use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_md: bool,
    /** 已知文本扩展或内容探测为文本；未知二进制为 false。 */
    pub is_text: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPayload {
    pub content: String,
    pub mtime_ms: u64,
    pub encoding: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub root: Option<String>,
    pub open_paths: Vec<String>,
    pub active: Option<usize>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn mtime_ms(path: &Path) -> Result<u64, String> {
    let meta = fs::metadata(path).map_err(err)?;
    let mtime = meta.modified().map_err(err)?;
    Ok(mtime.duration_since(UNIX_EPOCH).map_err(err)?.as_millis() as u64)
}

fn lower_ext(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

fn lower_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTypePolicy {
    markdown_extensions: Vec<String>,
    text_extensions: Vec<String>,
    text_names: Vec<String>,
    html_extensions: Vec<String>,
    image_extensions: Vec<String>,
}

fn file_type_policy() -> &'static FileTypePolicy {
    static POLICY: OnceLock<FileTypePolicy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/file-types.json"))
            .expect("shared/file-types.json 必须是合法策略")
    })
}

fn is_markdown(path: &Path) -> bool {
    lower_ext(path).is_some_and(|ext| file_type_policy().markdown_extensions.contains(&ext))
}

fn is_plain_text(path: &Path) -> bool {
    lower_name(path).is_some_and(|name| file_type_policy().text_names.contains(&name))
        || lower_ext(path).is_some_and(|ext| file_type_policy().text_extensions.contains(&ext))
}

fn is_html(path: &Path) -> bool {
    lower_ext(path).is_some_and(|ext| file_type_policy().html_extensions.contains(&ext))
}

fn is_image(path: &Path) -> bool {
    lower_ext(path).is_some_and(|ext| file_type_policy().image_extensions.contains(&ext))
}

pub(crate) fn is_known_text_path(path: &Path) -> bool {
    is_markdown(path) || is_plain_text(path) || is_html(path)
}

fn looks_like_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return true;
    }
    if bytes.contains(&0) {
        return false;
    }
    let controls = bytes
        .iter()
        .filter(|&&b| b < 0x09 || (b > 0x0D && b < 0x20))
        .count();
    controls * 100 <= bytes.len().max(1)
}

fn is_text_file(path: &Path) -> bool {
    if is_known_text_path(path) {
        return true;
    }
    if is_image(path) {
        return false;
    }
    use std::io::Read;
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut sample = Vec::with_capacity(8192);
    if file.take(8192).read_to_end(&mut sample).is_err() {
        return false;
    }
    looks_like_text(&sample)
}

fn is_readable_text(path: &Path) -> bool {
    is_known_text_path(path) || is_text_file(path)
}

fn require_abs(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(format!("需要绝对路径: {path}"));
    }
    Ok(p)
}

/// 单层目录扫描：目录在前、文件在后，各自按名称排序（忽略大小写）。
/// 未声明为文本的隐藏文件（.开头）不返回。
#[tauri::command]
pub async fn scan_dir(path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_dir_impl(path))
        .await
        .map_err(err)?
}

fn scan_dir_impl(path: String) -> Result<Vec<Entry>, String> {
    let dir = require_abs(&path)?;
    let mut entries: Vec<Entry> = fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            let is_dir = e.file_type().ok()?.is_dir();
            let is_text = !is_dir && is_text_file(&p);
            let known_hidden_text = !is_dir && is_known_text_path(&p);
            if name.starts_with('.') && !known_hidden_text {
                return None;
            }
            Some(Entry {
                is_md: !is_dir && is_markdown(&p),
                is_text,
                path: p.to_string_lossy().into_owned(),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    /// 首个匹配行（1-based；仅文件名匹配时为 0）
    pub line: u32,
    pub preview: String,
    pub count: u32,
}

#[derive(Default)]
pub struct SearchState {
    latest_requests: Arc<Mutex<HashMap<String, u64>>>,
}

fn register_search_request(latest: &Mutex<HashMap<String, u64>>, scope: &str, request_id: u64) {
    let mut requests = latest.lock().unwrap();
    let current = requests.entry(scope.to_owned()).or_default();
    *current = (*current).max(request_id);
}

fn search_cancelled(latest: &Mutex<HashMap<String, u64>>, scope: &str, request_id: u64) -> bool {
    latest
        .lock()
        .unwrap()
        .get(scope)
        .copied()
        .unwrap_or_default()
        > request_id
}

/// 工作区全文搜索（FR 侧栏搜索）：递归遍历 markdown 与常见文本文件，
/// 大小写不敏感子串匹配文件名与内容。隐藏项跳过，>5MB 文件跳过。
/// 排序：文件名命中优先，其次按内容命中次数降序。
#[tauri::command]
pub async fn search_text(
    state: tauri::State<'_, SearchState>,
    root: String,
    query: String,
    limit: usize,
    request_id: u64,
    scope: String,
) -> Result<Vec<SearchHit>, String> {
    register_search_request(&state.latest_requests, &scope, request_id);
    let latest_requests = Arc::clone(&state.latest_requests);
    tauri::async_runtime::spawn_blocking(move || {
        search_text_impl(root, query, limit, request_id, scope, latest_requests)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn cancel_search(
    state: tauri::State<'_, SearchState>,
    request_id: u64,
    scope: String,
) -> Result<(), String> {
    register_search_request(&state.latest_requests, &scope, request_id);
    Ok(())
}

fn search_text_impl(
    root: String,
    query: String,
    limit: usize,
    request_id: u64,
    scope: String,
    latest_requests: Arc<Mutex<HashMap<String, u64>>>,
) -> Result<Vec<SearchHit>, String> {
    if search_cancelled(&latest_requests, &scope, request_id) {
        return Ok(vec![]);
    }
    let dir = require_abs(&root)?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut hits: Vec<(bool, SearchHit)> = Vec::new();
    let mut stack = vec![dir];
    while let Some(d) = stack.pop() {
        if search_cancelled(&latest_requests, &scope, request_id) {
            return Ok(vec![]);
        }
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.filter_map(|e| e.ok()) {
            if search_cancelled(&latest_requests, &scope, request_id) {
                return Ok(vec![]);
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            let known_hidden_text = !ft.is_dir() && is_known_text_path(&p);
            if name.starts_with('.') && !known_hidden_text {
                continue;
            }
            if ft.is_dir() {
                stack.push(p);
                continue;
            }
            if !is_readable_text(&p) {
                continue;
            }
            if fs::metadata(&p)
                .map(|m| m.len() > 5 * 1024 * 1024)
                .unwrap_or(true)
            {
                continue;
            }
            let name_match = name.to_lowercase().contains(&q);
            let Ok(bytes) = fs::read(&p) else { continue };
            let Ok((content, _)) = decode_text(&bytes) else {
                continue;
            };
            let mut count = 0u32;
            let mut first: Option<(u32, String)> = None;
            for (i, line) in content.lines().enumerate() {
                let ll = line.to_lowercase();
                let mut start = 0;
                while let Some(idx) = ll[start..].find(&q) {
                    count += 1;
                    start += idx + q.len();
                }
                if count > 0 && first.is_none() {
                    first = Some(((i + 1) as u32, line.trim().chars().take(120).collect()));
                }
            }
            if count > 0 || name_match {
                let (line, preview) = first.unwrap_or((0, String::new()));
                hits.push((
                    name_match,
                    SearchHit {
                        path: p.to_string_lossy().into_owned(),
                        name,
                        line,
                        preview,
                        count,
                    },
                ));
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.count.cmp(&a.1.count)));
    Ok(hits.into_iter().take(limit).map(|(_, h)| h).collect())
}

fn decode_text(bytes: &[u8]) -> Result<(String, String), String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        if !looks_like_text(rest) {
            return Err("文件内容疑似二进制，已拒绝按文本打开".into());
        }
        return Ok((
            String::from_utf8(rest.to_vec()).map_err(err)?,
            "utf-8-bom".into(),
        ));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        if rest.len() % 2 != 0 {
            return Err("UTF-16LE 文件字节数不完整".into());
        }
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return Ok((String::from_utf16(&units).map_err(err)?, "utf-16le".into()));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        if rest.len() % 2 != 0 {
            return Err("UTF-16BE 文件字节数不完整".into());
        }
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        return Ok((String::from_utf16(&units).map_err(err)?, "utf-16be".into()));
    }
    if !looks_like_text(bytes) {
        return Err("文件内容疑似二进制，已拒绝按文本打开".into());
    }
    if let Ok(content) = std::str::from_utf8(bytes) {
        return Ok((content.to_owned(), "utf-8".into()));
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, false);
    let (content, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err("无法可靠识别文本编码".into());
    }
    Ok((content.into_owned(), encoding.name().to_ascii_lowercase()))
}

fn encode_text(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding.to_ascii_lowercase().as_str() {
        "utf-8" => Ok(content.as_bytes().to_vec()),
        "utf-8-bom" => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(content.as_bytes());
            Ok(out)
        }
        "utf-16le" | "utf-16be" => {
            let little = encoding.eq_ignore_ascii_case("utf-16le");
            let mut out = if little {
                vec![0xFF, 0xFE]
            } else {
                vec![0xFE, 0xFF]
            };
            for unit in content.encode_utf16() {
                let encoded = if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                out.extend_from_slice(&encoded);
            }
            Ok(out)
        }
        label => {
            let codec = Encoding::for_label(label.as_bytes())
                .ok_or_else(|| format!("不支持的文本编码: {encoding}"))?;
            let (bytes, _, had_errors) = codec.encode(content);
            if had_errors {
                return Err(format!(
                    "内容包含 {encoding} 无法表示的字符，请另存为 UTF-8 文件"
                ));
            }
            Ok(bytes.into_owned())
        }
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(err)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(once(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(once(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn read_doc(path: String) -> Result<DocPayload, String> {
    tauri::async_runtime::spawn_blocking(move || read_doc_impl(path))
        .await
        .map_err(err)?
}

fn read_doc_impl(path: String) -> Result<DocPayload, String> {
    let p = require_abs(&path)?;
    let bytes = fs::read(&p).map_err(err)?;
    let (content, encoding) = decode_text(&bytes)?;
    Ok(DocPayload {
        content,
        mtime_ms: mtime_ms(&p)?,
        encoding,
    })
}

/// 原子写（DESIGN.md §2）：同目录临时文件 + fsync + rename。
/// expected_mtime_ms 不匹配时返回 "conflict"，前端据此走冲突流程。
/// 写入前登记到 watcher 自写忽略表（DESIGN.md §2）。
#[tauri::command]
pub async fn write_doc_atomic(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
    encoding: Option<String>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_doc_atomic_impl(path, content, expected_mtime_ms, encoding)
    })
    .await
    .map_err(err)?
}

fn write_doc_atomic_impl(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
    encoding: Option<String>,
) -> Result<u64, String> {
    let p = require_abs(&path)?;
    if let (Some(expected), true) = (expected_mtime_ms, p.exists()) {
        let actual = mtime_ms(&p)?;
        if actual != expected {
            return Err("conflict".into());
        }
    }
    let bytes = encode_text(&content, encoding.as_deref().unwrap_or("utf-8"))?;
    static SAVE_TMP_SEQ: AtomicU64 = AtomicU64::new(1);
    let tmp = crate::watcher::tmp_path_for(&p, SAVE_TMP_SEQ.fetch_add(1, Ordering::Relaxed));
    crate::watcher::register_self_write(&tmp);
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(err)?;
        if let Ok(meta) = fs::metadata(&p) {
            fs::set_permissions(&tmp, meta.permissions()).map_err(err)?;
        }
        f.write_all(&bytes).map_err(err)?;
        f.sync_all().map_err(err)?;
        replace_file(&tmp, &p)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    mtime_ms(&p)
}

/// 粘贴图片落盘（FR-25）：<文档目录>/assets/<文档名>/img-<序号>.<ext>，返回相对路径
#[tauri::command]
pub async fn save_pasted_image(
    doc_path: String,
    data_b64: String,
    ext: String,
) -> Result<String, String> {
    use base64::Engine;
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
    ) {
        return Err(format!("不支持的图片格式: {ext}"));
    }
    let doc = require_abs(&doc_path)?;
    let dir = doc.parent().ok_or("文档无父目录")?;
    let stem = doc.file_stem().and_then(|s| s.to_str()).unwrap_or("images");
    let assets = dir.join("assets").join(stem);
    fs::create_dir_all(&assets).map_err(err)?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(err)?;
    let millis = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(err)?
        .as_millis();
    let mut n = 0u32;
    let target = loop {
        let name = if n == 0 {
            format!("img-{millis}.{ext}")
        } else {
            format!("img-{millis}-{n}.{ext}")
        };
        let candidate = assets.join(&name);
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };
    fs::write(&target, &bytes).map_err(err)?;
    Ok(format!(
        "assets/{}/{}",
        stem,
        target.file_name().unwrap().to_string_lossy()
    ))
}

/// 文件/文件夹名合法性：拦截路径分隔符、盘符相对路径（C:x）与 . / ..
fn valid_entry_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name != "."
        && name != ".."
}

#[tauri::command]
pub async fn create_entry(parent: String, name: String, is_dir: bool) -> Result<String, String> {
    if !valid_entry_name(&name) {
        return Err(format!("非法名称: {name}"));
    }
    let target = require_abs(&parent)?.join(&name);
    if target.exists() {
        return Err("已存在同名文件".into());
    }
    if is_dir {
        fs::create_dir(&target).map_err(err)?;
    } else {
        fs::write(&target, "").map_err(err)?;
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    if !valid_entry_name(&new_name) {
        return Err(format!("非法名称: {new_name}"));
    }
    let p = require_abs(&path)?;
    let target = p
        .parent()
        .ok_or_else(|| "无父目录".to_string())?
        .join(&new_name);
    if target.exists() {
        return Err("已存在同名文件".into());
    }
    fs::rename(&p, &target).map_err(err)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn trash_entry(path: String) -> Result<(), String> {
    trash::delete(require_abs(&path)?).map_err(err)
}

#[tauri::command]
pub async fn reveal_in_os(path: String) -> Result<(), String> {
    let p = require_abs(&path)?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(err)?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", p.display()))
        .spawn()
        .map_err(err)?;
    Ok(())
}

/// 识图附件上限：base64 后约 +33%，8MB 原图足够覆盖常见截图/照片
const IMAGE_ATTACH_MAX: u64 = 8 * 1024 * 1024;

/// 读取图片为 base64（AI 识图附件用）。路径来自文件选择器/粘贴，扩展名白名单 + 大小上限。
pub fn read_image_b64_impl(path: &str) -> Result<(String, String), String> {
    use base64::Engine;
    let p = require_abs(path)?;
    let mime = crate::pdf::image_mime(path).ok_or("不支持的图片格式")?;
    let meta = fs::metadata(&p).map_err(err)?;
    if meta.len() > IMAGE_ATTACH_MAX {
        return Err(format!(
            "图片过大（{:.1}MB），上限 8MB",
            meta.len() as f64 / 1048576.0
        ));
    }
    let bytes = fs::read(&p).map_err(err)?;
    Ok((
        mime.to_string(),
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageB64 {
    pub media_type: String,
    pub data_b64: String,
}

#[tauri::command]
pub async fn read_image_b64(path: String) -> Result<ImageB64, String> {
    let (media_type, data_b64) = read_image_b64_impl(&path)?;
    Ok(ImageB64 {
        media_type,
        data_b64,
    })
}

/// AI 工具路径约束（DESIGN docs/AI-TOOLS-DESIGN.md §7）：path（相对工作区或绝对）
/// 规范化后必须位于 root 之内。canonicalize 同时消解 `..` 与符号链接，防两类逃逸。
pub fn canon_in_root_impl(root: &str, path: &str) -> Result<String, String> {
    let root_c = std::fs::canonicalize(root).map_err(err)?;
    let joined = Path::new(root).join(path);
    let canon = std::fs::canonicalize(&joined).map_err(|_| format!("路径不存在：{path}"))?;
    if !canon.starts_with(&root_c) {
        return Err("路径越出工作区，已拒绝".into());
    }
    // Windows canonicalize 产出 \\?\ 前缀，剥掉便于展示与复用
    let s = canon.to_string_lossy().into_owned();
    Ok(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
}

#[tauri::command]
pub async fn canon_in_root(root: String, path: String) -> Result<String, String> {
    canon_in_root_impl(&root, &path)
}

fn session_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
pub async fn load_session(app: tauri::AppHandle) -> Result<Option<Session>, String> {
    let file = session_file(&app)?;
    if !file.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file).map_err(err)?;
    Ok(serde_json::from_str(&raw).ok())
}

#[tauri::command]
pub async fn save_session(app: tauri::AppHandle, session: Session) -> Result<(), String> {
    let file = session_file(&app)?;
    fs::write(&file, serde_json::to_string_pretty(&session).map_err(err)?).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block<F: std::future::Future>(fut: F) -> F::Output {
        tauri::async_runtime::block_on(fut)
    }

    #[test]
    fn atomic_write_roundtrip_and_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        let path = file.to_string_lossy().into_owned();

        // 初次写入（无期望 mtime）
        let m1 = block(write_doc_atomic(path.clone(), "v1".into(), None, None)).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");

        // 带正确 mtime 的写入成功
        let m2 = block(write_doc_atomic(path.clone(), "v2".into(), Some(m1), None)).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");

        // 模拟外部修改后，旧 mtime 写入必须冲突
        fs::write(&file, "external").unwrap();
        let e = block(write_doc_atomic(path.clone(), "v3".into(), Some(m2), None)).unwrap_err();
        assert_eq!(e, "conflict");
        assert_eq!(fs::read_to_string(&file).unwrap(), "external");

        // 临时文件不残留
        assert!(!fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".bmd-")));
    }

    #[test]
    fn text_encoding_roundtrip() {
        for encoding in ["utf-8-bom", "utf-16le", "utf-16be", "gbk"] {
            let bytes = encode_text("中文 ABC", encoding).unwrap();
            let (decoded, detected) = decode_text(&bytes).unwrap();
            assert_eq!(decoded, "中文 ABC");
            if encoding.starts_with("utf-") {
                assert_eq!(detected, encoding);
            } else {
                assert!(!detected.is_empty());
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("utf16.txt");
        let path = file.to_string_lossy().into_owned();
        block(write_doc_atomic(
            path.clone(),
            "保存原编码".into(),
            None,
            Some("utf-16le".into()),
        ))
        .unwrap();
        let payload = block(read_doc(path)).unwrap();
        assert_eq!(payload.content, "保存原编码");
        assert_eq!(payload.encoding, "utf-16le");
    }

    #[test]
    fn scan_dir_sorts_and_flags() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("zdir")).unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("A.markdown"), "").unwrap();
        fs::write(dir.path().join("c.txt"), "").unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();
        fs::write(dir.path().join(".gitignore"), "target\n").unwrap();
        fs::write(dir.path().join("notes.weird"), "冷门扩展也是文本").unwrap();
        fs::write(dir.path().join("blob.bin"), [0, 1, 2, 3]).unwrap();

        let entries = block(scan_dir(dir.path().to_string_lossy().into_owned())).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "zdir",
                ".gitignore",
                "A.markdown",
                "b.md",
                "blob.bin",
                "c.txt",
                "notes.weird"
            ]
        );
        assert!(entries[0].is_dir && !entries[0].is_md);
        assert!(entries[2].is_md && entries[3].is_md && !entries[4].is_md);
        assert!(
            entries
                .iter()
                .find(|e| e.name == "notes.weird")
                .unwrap()
                .is_text
        );
        assert!(
            !entries
                .iter()
                .find(|e| e.name == "blob.bin")
                .unwrap()
                .is_text
        );
    }

    #[test]
    fn search_text_content_name_order_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("a.md"), "Hello World\nsay hello, hello!").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub").join("deep.md"), "hello 深层").unwrap();
        fs::write(dir.path().join("note-hello.md"), "无关内容").unwrap();
        fs::write(dir.path().join("skip.txt"), "hello hello").unwrap();
        fs::write(dir.path().join(".hidden.md"), "hello").unwrap();

        // 大小写不敏感；文件名命中优先，其余文本按命中次数降序；已知文本类型的隐藏文件可参与
        let latest = Arc::new(Mutex::new(HashMap::new()));
        let hits = search_text_impl(
            root.clone(),
            "HELLO".into(),
            50,
            1,
            "test".into(),
            Arc::clone(&latest),
        )
        .unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(
            names,
            ["note-hello.md", "a.md", "skip.txt", ".hidden.md", "deep.md"]
        );

        let a = hits.iter().find(|h| h.name == "a.md").unwrap();
        assert_eq!((a.count, a.line), (3, 1));
        assert_eq!(a.preview, "Hello World");
        // 仅文件名命中：line 0 / count 0
        assert_eq!((hits[0].line, hits[0].count), (0, 0));

        // 空白查询返回空；limit 截断
        assert!(search_text_impl(
            root.clone(),
            "  ".into(),
            50,
            2,
            "test".into(),
            Arc::clone(&latest),
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            search_text_impl(root, "hello".into(), 1, 3, "test".into(), latest)
                .unwrap()
                .len(),
            1
        );

        let cancelled = Arc::new(Mutex::new(HashMap::new()));
        register_search_request(&cancelled, "test", 8);
        assert!(search_text_impl(
            dir.path().to_string_lossy().into_owned(),
            "hello".into(),
            50,
            7,
            "test".into(),
            cancelled,
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn read_image_b64_validates() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        // 1x1 PNG 头部字节（内容合法性不校验，只验白名单与编码往返）
        fs::write(&png, [0x89, b'P', b'N', b'G', 0, 1, 2, 3]).unwrap();
        let (mime, b64) = read_image_b64_impl(&png.to_string_lossy()).unwrap();
        assert_eq!(mime, "image/png");
        use base64::Engine;
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&b64)
                .unwrap()[..4],
            [0x89, b'P', b'N', b'G']
        );
        // 非图片扩展拒绝
        let txt = dir.path().join("b.txt");
        fs::write(&txt, "x").unwrap();
        assert!(read_image_b64_impl(&txt.to_string_lossy()).is_err());
    }

    #[test]
    fn canon_in_root_guards_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub").join("a.md"), "x").unwrap();
        fs::write(dir.path().join("top.md"), "y").unwrap();

        // 相对路径正常解析
        let ok = canon_in_root_impl(&root, "sub/a.md").unwrap();
        assert!(ok.ends_with("a.md"));
        // 根内绝对路径也接受
        let abs = dir.path().join("top.md").to_string_lossy().into_owned();
        assert!(canon_in_root_impl(&root, &abs).is_ok());
        // ../ 逃逸拒绝
        assert!(canon_in_root_impl(&root, "../").is_err());
        assert!(canon_in_root_impl(&root, "sub/../../etc").is_err());
        // 根外绝对路径拒绝
        let outside = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(canon_in_root_impl(&root, &outside).is_err());
        // 不存在的路径拒绝（canonicalize 失败）
        assert!(canon_in_root_impl(&root, "nope.md").is_err());
    }

    #[test]
    fn create_rename_validation() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().to_string_lossy().into_owned();

        let p = block(create_entry(parent.clone(), "n.md".into(), false)).unwrap();
        assert!(Path::new(&p).exists());
        // 同名冲突
        assert!(block(create_entry(parent.clone(), "n.md".into(), false)).is_err());
        // 非法名称
        assert!(block(create_entry(parent.clone(), "a/b".into(), false)).is_err());

        let renamed = block(rename_entry(p, "m.md".into())).unwrap();
        assert!(renamed.ends_with("m.md"));
    }
}
