use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

// 外部变更监听（DESIGN.md §4）：notify 递归监听工作区根目录，
// 事件经 400ms 静默期去抖后发前端 "fs-changed"；自身写入经忽略表过滤。

const SELF_WRITE_TTL: Duration = Duration::from_millis(2000);
const DEBOUNCE: Duration = Duration::from_millis(400);

fn self_writes() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static M: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// write_doc_atomic 的唯一隐藏临时文件名；同一文档并发请求也不会共用文件。
pub fn tmp_path_for(path: &Path, nonce: u64) -> PathBuf {
    let name = format!(
        ".{}.bmd-{}-{nonce}.tmp",
        path.file_name()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default(),
        std::process::id(),
    );
    path.with_file_name(name)
}

/// 只忽略临时文件事件；目标文件事件交给前端按 mtime 去重，避免吞掉紧随其后的外部修改。
pub fn register_self_write(temp_path: &Path) {
    let mut map = self_writes().lock().unwrap();
    let now = Instant::now();
    map.retain(|_, t| now.duration_since(*t) < SELF_WRITE_TTL);
    map.insert(temp_path.to_path_buf(), now);
}

/// 事件路径是否应因「自身写入」而忽略（含 TTL 清理）
pub fn should_ignore(path: &Path, now: Instant) -> bool {
    let mut map = self_writes().lock().unwrap();
    map.retain(|_, t| now.duration_since(*t) < SELF_WRITE_TTL);
    map.contains_key(path)
}

struct Pending {
    paths: HashSet<PathBuf>,
    last: Instant,
}

fn pending() -> &'static Mutex<Pending> {
    static P: OnceLock<Mutex<Pending>> = OnceLock::new();
    P.get_or_init(|| {
        Mutex::new(Pending {
            paths: HashSet::new(),
            last: Instant::now(),
        })
    })
}

fn should_ignore_hidden_path(root: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let mut components = relative.components().peekable();

    while let Some(component) = components.next() {
        let Some(name) = component.as_os_str().to_str() else {
            continue;
        };
        if !name.starts_with('.') {
            continue;
        }

        let is_file_name = components.peek().is_none();
        if !is_file_name || !crate::commands::is_known_text_path(path) {
            return true;
        }
    }

    false
}

#[derive(Default)]
pub struct WatchState(Mutex<Option<RecommendedWatcher>>);

#[tauri::command]
pub async fn start_watch(
    app: AppHandle,
    state: State<'_, WatchState>,
    path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("不是目录: {path}"));
    }

    let watched_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let now = Instant::now();
            let mut p = pending().lock().unwrap();
            let mut changed = false;
            for path in event.paths {
                // 已知隐藏文本文件可正常刷新；隐藏目录与原子写临时文件不上报。
                if !should_ignore_hidden_path(&watched_root, &path) && !should_ignore(&path, now) {
                    changed |= p.paths.insert(path);
                }
            }
            if changed {
                p.last = now;
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);
    pending().lock().unwrap().paths.clear();

    // 去抖发射线程（幂等启动一次）
    static EMITTER: OnceLock<()> = OnceLock::new();
    EMITTER.get_or_init(|| {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(150));
            let drained: Vec<String> = {
                let mut p = pending().lock().unwrap();
                if p.paths.is_empty() || p.last.elapsed() < DEBOUNCE {
                    continue;
                }
                p.paths
                    .drain()
                    .map(|x| x.to_string_lossy().into_owned())
                    .collect()
            };
            let _ = app.emit("fs-changed", drained);
        });
    });
    Ok(())
}

/// 停止目录监听（切换/关闭工作区时释放句柄；去抖线程幂等常驻无累积开销）
#[tauri::command]
pub async fn stop_watch(state: State<'_, WatchState>) -> Result<(), String> {
    *state.0.lock().unwrap() = None;
    pending().lock().unwrap().paths.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_write_ignore_with_ttl() {
        let target = PathBuf::from("/tmp/x.md");
        let temp = tmp_path_for(&target, 1);
        register_self_write(&temp);
        assert!(!should_ignore(&target, Instant::now()));
        assert!(should_ignore(&temp, Instant::now()));
        assert!(!should_ignore(
            &PathBuf::from("/tmp/other.md"),
            Instant::now()
        ));
        // TTL 过期后不再忽略
        assert!(!should_ignore(&temp, Instant::now() + SELF_WRITE_TTL * 2));
    }

    #[test]
    fn tmp_path_appends_extension() {
        assert_eq!(
            tmp_path_for(Path::new("/a/b.md"), 7),
            PathBuf::from(format!("/a/.b.md.bmd-{}-7.tmp", std::process::id()))
        );
        // a.md 与 a.markdown 不再碰撞
        assert_ne!(
            tmp_path_for(Path::new("/a/x.md"), 1),
            tmp_path_for(Path::new("/a/x.md"), 2)
        );
    }

    #[test]
    fn hidden_text_files_are_watched_without_exposing_hidden_directories() {
        let root = Path::new("/workspace");
        assert!(!should_ignore_hidden_path(
            root,
            Path::new("/workspace/.gitignore")
        ));
        assert!(!should_ignore_hidden_path(
            root,
            Path::new("/workspace/notes/.draft.md")
        ));
        assert!(should_ignore_hidden_path(
            root,
            Path::new("/workspace/.git/index")
        ));
        assert!(should_ignore_hidden_path(
            root,
            Path::new("/workspace/.cache/README.md")
        ));
        assert!(should_ignore_hidden_path(
            root,
            Path::new("/workspace/.unknown")
        ));
    }
}
