//! NoteX 桌面壳。
//!
//! 前端通过这些命令拿到宿主能力：文件读写、目录列举、进程探测，
//! 以及内核子进程的启动与 stdio 转发。
//! 内核 stdio 走事件而不是命令返回值，因为输出是流式的。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// 窗口的固定尺寸。用户不能拖边框改大小，只能在这个尺寸和最大化之间切换
const WINDOW_SIZE: (f64, f64) = (1280.0, 860.0);

/// 在固定尺寸与铺满屏幕之间切换。
/// 窗口设成不可缩放后，系统的最大化（macOS 的 zoom）会被禁用，
/// 所以临时放开、做完再收回，最大化后的窗口同样是固定的。
fn toggle_zoom(window: &WebviewWindow) {
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = window.set_resizable(true);
    if maximized {
        let _ = window.unmaximize();
        let _ = window.set_size(tauri::LogicalSize::new(WINDOW_SIZE.0, WINDOW_SIZE.1));
        let _ = window.center();
    } else {
        let _ = window.maximize();
    }
    let _ = window.set_resizable(false);
}

/// 菜单栏。自己建而不用默认菜单，是为了在「窗口」里放一个真正能用的「缩放」：
/// 默认菜单里的最大化对不可缩放窗口不起作用。编辑菜单必须保留，
/// macOS 上 ⌘C / ⌘V / ⌘Z 这些快捷键就是靠它分发到输入框的。
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "NoteX")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let zoom = MenuItemBuilder::with_id("window-zoom", "缩放")
        .accelerator("CmdOrCtrl+Ctrl+Z")
        .build(app)?;
    let fullscreen = MenuItemBuilder::with_id("window-fullscreen", "进入 / 退出全屏")
        .accelerator("CmdOrCtrl+Ctrl+F")
        .build(app)?;
    let window = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&zoom)
        .item(&fullscreen)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &window]).build()
}

#[tauri::command]
fn window_zoom(window: WebviewWindow) {
    toggle_zoom(&window);
}

#[derive(Serialize, Clone)]
pub struct DirEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
    modified: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ExecResult {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Serialize, Clone)]
struct StreamChunk {
    id: u64,
    text: String,
}

#[derive(Serialize, Clone)]
struct ExitInfo {
    id: u64,
    code: Option<i32>,
}

/// 运行中的内核子进程。
///
/// stdin 与 child 分开加锁：往 stdin 写可能因为内核正忙不读而阻塞，
/// 那时恰恰需要发信号中断它，两者共用一把锁就会互相卡死。
struct Kernel {
    pid: u32,
    child: Mutex<Child>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
}

#[derive(Default)]
pub struct Kernels(Mutex<HashMap<u64, Arc<Kernel>>>);

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn kernel_of(kernels: &Kernels, id: u64) -> Result<Arc<Kernel>, String> {
    kernels
        .0
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "内核已退出".into())
}

fn send_signal(kernel: &Kernel, signal: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        // SIGINT 用于中断执行，内核进程本身要活着，因此不能直接 kill
        let sig = match signal {
            "SIGINT" => 2,
            "SIGTERM" => 15,
            _ => 9,
        };
        unsafe {
            libc::kill(kernel.pid as i32, sig);
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = signal;
        kernel.child.lock().unwrap().kill().map_err(|e| e.to_string())
    }
}

/// 把还活着的内核全部结束掉。应用退出与页面重载时用：
/// 忙碌中的内核不读 stdin，靠 EOF 是等不到它自己退出的。
fn kill_all_kernels(kernels: &Kernels) {
    let all: Vec<Arc<Kernel>> = kernels.0.lock().unwrap().drain().map(|(_, k)| k).collect();
    if all.is_empty() {
        return;
    }
    for k in &all {
        let _ = send_signal(k, "SIGTERM");
    }
    std::thread::sleep(Duration::from_millis(300));
    for k in &all {
        let mut child = k.child.lock().unwrap();
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        // 回收，避免留下僵尸
        let _ = child.wait();
    }
}

fn to_iso(time: std::time::SystemTime) -> Option<String> {
    let dur = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    // 手写 ISO8601，避免为一个时间戳引入 chrono
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    Some(format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z"
    ))
}

/// Howard Hinnant 的 civil_from_days 算法
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    dirs_home().ok_or_else(|| "无法确定主目录".into())
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

#[tauri::command]
fn stat_file(path: String) -> Option<String> {
    std::fs::metadata(&path).ok()?.modified().ok().and_then(to_iso)
}

#[tauri::command]
fn file_size(path: String) -> Option<u64> {
    std::fs::metadata(&path).ok().map(|m| m.len())
}

