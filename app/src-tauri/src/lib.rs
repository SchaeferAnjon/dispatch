use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// Embedded Dolt is single-writer with a file lock; serialize our own calls so they
// never contend with each other (only with external agents).
static BD_LOCK: Mutex<()> = Mutex::new(());

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn beads_dir() -> PathBuf {
    std::env::var("BEADS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join("tasks/.beads"))
}

// GUI apps launched from the Dock don't get the shell's PATH, so probe the usual spots.
fn bd_bin() -> PathBuf {
    if let Ok(b) = std::env::var("BD_BIN") {
        return PathBuf::from(b);
    }
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/bd"),
        PathBuf::from("/usr/local/bin/bd"),
        home().join("go/bin/bd"),
        home().join(".local/bin/bd"),
    ];
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    PathBuf::from("bd")
}

// The GUI is always driven by the human, so it never inherits an agent's BEADS_ACTOR.
fn actor() -> String {
    std::env::var("DISPATCH_ACTOR").unwrap_or_else(|_| "schaefer".to_string())
}

fn run_bd_blocking(args: &[String]) -> Result<String, String> {
    let bin = bd_bin();
    let dir = beads_dir();
    let workdir = dir.parent().map(Path::to_path_buf).unwrap_or_else(home);
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    let mut last_err = String::new();
    for attempt in 0..3 {
        let out = {
            let _g = BD_LOCK.lock().map_err(|e| e.to_string())?;
            Command::new(&bin)
                .args(args)
                .current_dir(&workdir)
                .env("BEADS_DIR", &dir)
                .env("BEADS_ACTOR", actor())
                .env("BD_NON_INTERACTIVE", "1")
                .env("NO_COLOR", "1")
                .env("PATH", &path)
                .output()
                .map_err(|e| format!("无法启动 bd（{}）：{}", bin.display(), e))?
        };
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        if out.status.success() {
            return Ok(stdout);
        }
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        last_err = msg.trim().to_string();
        // Another agent holds the Dolt lock; back off briefly and retry.
        if last_err.contains("locked") && attempt < 2 {
            std::thread::sleep(Duration::from_millis(400 * (attempt + 1) as u64));
            continue;
        }
        break;
    }
    Err(last_err)
}

async fn run_bd(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_bd_blocking(&args))
        .await
        .map_err(|e| e.to_string())?
}

