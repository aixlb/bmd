use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_md: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPayload {
    pub content: String,
    pub mtime_ms: u64,
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

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "md" || e == "markdown"
    )
}

fn require_abs(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(format!("需要绝对路径: {path}"));
    }
    Ok(p)
}

/// 单层目录扫描：目录在前、文件在后，各自按名称排序（忽略大小写）。
/// 隐藏文件（.开头）不返回。
#[tauri::command]
pub async fn scan_dir(path: String) -> Result<Vec<Entry>, String> {
    let dir = require_abs(&path)?;
    let mut entries: Vec<Entry> = fs::read_dir(&dir)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let p = e.path();
            let is_dir = e.file_type().ok()?.is_dir();
            Some(Entry {
                is_md: !is_dir && is_markdown(&p),
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

/// 工作区全文搜索（FR 侧栏搜索）：递归遍历 md/markdown 文件，
/// 大小写不敏感子串匹配文件名与内容。隐藏项跳过，>5MB 文件跳过。
/// 排序：文件名命中优先，其次按内容命中次数降序。
#[tauri::command]
pub async fn search_text(
    root: String,
    query: String,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let dir = require_abs(&root)?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut hits: Vec<(bool, SearchHit)> = Vec::new();
    let mut stack = vec![dir];
    'walk: while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
                continue;
            }
            if !is_markdown(&p) {
                continue;
            }
            if fs::metadata(&p).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(true) {
                continue;
            }
            let name_match = name.to_lowercase().contains(&q);
            let Ok(content) = fs::read_to_string(&p) else { continue };
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
                if hits.len() >= limit {
                    break 'walk;
                }
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.count.cmp(&a.1.count)));
    Ok(hits.into_iter().map(|(_, h)| h).collect())
}

#[tauri::command]
pub async fn read_doc(path: String) -> Result<DocPayload, String> {
    let p = require_abs(&path)?;
    let content = fs::read_to_string(&p).map_err(err)?;
    Ok(DocPayload {
        content,
        mtime_ms: mtime_ms(&p)?,
    })
}

/// 原子写（DESIGN.md §5.1）：同目录临时文件 + fsync + rename。
/// expected_mtime_ms 不匹配时返回 "conflict"，前端据此走冲突流程。
/// 写入前登记到 watcher 自写忽略表（DESIGN.md §5.2）。
#[tauri::command]
pub async fn write_doc_atomic(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
) -> Result<u64, String> {
    let p = require_abs(&path)?;
    if let (Some(expected), true) = (expected_mtime_ms, p.exists()) {
        let actual = mtime_ms(&p)?;
        if actual != expected {
            return Err("conflict".into());
        }
    }
    crate::watcher::register_self_write(&p);
    // 追加而非替换扩展名：a.md 与 a.markdown 并发保存不共用同一临时文件
    let tmp = crate::watcher::tmp_path_for(&p);
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(err)?;
        f.write_all(content.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    fs::rename(&tmp, &p).map_err(err)?;
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
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp") {
        return Err(format!("不支持的图片格式: {ext}"));
    }
    let doc = require_abs(&doc_path)?;
    let dir = doc.parent().ok_or("文档无父目录")?;
    let stem = doc
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("images");
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
        let m1 = block(write_doc_atomic(path.clone(), "v1".into(), None)).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");

        // 带正确 mtime 的写入成功
        let m2 = block(write_doc_atomic(path.clone(), "v2".into(), Some(m1))).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");

        // 模拟外部修改后，旧 mtime 写入必须冲突
        fs::write(&file, "external").unwrap();
        let e = block(write_doc_atomic(path.clone(), "v3".into(), Some(m2))).unwrap_err();
        assert_eq!(e, "conflict");
        assert_eq!(fs::read_to_string(&file).unwrap(), "external");

        // 临时文件不残留
        assert!(!file.with_extension("bmd.tmp").exists());
    }

    #[test]
    fn scan_dir_sorts_and_flags() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("zdir")).unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("A.markdown"), "").unwrap();
        fs::write(dir.path().join("c.txt"), "").unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();

        let entries = block(scan_dir(dir.path().to_string_lossy().into_owned())).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["zdir", "A.markdown", "b.md", "c.txt"]);
        assert!(entries[0].is_dir && !entries[0].is_md);
        assert!(entries[1].is_md && entries[2].is_md && !entries[3].is_md);
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

        // 大小写不敏感；文件名命中优先，其余按命中次数降序；txt / 隐藏文件不参与
        let hits = block(search_text(root.clone(), "HELLO".into(), 50)).unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(names, ["note-hello.md", "a.md", "deep.md"]);

        let a = hits.iter().find(|h| h.name == "a.md").unwrap();
        assert_eq!((a.count, a.line), (3, 1));
        assert_eq!(a.preview, "Hello World");
        // 仅文件名命中：line 0 / count 0
        assert_eq!((hits[0].line, hits[0].count), (0, 0));

        // 空白查询返回空；limit 截断
        assert!(block(search_text(root.clone(), "  ".into(), 50)).unwrap().is_empty());
        assert_eq!(block(search_text(root, "hello".into(), 1)).unwrap().len(), 1);
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