#[tauri::command]
fn cpu_arch() -> &'static str {
    std::env::consts::ARCH
}

/// 下载的运行时包要校验后才能解压；一百多 MB 的文件放到线程池里算
#[tauri::command]
async fn sha256_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        let mut file = std::fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&path) {
        Ok(e) => e,
        // 目录不存在按空处理，调用方会先 ensure_dir
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let meta = entry.metadata().ok();
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            modified: meta.and_then(|m| m.modified().ok()).and_then(to_iso),
        });
    }
    Ok(out)
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

#[tauri::command]
fn remove_dir(path: String) -> Result<(), String> {
    match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

/// 移到系统废纸篓。不存在的路径静默返回，与 remove_file 的宽松语义一致
#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !PathBuf::from(&path).exists() {
            return Ok(());
        }
        trash::delete(&path).map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn rename_file(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("{from} -> {to}: {e}"))
}

#[tauri::command]
fn env_var(name: String) -> Option<String> {
    std::env::var(name).ok()
}

/// 跑外部进程的命令一律 async：同步命令在主线程执行，
/// `mvn` 解析依赖那几十秒整个窗口都会冻住。
#[tauri::command]
async fn which(bin: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let finder = if cfg!(windows) { "where" } else { "which" };
        let out = Command::new(finder).arg(&bin).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn exec(cmd: String, args: Vec<String>) -> ExecResult {
    tauri::async_runtime::spawn_blocking(move || run_exec(&cmd, &args))
        .await
        .unwrap_or_else(|e| ExecResult {
            code: 1,
            stdout: String::new(),
            stderr: e.to_string(),
        })
}

fn run_exec(cmd: &str, args: &[String]) -> ExecResult {
    match Command::new(cmd).args(args).output() {
        Ok(out) => ExecResult {
            code: out.status.code().unwrap_or(0),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        Err(e) => ExecResult {
            code: 1,
            stdout: String::new(),
            stderr: e.to_string(),
        },
    }
}

/// 打包进应用的 kernels 目录；开发模式下回退到源码树
#[tauri::command]
fn kernels_dir(app: AppHandle) -> Result<String, String> {
    // 配置里写的是 ../kernels，Tauri 会把它放到资源目录的 _up_ 下
    for candidate in ["kernels", "_up_/kernels"] {
        if let Ok(dir) = app.path().resolve(candidate, tauri::path::BaseDirectory::Resource) {
            if dir.exists() {
                return Ok(dir.to_string_lossy().to_string());
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("kernels"));
    match dev {
        Some(p) if p.exists() => Ok(p.to_string_lossy().to_string()),
        _ => Err("找不到 kernels 目录".into()),
    }
}

#[tauri::command]
fn kernel_spawn(
    app: AppHandle,
    kernels: State<Kernels>,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, Option<String>>>,
) -> Result<u64, String> {
    let mut command = Command::new(&cmd);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    // 环境变量覆盖：内置运行时要隔离本机环境，None 表示删掉
    for (key, value) in env.unwrap_or_default() {
        match value {
            Some(v) => {
                command.env(key, v);
            }
            None => {
                command.env_remove(key);
            }
        }
    }

    let mut child = command.spawn().map_err(|e| format!("{cmd}: {e}"))?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);

    // stdout 按行读；协议消息本来就是一行一条。
    // 按字节读再宽松解码：用户代码起的子进程会直写 fd 1，
    // 一个非 UTF-8 字节不能让这个内核的输出从此失联
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buf).to_string();
                        let _ = app.emit("kernel://stdout", StreamChunk { id, text });
                    }
                }
            }
        });
    }

    // stderr 可能没有换行（比如 JVM 的告警），按块读
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&chunk[..n]).to_string();
                        let _ = app.emit("kernel://stderr", StreamChunk { id, text });
                    }
                }
            }
        });
    }

    let stdin = child.stdin.take();
    let kernel = Arc::new(Kernel {
        pid: child.id(),
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    kernels.0.lock().unwrap().insert(id, Arc::clone(&kernel));

    // 退出监听：单独线程等，避免阻塞命令返回
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(200));
            let done = match kernel.child.lock().unwrap().try_wait() {
                Ok(Some(status)) => Some(status.code()),
                Ok(None) => None,
                Err(_) => Some(None),
            };
            if let Some(code) = done {
                app.state::<Kernels>().0.lock().unwrap().remove(&id);
                let _ = app.emit("kernel://exit", ExitInfo { id, code });
                break;
            }
        });
    }

    Ok(id)
}

