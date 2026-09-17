use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// Embedded Dolt is single-writer with a file lock; serialize our own calls so they
// never contend with each other (only with external agents).
static BD_LOCK: Mutex<()> = Mutex::new(());
static BUNDLED_CLI: OnceLock<PathBuf> = OnceLock::new();
// ---- Native strings (tray menu, spawn errors) follow the interface language. The webview owns the
// choice (localStorage `dispatch-locale`) and pushes it here at startup and on every change; until
// then Chinese, the source language. The quota lines are kept so a language change can rebuild the menu.
static LOCALE: Mutex<String> = Mutex::new(String::new());
static TRAY_LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn locale() -> String { LOCALE.lock().map(|l| l.clone()).unwrap_or_default() }
fn tr(key: &'static str) -> &'static str {
    match (locale().as_str(), key) {
        ("en", "show") => "Open Dispatch", ("de", "show") => "Dispatch öffnen", (_, "show") => "打开 Dispatch",
        ("en", "quit") => "Quit", ("de", "quit") => "Beenden", (_, "quit") => "退出",
        ("en", "cannot_start") => "Cannot start {what} ({bin}): {err}", ("de", "cannot_start") => "{what} kann nicht gestartet werden ({bin}): {err}", (_, "cannot_start") => "无法启动 {what}（{bin}）：{err}",
        ("en", "not_skill_dir") => "Not inside a skills directory, refused: {path}", ("de", "not_skill_dir") => "Nicht im Skills-Verzeichnis, abgelehnt: {path}", (_, "not_skill_dir") => "不在技能目录里，拒绝：{path}",
        ("en", "no_python") => "No usable Python found (needs 3.9 or newer). Install one with `brew install python@3.12`, or run `xcode-select --install`, then reopen Dispatch. To pick a specific interpreter set DISPATCH_PYTHON.",
        ("de", "no_python") => "Kein nutzbares Python gefunden (3.9 oder neuer nötig). Installieren Sie es mit `brew install python@3.12` oder führen Sie `xcode-select --install` aus und öffnen Sie Dispatch erneut. Einen bestimmten Interpreter wählen Sie mit DISPATCH_PYTHON.",
        (_, "no_python") => "没找到可用的 Python（需要 3.9 或更新）。用 `brew install python@3.12` 装一个，或运行 `xcode-select --install`，然后重新打开 Dispatch。要指定解释器可设环境变量 DISPATCH_PYTHON。",
        ("en", "timed_out") => "{what} did not finish within {secs} s and was stopped. If this keeps happening, the task board's database may be stuck: try again, or restart Dispatch.",
        ("de", "timed_out") => "{what} wurde nach {secs} s ohne Ergebnis beendet. Passiert das wiederholt, hängt vielleicht die Datenbank des Aufgabenboards: erneut versuchen oder Dispatch neu starten.",
        (_, "timed_out") => "{what} 超过 {secs} 秒没有结束，已停止。反复出现的话，可能是任务板的数据库卡住了：重试，或重启 Dispatch。",
        ("en", "board_busy") => "The task board is busy with another operation; try again in a moment.",
        ("de", "board_busy") => "Das Aufgabenboard ist gerade mit einem anderen Vorgang beschäftigt; gleich noch einmal versuchen.",
        (_, "board_busy") => "任务板正在处理另一个操作，稍后再试。",
        ("en", "memories_parse") => "Could not parse memories: {err}", ("de", "memories_parse") => "Memories konnten nicht gelesen werden: {err}", (_, "memories_parse") => "memories 解析失败：{err}",
        _ => key,
    }
}
fn cannot_start(what: &str, bin: &Path, err: impl std::fmt::Display) -> String {
    tr("cannot_start").replace("{what}", what).replace("{bin}", &bin.display().to_string()).replace("{err}", &err.to_string())
}

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
    std::env::var("DISPATCH_ACTOR").unwrap_or_else(|_| home().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "user".into()))
}

