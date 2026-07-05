use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

// 外部变更监听（DESIGN.md §5.2）：notify 递归监听工作区根目录，
// 事件经 400ms 静默期去抖后发前端 "fs-changed"；自身写入经忽略表过滤。

const SELF_WRITE_TTL: Duration = Duration::from_millis(2000);
const DEBOUNCE: Duration = Duration::from_millis(400);

fn self_writes() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static M: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// write_doc_atomic 的临时文件名（与 commands.rs 保持一致：追加而非替换扩展名）
pub fn tmp_path_for(path: &Path) -> PathBuf {
    let name = format!(
        "{}.bmd.tmp",
        path.file_name().map(|s| s.to_string_lossy()).unwrap_or_default()
    );
    path.with_file_name(name)
}

/// write_doc_atomic 调用：登记即将发生的自身写入
pub fn register_self_write(path: &Path) {
    let mut map = self_writes().lock().unwrap();
    let now = Instant::now();
    map.retain(|_, t| now.duration_since(*t) < SELF_WRITE_TTL);
    map.insert(path.to_path_buf(), now);
    // 临时文件与目标同视为自写
    map.insert(tmp_path_for(path), now);
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

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let now = Instant::now();
            let mut p = pending().lock().unwrap();
            for path in event.paths {
                // 隐藏文件与自写事件不上报
                let hidden = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.'));
                if !hidden && !should_ignore(&path, now) {
                    p.paths.insert(path);
                }
            }
            p.last = now;
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);

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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_write_ignore_with_ttl() {
        let p = PathBuf::from("/tmp/x.md");
        register_self_write(&p);
        assert!(should_ignore(&p, Instant::now()));
        assert!(should_ignore(
            &PathBuf::from("/tmp/x.md.bmd.tmp"),
            Instant::now()
        ));
        assert!(!should_ignore(&PathBuf::from("/tmp/other.md"), Instant::now()));
        // TTL 过期后不再忽略
        assert!(!should_ignore(&p, Instant::now() + SELF_WRITE_TTL * 2));
    }

    #[test]
    fn tmp_path_appends_extension() {
        assert_eq!(
            tmp_path_for(Path::new("/a/b.md")),
            PathBuf::from("/a/b.md.bmd.tmp")
        );
        // a.md 与 a.markdown 不再碰撞
        assert_ne!(
            tmp_path_for(Path::new("/a/x.md")),
            tmp_path_for(Path::new("/a/x.markdown"))
        );
    }
}