#[tauri::command]
async fn kernel_write(kernels: State<'_, Kernels>, id: u64, data: String) -> Result<(), String> {
    let kernel = kernel_of(&kernels, id)?;
    // 内核不读 stdin 时 write 会阻塞（管道满），不能占着主线程
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = kernel.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("内核 stdin 不可用")?;
        stdin.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn kernel_signal(kernels: State<Kernels>, id: u64, signal: String) -> Result<(), String> {
    let kernel = kernel_of(&kernels, id)?;
    send_signal(&kernel, &signal)
}

#[tauri::command]
fn kernel_kill_all(kernels: State<Kernels>) {
    kill_all_kernels(&kernels);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Kernels::default())
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let Some(window) = app.get_webview_window("main") else { return };
                match event.id().as_ref() {
                    "window-zoom" => toggle_zoom(&window),
                    "window-fullscreen" => {
                        let full = window.is_fullscreen().unwrap_or(false);
                        let _ = window.set_fullscreen(!full);
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_zoom,
            home_dir,
            read_text,
            write_text,
            file_exists,
            stat_file,
            file_size,
            cpu_arch,
            sha256_file,
            list_dir,
            ensure_dir,
            remove_file,
            remove_dir,
            trash_path,
            rename_file,
            env_var,
            which,
            exec,
            kernels_dir,
            kernel_spawn,
            kernel_write,
            kernel_signal,
            kernel_kill_all,
        ])
        .build(tauri::generate_context!())
        .expect("NoteX 启动失败")
        .run(|app, event| {
            // 前端 beforeunload 里的 shutdown 是异步 invoke，窗口关闭时不保证送达；
            // 这里是最后一道，保证退出后不留下还在跑死循环的内核
            if let tauri::RunEvent::Exit = event {
                kill_all_kernels(&app.state::<Kernels>());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    fn iso_of(secs: u64) -> String {
        to_iso(UNIX_EPOCH + Duration::from_secs(secs)).unwrap()
    }

    #[test]
    fn iso_matches_known_timestamps() {
        assert_eq!(iso_of(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_of(1_000_000_000), "2001-09-09T01:46:40.000Z");
        // 闰年 2 月 29 日，最容易算错的一天
        assert_eq!(iso_of(1_709_164_800), "2024-02-29T00:00:00.000Z");
        // 闰年边界的前后一天
        assert_eq!(iso_of(1_709_078_400), "2024-02-28T00:00:00.000Z");
        assert_eq!(iso_of(1_709_251_200), "2024-03-01T00:00:00.000Z");
        // 非闰年的 3 月 1 日
        assert_eq!(iso_of(1_677_628_800), "2023-03-01T00:00:00.000Z");
        // 世纪年 2000 是闰年，1900 不是
        assert_eq!(iso_of(951_782_400), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn file_roundtrip_and_listing() {
        let dir = std::env::temp_dir().join(format!("notex-test-{}", std::process::id()));
        let path = dir.join("笔记.md").to_string_lossy().to_string();

        ensure_dir(dir.to_string_lossy().to_string()).unwrap();
        write_text(path.clone(), "# 标题\n正文".into()).unwrap();
        assert!(file_exists(path.clone()));
        assert_eq!(read_text(path.clone()).unwrap(), "# 标题\n正文");
        assert!(stat_file(path.clone()).is_some());

        let entries = list_dir(dir.to_string_lossy().to_string()).unwrap();
        assert!(entries.iter().any(|e| e.name == "笔记.md" && !e.is_dir));

        let renamed = dir.join("改名.md").to_string_lossy().to_string();
        rename_file(path.clone(), renamed.clone()).unwrap();
        assert!(!file_exists(path.clone()));
        assert!(file_exists(renamed.clone()));

        remove_file(renamed.clone()).unwrap();
        assert!(!file_exists(renamed.clone()));
        // 删不存在的文件不该报错，调用方常用它清理旁车文件
        remove_file(renamed).unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_creates_missing_parent_dirs() {
        let dir = std::env::temp_dir().join(format!("notex-nested-{}", std::process::id()));
        let path = dir.join("a").join("b").join("c.md").to_string_lossy().to_string();
        write_text(path.clone(), "x".into()).unwrap();
        assert_eq!(read_text(path).unwrap(), "x");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_missing_dir_is_empty_not_error() {
        let missing = std::env::temp_dir().join("notex-does-not-exist-xyz");
        assert!(list_dir(missing.to_string_lossy().to_string()).unwrap().is_empty());
    }

    #[test]
    fn exec_reports_output_and_failure() {
        let ok = run_exec("echo", &["hi".to_string()]);
        assert_eq!(ok.code, 0);
        assert!(ok.stdout.contains("hi"));

        let missing = run_exec("notex-no-such-binary", &[]);
        assert_eq!(missing.code, 1);
        assert!(!missing.stderr.is_empty());
    }
}