struct Finished {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Run a child with a deadline. `Command::output()` waits for ever, and everything the UI shows
/// goes through one: a wedged Dolt server or a stalled ssh used to freeze the whole board with
/// no way out. Output is drained on threads, so a chatty child never blocks on a full pipe.
fn run_timed(mut cmd: Command, stdin: Option<String>, secs: u64, what: &str, bin: &Path) -> Result<Finished, String> {
    use std::io::{Read, Write};
    use std::process::Stdio;
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| cannot_start(what, bin, e))?;
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || { let _ = si.write_all(text.as_bytes()); });
    }
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let t_out = std::thread::spawn(move || { let mut b = Vec::new(); if let Some(r) = so.as_mut() { let _ = r.read_to_end(&mut b); } b });
    let t_err = std::thread::spawn(move || { let mut b = Vec::new(); if let Some(r) = se.as_mut() { let _ = r.read_to_end(&mut b); } b });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(tr("timed_out").replace("{what}", what).replace("{secs}", &secs.to_string()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok(Finished { status, stdout: t_out.join().unwrap_or_default(), stderr: t_err.join().unwrap_or_default() })
}

/// How long a `dispatch` subcommand may run. Most answer within seconds; a few do real work
/// (brew installs, an update download, a model writing a report, agents discussing).
fn dispatch_timeout(args: &[String]) -> u64 {
    let mut it = args.iter();
    let mut first = "";
    while let Some(a) = it.next() {
        if a == "--host" { it.next(); continue; }
        if a.starts_with('-') { continue; }
        first = a.as_str();
        break;
    }
    match first {
        "init" | "update" | "discuss" | "discuss-doc" | "discuss-conclude" | "split" | "agent" | "insights" | "screen" | "project" | "move"
        | "summarize" | "session-summary" | "project-summary" | "rules" | "profile" | "skills" | "memories" | "here" | "session-control" => 1800,
        _ => 180,
    }
}

/// PATH for every child process: GUI apps launched from the Dock do not inherit the shell's.
fn tool_path() -> String {
    format!(
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}:{}",
        home().join(".local/bin").display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

/// Apple's `/usr/bin/python3` and `/usr/bin/git` are stubs until the Command Line Tools are
/// installed; running one pops the system's install dialog. Only touch them when the tools exist.
fn clt_installed() -> bool {
    Path::new("/Library/Developer/CommandLineTools/usr/bin").is_dir() || Path::new("/Applications/Xcode.app/Contents/Developer").is_dir()
}

fn python_version(bin: &Path) -> Option<(u32, u32, String)> {
    let out = Command::new(bin).args(["-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"]).env("PYTHONDONTWRITEBYTECODE", "1").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut it = v.split('.').map(|x| x.parse::<u32>().unwrap_or(0));
    Some((it.next()?, it.next()?, v))
}

fn python_candidates() -> Vec<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("DISPATCH_PYTHON") {
        if !p.is_empty() {
            c.push(PathBuf::from(p));
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        c.push(PathBuf::from(dir).join("python3"));
        for minor in (9..=14).rev() {
            c.push(PathBuf::from(dir).join(format!("python3.{minor}")));
        }
    }
    c.push(home().join(".local/bin/python3"));
    if clt_installed() {
        c.push(PathBuf::from("/usr/bin/python3"));
    }
    c
}

/// The interpreter the bundled CLI runs on: the first Python ≥ 3.9 among the usual places.
/// Only a success is cached, so installing Python while Dispatch is open is picked up on the next call.
fn python_bin() -> Result<PathBuf, String> {
    static FOUND: std::sync::OnceLock<Mutex<Option<PathBuf>>> = std::sync::OnceLock::new();
    let cell = FOUND.get_or_init(|| Mutex::new(None));
    if let Ok(g) = cell.lock() {
        if let Some(p) = g.as_ref() {
            return Ok(p.clone());
        }
    }
    for c in python_candidates() {
        if !c.exists() {
            continue;
        }
        if let Some((major, minor, _)) = python_version(&c) {
            if major > 3 || (major == 3 && minor >= 9) {
                if let Ok(mut g) = cell.lock() {
                    *g = Some(c.clone());
                }
                return Ok(c);
            }
        }
    }
    Err(tr("no_python").to_string())
}

fn which_tool(name: &str) -> Option<PathBuf> {
    let dirs = [PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), home().join(".local/bin"), home().join("go/bin"), PathBuf::from("/usr/bin"), PathBuf::from("/bin")];
    dirs.iter().map(|d| d.join(name)).find(|p| p.exists())
}

/// What this Mac has, without going through Python: the first-run page shows it when the CLI
/// itself cannot start (no Python, or one too old), which is exactly when `init status` cannot.
#[tauri::command]
async fn env_check() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let py = python_bin().ok();
        let py_info = py.as_ref().and_then(|p| python_version(p)).map(|(_, _, v)| v);
        let tool = |n: &str| which_tool(n).map(|p| p.display().to_string());
        let clt = clt_installed();
        // /usr/bin/git is a stub without the Command Line Tools.
        let git = ["/opt/homebrew/bin/git", "/usr/local/bin/git"].iter().map(PathBuf::from).find(|p| p.exists()).map(|p| p.display().to_string())
            .or_else(|| if clt { Some("/usr/bin/git".to_string()) } else { None });
        let macos = Command::new("sw_vers").arg("-productVersion").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        serde_json::json!({
            "python": { "path": py.as_ref().map(|p| p.display().to_string()), "version": py_info, "ok": py.is_some() },
            "brew": tool("brew"), "bd": tool("bd"), "dolt": tool("dolt"), "herdr": tool("herdr"), "tmux": tool("tmux"), "tailscale": tool("tailscale").or_else(|| if Path::new("/Applications/Tailscale.app").exists() { Some("/Applications/Tailscale.app".to_string()) } else { None }),
            "git": git, "clt": clt, "macos": macos, "arch": std::env::consts::ARCH,
            "cli": dispatch_bin().display().to_string(), "cli_exists": dispatch_bin().exists(),
        })
    }).await.map_err(|e| e.to_string())
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
            // Wait for the board lock, but not for ever: whoever holds it has a deadline too.
            let waited = Instant::now();
            let _g = loop {
                match BD_LOCK.try_lock() {
                    Ok(g) => break g,
                    Err(std::sync::TryLockError::Poisoned(p)) => break p.into_inner(),
                    Err(std::sync::TryLockError::WouldBlock) => {
                        if waited.elapsed() > Duration::from_secs(45) {
                            return Err(tr("board_busy").to_string());
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
            };
            let mut cmd = Command::new(&bin);
            cmd.args(args)
                .current_dir(&workdir)
                .env("BEADS_DIR", &dir)
                .env("BEADS_ACTOR", actor())
                .env("BD_NON_INTERACTIVE", "1")
                .env("NO_COLOR", "1")
                .env("PATH", &path);
            run_timed(cmd, None, 30, "bd", &bin)?
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
        initial_view: std::env::var("DISPATCH_VIEW").ok().or_else(|| cli_arg("--view")),
        initial_task: std::env::var("DISPATCH_TASK").ok().or_else(|| cli_arg("--task")),
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

// bd's audit log records the actor of every field change; bd history does not.
#[tauri::command]
async fn bd_interactions(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = beads_dir().join("interactions.jsonl");
        let txt = std::fs::read_to_string(&p).unwrap_or_default();
        let needle = format!("\"issue_id\":\"{id}\"");
        let items: Vec<&str> = txt.lines().filter(|l| l.contains(&needle)).collect();
        Ok(format!("[{}]", items.join(",")))
    })
    .await
    .map_err(|e| e.to_string())?
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
    if let Some(p) = BUNDLED_CLI.get().filter(|p| p.is_file()) { return p.clone(); }
    for c in [home().join(".local/bin/dispatch"), PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../cli/dispatch.py")] {
        if c.exists() {
            return c;
        }
    }
    PathBuf::from("dispatch")
}

fn run_dispatch_blocking(args: &[String]) -> Result<String, String> {
    let bin = dispatch_bin();
    let path = tool_path();
    let mut cmd = Command::new(python_bin()?);
    cmd.arg(&bin)
        .args(args)
        .env("BEADS_DIR", beads_dir())
        .env("BEADS_ACTOR", actor()) // the GUI speaks as the human, whatever shell launched it
        .env("PYTHONDONTWRITEBYTECODE", "1") // a __pycache__ inside the .app breaks its code signature
        .env("PATH", path);
    let out = run_timed(cmd, None, dispatch_timeout(args), "dispatch", &bin)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn run_dispatch_stdin_blocking(args: &[String], stdin: Option<String>) -> Result<String, String> {
    let bin = dispatch_bin();
    let path = tool_path();
    let mut cmd = Command::new(python_bin()?);
    cmd.arg(&bin)
        .args(args)
        .env("BEADS_DIR", beads_dir())
        .env("BEADS_ACTOR", actor())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PATH", path);
    let out = run_timed(cmd, stdin, dispatch_timeout(args), "dispatch", &bin)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Run any dispatch subcommand, on this Mac or (via `dispatch --host`) on another one.
/// The UI uses it for the per-machine editors: rules, env, skills.
#[tauri::command]
async fn dispatch_on(host: Option<String>, args: Vec<String>, stdin: Option<String>) -> Result<String, String> {
    let mut full: Vec<String> = Vec::new();
    if let Some(h) = host.filter(|h| !h.is_empty() && h != "local") {
        full.push("--host".into());
        full.push(h);
    }
    full.extend(args);
    tauri::async_runtime::spawn_blocking(move || run_dispatch_stdin_blocking(&full, stdin))
        .await
        .map_err(|e| e.to_string())?
}

async fn run_dispatch(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_dispatch_blocking(&args))
        .await
        .map_err(|e| e.to_string())?
}

/// Pause between background runs: the normal pace while it works, doubling (up to half an hour)
/// while it fails, so a Mac without Python or bd does not fork a doomed process every minute.
fn backoff_secs(base: u64, failures: u32) -> u64 {
    if failures == 0 { base } else { (base << failures.min(5)).min(1800) }
}

fn start_indexer() {
    std::thread::spawn(|| {
        let mut failures = 0u32;
        loop {
            failures = if run_dispatch_blocking(&args(&["index", "--json"])).is_ok() { 0 } else { failures + 1 };
            std::thread::sleep(Duration::from_secs(backoff_secs(60, failures)));
        }
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

/// Hold the Mac awake for as long as Dispatch runs: phone replies, Herdr panes and the board sync
/// all live on this machine, and an idle-sleeping Mac mini drops them all. `caffeinate -w <pid>`
/// releases the assertion the moment the app exits. A desktop (no battery) also keeps its display
/// awake, so the screen never locks under GUI automation (AppleScript, screen capture); a laptop
/// only stops idle system sleep and may still dim its screen.
fn cli_arg(name: &str) -> Option<String> {
    let argv: Vec<String> = std::env::args().collect();
    argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).cloned()
}

fn keep_awake_file() -> PathBuf {
    home().join("tasks/.dispatch/keep-awake")
}

/// "off" | "system" | "display": this Mac's choice (设置 → 这台电脑). Default "system": stop idle
/// system sleep so agents and the phone service keep running, and let the screen sleep and lock as
/// the person configured it. "display" also keeps the screen on, for a Mac that is driven through
/// GUI automation or watched remotely.
fn keep_awake_mode() -> String {
    std::fs::read_to_string(keep_awake_file()).ok().map(|s| s.trim().to_string()).filter(|s| matches!(s.as_str(), "off" | "system" | "display")).unwrap_or_else(|| "system".into())
}

static CAFFEINATE: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn keep_awake() {
    if !cfg!(target_os = "macos") { return; }
    if let Ok(mut g) = CAFFEINATE.lock() {
        if let Some(mut old) = g.take() { let _ = old.kill(); let _ = old.wait(); }
        let flags = match keep_awake_mode().as_str() { "off" => return, "display" => "-dis", _ => "-is" };
        *g = Command::new("caffeinate").args([flags, "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().ok();
    }
}

#[tauri::command]
fn keep_awake_get() -> String { keep_awake_mode() }

#[tauri::command]
fn keep_awake_set(mode: String) -> Result<String, String> {
    if !matches!(mode.as_str(), "off" | "system" | "display") { return Err(format!("unknown mode {mode}")); }
    let f = keep_awake_file();
    if let Some(d) = f.parent() { let _ = std::fs::create_dir_all(d); }
    std::fs::write(&f, format!("{mode}\n")).map_err(|e| e.to_string())?;
    keep_awake();
    Ok(mode)
}

/// A second (third…) Dispatch window on the same app state, opened at `hash` (`#/sessions/<id>`,
/// `#/projects/<name>`…): two conversations side by side, a project's documents next to a chat.
/// Each window is a full copy of the UI with its own place; closing it does not touch the others.
#[tauri::command]
async fn open_window(app: tauri::AppHandle, hash: String) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let n = WINDOW_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let label = format!("view-{n}");
    let url = format!("index.html{}", if hash.starts_with('#') { hash } else { format!("#{hash}") });
    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("Dispatch").inner_size(1180.0, 800.0).min_inner_size(760.0, 520.0);
    #[cfg(target_os = "macos")]
    { b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true); }
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}
static WINDOW_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[tauri::command]
async fn session_list() -> Result<String, String> {
    run_dispatch(args(&["list", "--cached", "--limit", "500", "--json"])).await
}

#[tauri::command]
async fn session_activity() -> Result<String, String> {
    run_dispatch(args(&["activity", "--json"])).await
}

#[tauri::command]
async fn session_seen(host: String, key: String, reply: String) -> Result<String, String> {
    run_dispatch(args(&["--host", &host, "seen", &key, &reply, "--json"])).await
}

#[tauri::command]
async fn session_detail(id: String, brief: Option<bool>) -> Result<String, String> {
    // `brief`: the task page wants changed files and artifacts only, not the whole timeline.
    if brief.unwrap_or(false) {
        return run_dispatch(args(&["session", &id, "--json", "--brief"])).await;
    }
    run_dispatch(args(&["session", &id, "--json"])).await
}

#[tauri::command]
async fn focus_session(id: String) -> Result<String, String> {
    run_dispatch(args(&["focus", &id])).await
}

#[tauri::command]
fn resume_cmd(agent: String, session_id: String, cwd: String) -> String {
    let q = |v: &str| format!("'{}'", v.replace('\'', "'\\''"));
    let cd = if cwd.is_empty() { String::new() } else { format!("cd {} && ", q(&cwd)) };
    // Session ids are UUID-like; anything else gets quoted so a pasted command cannot run extra words.
    let sid = if session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { session_id.clone() } else { q(&session_id) };
    match agent.as_str() {
        "codex" => format!("{cd}codex resume {sid}"),
        _ => format!("{cd}claude --resume {sid}"),
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
    // The CLI knows where skills may live (the pool, each agent's folder, the workspace roots).
    let allowed: Vec<PathBuf> = run_dispatch_blocking(&args(&["skills", "roots"]))?.lines().map(|l| PathBuf::from(l.trim())).filter(|p| !p.as_os_str().is_empty()).collect();
    if !allowed.iter().any(|d| std::fs::canonicalize(d).map(|d| real.starts_with(d)).unwrap_or(false)) {
        return Err(tr("not_skill_dir").replace("{path}", &real.display().to_string()));
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

#[tauri::command]
async fn insights(days: u32) -> Result<String, String> {
    run_dispatch(args(&["insights", "--days", &days.to_string(), "--json"])).await
}

#[tauri::command]
async fn env_list() -> Result<String, String> {
    run_dispatch(args(&["env", "list", "--json"])).await
}

#[tauri::command]
async fn env_get(name: String) -> Result<String, String> {
    run_dispatch(args(&["env", "get", &name])).await.map(|s| s.trim_end().to_string())
}

#[tauri::command]
async fn env_set(name: String, value: String, note: String) -> Result<String, String> {
    run_dispatch(args(&["env", "set", &name, &value, "--note", &note])).await
}

#[tauri::command]
async fn env_unset(name: String) -> Result<String, String> {
    run_dispatch(args(&["env", "unset", &name])).await
}

#[tauri::command]
async fn skills_improve(days: u32) -> Result<String, String> {
    run_dispatch(args(&["skills", "improve", "--days", &days.to_string(), "--json"])).await
}

#[tauri::command]
async fn folders() -> Result<String, String> {
    run_dispatch(args(&["folders", "--cached", "--json"])).await
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let out = Command::new("open").arg(&path).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

#[tauri::command]
async fn graph() -> Result<String, String> {
    run_dispatch(args(&["graph", "--json"])).await
}

#[tauri::command]
async fn quota() -> Result<String, String> {
    run_dispatch(args(&["quota", "--json"])).await
}

#[tauri::command]
async fn hosts() -> Result<String, String> {
    run_dispatch(args(&["hosts", "--json"])).await
}

#[derive(Deserialize)]
struct AgentStart {
    kind: String,
    host: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    task: Option<String>,
    prompt: Option<String>,
    label: Option<String>,
    timeout: Option<u64>,
}

// Hand work to another agent through Herdr (dispatch agent start), here or on another Mac.
#[tauri::command]
async fn agent_start(input: AgentStart) -> Result<String, String> {
    let mut a = args(&["agent", "start", &input.kind, "--json", "--no-wait"]);
    for (flag, v) in [("--host", input.host), ("--cwd", input.cwd), ("--model", input.model), ("--task", input.task), ("--prompt", input.prompt), ("--label", input.label)] {
        if let Some(v) = v.filter(|s| !s.trim().is_empty()) {
            a.push(flag.into());
            a.push(v);
        }
    }
    a.push("--timeout".into());
    a.push(input.timeout.unwrap_or(600_000).to_string());
    run_dispatch(a).await
}

#[tauri::command]
async fn stats(agent: Option<String>, days: Option<u32>) -> Result<String, String> {
    let mut a = args(&["stats", "--cached", "--json"]);
    if let Some(ag) = agent.filter(|s| !s.is_empty()) {
        a.push("--agent".into());
        a.push(ag);
    }
    if let Some(d) = days.filter(|d| *d > 0) {
        a.push("--days".into());
        a.push(d.to_string());
    }
    run_dispatch(a).await
}

// ---------- global rules: one markdown file synced into every agent ----------

fn rules_path() -> Result<PathBuf, String> {
    let p = run_dispatch_blocking(&args(&["rules", "path"]))?;
    Ok(PathBuf::from(p.trim()))
}

#[tauri::command]
async fn rules_read() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let p = rules_path()?;
        Ok(std::fs::read_to_string(&p).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rules_write(content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = rules_path()?;
        let real = std::fs::canonicalize(&p).unwrap_or(p.clone());
        let _ = std::fs::copy(&real, real.with_extension("md.bak"));
        std::fs::write(&real, content).map_err(|e| e.to_string())?;
        run_dispatch_blocking(&args(&["rules", "sync", "--json"]))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rules_status() -> Result<String, String> {
    run_dispatch(args(&["rules", "status", "--json"])).await
}

#[tauri::command]
async fn rules_sync() -> Result<String, String> {
    run_dispatch(args(&["rules", "sync", "--force", "--json"])).await
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
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| tr("memories_parse").replace("{err}", &e.to_string()))?;
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

// In shared-server mode the data lives under ~/.beads/shared-server/dolt/<db>
// and only the server writes there (reads go over TCP), so plain mtime works.
fn server_data_dir() -> Option<PathBuf> {
    let cfg = std::fs::read_to_string(beads_dir().join("config.yaml")).ok()?;
    if !cfg.contains("mode: server") {
        return None;
    }
    let db = cfg
        .lines()
        .find_map(|l| l.trim().strip_prefix("database:").map(|v| v.trim().to_string()))
        .unwrap_or_else(|| "task".into());
    let dir = home().join(".beads/shared-server/dolt").join(db);
    if dir.exists() { Some(dir) } else { None }
}

// bd does not resurrect the shared Dolt server; `bd dolt start` is idempotent.
fn ensure_dolt_server() {
    std::thread::spawn(|| {
        let mut failures = 0u32;
        loop {
            // First-run setup installs a LaunchAgent that keeps the board's Dolt server up (the hub
            // runs it from its config, a joined Mac runs `bd dolt start` on a timer): when one
            // exists this loop would only duplicate it, and on the hub `bd dolt start` is wrong.
            let agents = home().join("Library/LaunchAgents");
            let managed = ["dev.dispatch", "dev.schaefer"].iter().any(|p| ["dolt-server", "beads-dolt"].iter().any(|n| agents.join(format!("{p}.{n}.plist")).exists()));
            if !managed && beads_dir().exists() {
                failures = if run_bd_blocking(&args(&["dolt", "start"])).is_ok() { 0 } else { failures + 1 };
            }
            std::thread::sleep(Duration::from_secs(backoff_secs(120, failures)));
        }
    });
}

fn start_watcher(app: AppHandle) {
    let server_dir = server_data_dir();
    let dir = server_dir.clone().unwrap_or_else(beads_dir);
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
                    if server_dir.is_some() {
                        let _ = app.emit("beads-changed", ());
                        continue;
                    }
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

// ---------- compact menu bar status ----------

#[cfg(target_os = "macos")]
fn compact_tray_title(tray: &tauri::tray::TrayIcon, title: String) -> Result<(), String> {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSAttributedStringNSStringDrawing, NSBaselineOffsetAttributeName,
        NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSKernAttributeName};
    use objc2_foundation::{NSMutableAttributedString, NSNumber, NSRange, NSString};

    // Tauri schedules this closure on the AppKit main thread. Keep native objects there.
    tray.with_inner_tray_icon(move |inner| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(item) = inner.ns_status_item() else { return };
        let Some(button) = item.button(mtm) else { return };
        let text = NSMutableAttributedString::initWithString(
            NSMutableAttributedString::alloc(), &NSString::from_str(&title));
        let full = NSRange::new(0, title.encode_utf16().count());
        let font = NSFont::monospacedDigitSystemFontOfSize_weight(10.0, 0.0);
        let dot_font = NSFont::monospacedDigitSystemFontOfSize_weight(5.5, 0.0);
        let dot = NSMutableAttributedString::initWithString(
            NSMutableAttributedString::alloc(), &NSString::from_str("●"));
        // Attribute values follow AppKit's NSFont / NSColor / NSNumber contracts.
        unsafe {
            dot.addAttribute_value_range(NSFontAttributeName, &dot_font, NSRange::new(0, 1));
            let dot_width = dot.size().width;
            text.addAttribute_value_range(NSFontAttributeName, &font, full);
            text.addAttribute_value_range(NSForegroundColorAttributeName, &NSColor::labelColor(), full);
            let mut dots = 0;
            for (index, ch) in title.encode_utf16().enumerate() {
                if ch != '●' as u16 { continue; }
                let range = NSRange::new(index, 1);
                let color = if dots == 0 { NSColor::systemBlueColor() } else { NSColor::systemYellowColor() };
                text.addAttribute_value_range(NSForegroundColorAttributeName, &color, range);
                text.addAttribute_value_range(NSFontAttributeName, &dot_font, range);
                text.addAttribute_value_range(NSBaselineOffsetAttributeName,
                    &NSNumber::new_f64(if dots == 0 { 4.0 } else { -1.0 }), range);
                // Cancel the first dot's advance: both dots occupy one column between counts.
                if dots == 0 {
                    text.addAttribute_value_range(NSKernAttributeName, &NSNumber::new_f64(-dot_width), range);
                }
                dots += 1;
            }
        }
        button.setAttributedTitle(&text);
    }).map_err(|e| e.to_string())
}

// The click menu carries what the title should not: one line per agent's quota, between
// "open" and "quit". Rebuilt on every quota refresh and on a language change.
fn tray_menu<M: Manager<tauri::Wry>>(m: &M, lines: &[String]) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let show = MenuItem::with_id(m, "show", tr("show"), true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(m, "quit", tr("quit"), true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::new(m).map_err(|e| e.to_string())?;
    menu.append(&show).map_err(|e| e.to_string())?;
    if !lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        for (i, line) in lines.iter().enumerate() {
            let item = MenuItem::with_id(m, format!("quota-{i}"), line, false, None::<&str>).map_err(|e| e.to_string())?;
            menu.append(&item).map_err(|e| e.to_string())?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    menu.append(&quit).map_err(|e| e.to_string())?;
    Ok(menu)
}

#[tauri::command]
fn tray_update(app: AppHandle, title: String, tooltip: String, lines: Vec<String>) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        #[cfg(target_os = "macos")]
        compact_tray_title(&tray, title)?;
        #[cfg(not(target_os = "macos"))]
        tray.set_title(Some(title)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
        let menu = tray_menu(&app, &lines)?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    if let Ok(mut l) = TRAY_LINES.lock() { *l = lines; }
    Ok(())
}

// The webview's language choice: remembered for native strings, and the tray menu is rebuilt in it.
#[tauri::command]
fn set_locale(app: AppHandle, locale: String) -> Result<(), String> {
    let locale = match locale.as_str() { "en" | "de" => locale, _ => "zh".to_string() };
    if let Ok(mut l) = LOCALE.lock() { if *l == locale { return Ok(()); } *l = locale; }
    let lines = TRAY_LINES.lock().map(|l| l.clone()).unwrap_or_default();
    if let Some(tray) = app.tray_by_id("main") {
        let menu = tray_menu(&app, &lines)?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::tray::TrayIconBuilder;
    let menu = tray_menu(app, &[])?;
    TrayIconBuilder::with_id("main")
        // Original monochrome menu bar icon, at its original size.
        .icon(tauri::image::Image::new(include_bytes!("../icons/tray.rgba"), 44, 44))
        .icon_as_template(true)
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
        // One Dispatch per login: a second launch (the Dock, `open -a`, a script passing
        // `--view <name> [--task <id>]`) brings the running window forward and tells it where to go,
        // instead of starting a second set of watchers, indexers and keep-awake helpers.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let arg = |name: &str| argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).cloned();
            let (view, task) = (arg("--view"), arg("--task"));
            if view.is_some() || task.is_some() {
                let _ = app.emit("dispatch-navigate", serde_json::json!({ "view": view, "task": task }));
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Ok(resources) = app.path().resource_dir() { let _ = BUNDLED_CLI.set(resources.join("cli/dispatch.py")); }
            keep_awake();
            ensure_dolt_server();
            start_watcher(app.handle().clone());
            start_indexer();
            build_tray(app)?;
            // The red close button hides the window; the app keeps running in the menu bar.
            // 退出 lives in the tray menu (and ⌘Q).
            if let Some(w) = app.get_webview_window("main") {
                let win = w.clone();
                w.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bd_info, bd_list, bd_show, bd_comments, bd_history, bd_interactions, bd_claim, bd_set_status,
            bd_close, bd_reopen, bd_comment, bd_labels, bd_update, bd_create, sessions,
            task_sessions, resume_cmd, session_list, open_window, session_activity, session_seen, session_detail, focus_session, memories_list, memory_set, memory_forget,
            skills_list, skill_toggle, skill_read, skill_write, skill_open, skills_improve, env_list, env_get, env_set, env_unset, insights, dispatch_on, tray_update, set_locale,
            rules_read, rules_write, rules_status, rules_sync, quota, stats, hosts, agent_start, graph, folders, open_path, env_check, keep_awake_get, keep_awake_set
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the Dock icon brings the hidden window back.
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        });
}