// bd occasionally prints a notice before the JSON payload; keep only the payload.
fn json_only(s: String) -> String {
    let start = s.find(|c| c == '[' || c == '{').unwrap_or(0);
    s[start..].to_string()
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[derive(Serialize)]
struct Info {
    bd_bin: String,
    beads_dir: String,
    actor: String,
    version: String,
    initial_view: Option<String>,
    initial_task: Option<String>,
}

#[tauri::command]
async fn bd_info() -> Result<Info, String> {
    let version = run_bd(args(&["version"])).await.unwrap_or_else(|e| e);
    Ok(Info {
        bd_bin: bd_bin().display().to_string(),
        beads_dir: beads_dir().display().to_string(),
        actor: actor(),
        version: version.trim().to_string(),
        initial_view: std::env::var("DISPATCH_VIEW").ok(),
        initial_task: std::env::var("DISPATCH_TASK").ok(),
    })
}

#[tauri::command]
async fn bd_list() -> Result<String, String> {
    run_bd(args(&["list", "--all", "-n", "0", "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_show(id: String) -> Result<String, String> {
    run_bd(args(&["show", &id, "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_comments(id: String) -> Result<String, String> {
    run_bd(args(&["comments", &id, "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_history(id: String) -> Result<String, String> {
    run_bd(args(&["history", &id, "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_claim(id: String) -> Result<String, String> {
    run_bd(args(&["update", &id, "--claim", "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_set_status(id: String, status: String) -> Result<String, String> {
    run_bd(args(&["update", &id, "--status", &status, "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_close(id: String, reason: String) -> Result<String, String> {
    run_bd(args(&["close", &id, "--reason", &reason, "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_reopen(id: String) -> Result<String, String> {
    run_bd(args(&["reopen", &id, "--json"])).await.map(json_only)
}

#[tauri::command]
async fn bd_comment(id: String, text: String) -> Result<String, String> {
    run_bd(args(&["comments", "add", &id, &text])).await
}

#[tauri::command]
async fn bd_labels(id: String, add: Vec<String>, remove: Vec<String>) -> Result<String, String> {
    let mut a = args(&["update", &id]);
    for l in add {
        a.push("--add-label".into());
        a.push(l);
    }
    for l in remove {
        a.push("--remove-label".into());
        a.push(l);
    }
    a.push("--json".into());
    run_bd(a).await.map(json_only)
}

#[derive(Deserialize)]
struct Fields {
    title: Option<String>,
    description: Option<String>,
    priority: Option<i64>,
    assignee: Option<String>,
    acceptance: Option<String>,
    notes: Option<String>,
}

#[tauri::command]
async fn bd_update(id: String, fields: Fields) -> Result<String, String> {
    let mut a = args(&["update", &id]);
    if let Some(v) = fields.title {
        a.push("--title".into());
        a.push(v);
    }
    if let Some(v) = fields.description {
        a.push("--description".into());
        a.push(v);
    }
    if let Some(v) = fields.priority {
        a.push("--priority".into());
        a.push(v.to_string());
    }
    if let Some(v) = fields.assignee {
        a.push("--assignee".into());
        a.push(v);
    }
    if let Some(v) = fields.acceptance {
        a.push("--acceptance".into());
        a.push(v);
    }
    if let Some(v) = fields.notes {
        a.push("--notes".into());
        a.push(v);
    }
    a.push("--json".into());
    run_bd(a).await.map(json_only)
}

#[derive(Deserialize)]
struct NewIssue {
    title: String,
    description: Option<String>,
    issue_type: Option<String>,
    priority: Option<i64>,
    labels: Option<Vec<String>>,
    acceptance: Option<String>,
    deps: Option<Vec<String>>,
}

#[tauri::command]
async fn bd_create(input: NewIssue) -> Result<String, String> {
    let mut a = args(&["create", &input.title]);
    if let Some(v) = input.description {
        a.push("--description".into());
        a.push(v);
    }
    a.push("-t".into());
    a.push(input.issue_type.unwrap_or_else(|| "task".into()));
    a.push("-p".into());
    a.push(input.priority.unwrap_or(2).to_string());
    if let Some(ls) = input.labels {
        if !ls.is_empty() {
            a.push("-l".into());
            a.push(ls.join(","));
        }
    }
    if let Some(v) = input.acceptance {
        if !v.trim().is_empty() {
            a.push("--acceptance".into());
            a.push(v);
        }
    }
    if let Some(d) = input.deps {
        if !d.is_empty() {
            a.push("--deps".into());
            a.push(d.join(","));
        }
    }
    a.push("--json".into());
    run_bd(a).await.map(json_only)
}

// ---------- sessions & transcripts: delegated to the `dispatch` CLI ----------
// One implementation serves Agents (CLI) and the GUI; the app only renders.

fn dispatch_bin() -> PathBuf {
    if let Ok(b) = std::env::var("DISPATCH_CLI") {
        return PathBuf::from(b);
    }
    for c in [home().join(".local/bin/dispatch"), home().join("Projects/kanban/app/cli/dispatch.py")] {
        if c.exists() {
            return c;
        }
    }
    PathBuf::from("dispatch")
}

fn run_dispatch_blocking(args: &[String]) -> Result<String, String> {
    let bin = dispatch_bin();
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}:{}",
        home().join(".local/bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let out = Command::new("python3")
        .arg(&bin)
        .args(args)
        .env("BEADS_DIR", beads_dir())
        .env("PATH", path)
        .output()
        .map_err(|e| format!("无法启动 dispatch（{}）：{}", bin.display(), e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

async fn run_dispatch(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_dispatch_blocking(&args))
        .await
        .map_err(|e| e.to_string())?
}

fn start_indexer() {
    std::thread::spawn(|| loop {
        let _ = run_dispatch_blocking(&args(&["index", "--json"]));
        std::thread::sleep(Duration::from_secs(60));
    });
}

#[tauri::command]
async fn sessions() -> Result<String, String> {
    run_dispatch(args(&["sessions", "--json"])).await
}

#[tauri::command]
async fn task_sessions(id: String) -> Result<String, String> {
    run_dispatch(args(&["find", &id, "--json"])).await
}

#[tauri::command]
async fn session_list() -> Result<String, String> {
    run_dispatch(args(&["list", "--cached", "--limit", "500", "--json"])).await
}

#[tauri::command]
async fn session_detail(id: String) -> Result<String, String> {
    run_dispatch(args(&["session", &id, "--json"])).await
}

#[tauri::command]
async fn focus_session(id: String) -> Result<String, String> {
    run_dispatch(args(&["focus", &id])).await
}

#[tauri::command]
fn resume_cmd(agent: String, session_id: String, cwd: String) -> String {
    let cd = if cwd.is_empty() { String::new() } else { format!("cd '{}' && ", cwd.replace('\'', "'\\''")) };
    match agent.as_str() {
        "codex" => format!("{cd}codex resume {session_id}"),
        _ => format!("{cd}claude --resume {session_id}"),
    }
}

// ---------- skills: pool + per-agent mounts, via the CLI ----------

#[tauri::command]
async fn skills_list() -> Result<String, String> {
    run_dispatch(args(&["skills", "list", "--json"])).await
}

#[tauri::command]
async fn skill_toggle(name: String, agent: String, on: bool) -> Result<String, String> {
    let op = if on { "enable" } else { "disable" };
    run_dispatch(args(&["skills", op, &name, "--agent", &agent])).await
}

fn skill_file(name: &str) -> Result<PathBuf, String> {
    let p = run_dispatch_blocking(&args(&["skills", "path", name]))?;
    let path = PathBuf::from(p.trim());
    let real = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    // Only files inside the skill pool or an agent's skills dir may be edited.
    let allowed = [home().join(".cc-switch/skills"), home().join(".claude/skills"), home().join(".agents/skills"), home().join("Projects")];
    if !allowed.iter().any(|d| std::fs::canonicalize(d).map(|d| real.starts_with(d)).unwrap_or(false)) {
        return Err(format!("不在技能目录里，拒绝：{}", real.display()));
    }
    Ok(real)
}

#[tauri::command]
async fn skill_read(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = skill_file(&name)?;
        std::fs::read_to_string(&p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn skill_write(name: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = skill_file(&name)?;
        let bak = p.with_extension("md.bak");
        let _ = std::fs::copy(&p, &bak);
        std::fs::write(&p, content).map_err(|e| e.to_string())?;
        Ok(p.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn skill_open(name: String) -> Result<String, String> {
    run_dispatch(args(&["skills", "open", &name])).await
}

// ---------- memories (used as the shared pitfall log) ----------

#[derive(Serialize)]
struct Memory {
    key: String,
    value: String,
}

#[tauri::command]
async fn memories_list() -> Result<Vec<Memory>, String> {
    let raw = run_bd(args(&["memories", "--json"])).await.map(json_only)?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("memories 解析失败：{e}"))?;
    let mut out = Vec::new();
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            if k == "schema_version" {
                continue;
            }
            if let Some(s) = val.as_str() {
                out.push(Memory { key: k.clone(), value: s.to_string() });
            }
        }
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(out)
}

#[tauri::command]
async fn memory_set(key: String, value: String) -> Result<String, String> {
    run_bd(vec!["remember".into(), value, "--key".into(), key, "--json".into()]).await.map(json_only)
}

#[tauri::command]
async fn memory_forget(key: String) -> Result<String, String> {
    run_bd(vec!["forget".into(), key]).await
}

// Read-only bd commands also rewrite lock/journal files, so mtime alone would loop
// forever. The Dolt manifest holds the root hash and only changes on real writes.
fn manifest_fingerprint(dir: &Path) -> Option<Vec<u8>> {
    let noms = dir.join("embeddeddolt");
    let entries = std::fs::read_dir(&noms).ok()?;
    let mut out = Vec::new();
    for e in entries.flatten() {
        let m = e.path().join(".dolt/noms/manifest");
        if let Ok(b) = std::fs::read(&m) {
            out.extend(b);
            out.push(b'\n');
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn start_watcher(app: AppHandle) {
    let dir = beads_dir();
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            if let Ok(ev) = res {
                let _ = tx.send(ev);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("watcher init failed: {e}");
                return;
            }
        };
        if let Err(e) = watcher.watch(&dir, RecursiveMode::Recursive) {
            eprintln!("watch {} failed: {e}", dir.display());
            return;
        }
        let mut last = manifest_fingerprint(&dir);
        let mut dirty_since: Option<Instant> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(_) => {
                    if dirty_since.is_none() {
                        dirty_since = Some(Instant::now());
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            if let Some(t) = dirty_since {
                if t.elapsed() >= Duration::from_millis(600) {
                    dirty_since = None;
                    let now = manifest_fingerprint(&dir);
                    if now.is_some() && now != last {
                        last = now;
                        let _ = app.emit("beads-changed", ());
                    }
                }
            }
        }
    });
}

// ---------- menu bar item: "2 在跑 · 1 等你" ----------

#[tauri::command]
fn tray_update(app: AppHandle, title: String, tooltip: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let t = if title.is_empty() { None } else { Some(title) };
        tray.set_title(t).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    let show = MenuItem::with_id(app, "show", "打开 Dispatch", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .icon_as_template(true)
        .title("bd")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            start_watcher(app.handle().clone());
            start_indexer();
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bd_info, bd_list, bd_show, bd_comments, bd_history, bd_claim, bd_set_status,
            bd_close, bd_reopen, bd_comment, bd_labels, bd_update, bd_create, sessions,
            task_sessions, resume_cmd, session_list, session_detail, focus_session, memories_list, memory_set, memory_forget,
            skills_list, skill_toggle, skill_read, skill_write, skill_open, tray_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
