use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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
async fn bd_run(argv: Vec<String>) -> Result<String, String> {
    run_bd(argv).await
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

#[derive(Serialize, Deserialize, Clone)]
struct Session {
    agent: String,
    session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    agent_pid: Option<i64>,
    #[serde(default)]
    source_kind: String,
    #[serde(default)]
    source_app: String,
    #[serde(default)]
    entrypoint: String,
    #[serde(default)]
    started_at: f64,
    #[serde(default)]
    last_at: f64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    prompts: i64,
    #[serde(default)]
    alive: bool,
    #[serde(default)]
    registered: bool,
}

#[derive(Serialize)]
struct Presence {
    sessions: Vec<Session>,
    apps: Vec<String>,
}

fn sessions_dir() -> PathBuf {
    home().join("tasks/.dispatch/sessions")
}

// Registry written by the presence hook, cross-checked against live processes so
// crashed sessions disappear and hook-less sessions (plain `claude`/`codex`
// processes) still get counted.
const APP_SOURCES: &[(&str, &str, &str)] = &[
    ("Claude.app/", "desktop", "Claude 桌面端"),
    ("ChatGPT.app/", "desktop", "ChatGPT 桌面端"),
    ("Cursor.app/", "editor", "Cursor"),
    ("Visual Studio Code.app/", "editor", "VS Code"),
    ("Windsurf.app/", "editor", "Windsurf"),
    ("Zed.app/", "editor", "Zed"),
    ("Warp.app/", "terminal", "Warp"),
    ("iTerm.app/", "terminal", "iTerm2"),
    ("Terminal.app/", "terminal", "Terminal"),
    ("Ghostty.app/", "terminal", "Ghostty"),
    ("kitty.app/", "terminal", "kitty"),
    ("Alacritty.app/", "terminal", "Alacritty"),
    ("WezTerm.app/", "terminal", "WezTerm"),
];

// Same classification as presence.py: walk parents until an app bundle or a
// known multiplexer shows up.
fn classify_chain(pid: i64, table: &std::collections::HashMap<i64, (i64, String)>) -> (String, String) {
    let mut cur = pid;
    for _ in 0..25 {
        let Some((ppid, comm)) = table.get(&cur) else { break };
        for (needle, kind, label) in APP_SOURCES {
            if comm.contains(needle) {
                return (kind.to_string(), label.to_string());
            }
        }
        let base = comm.rsplit('/').next().unwrap_or(comm).trim_start_matches('-');
        match base {
            "herdr" => return ("terminal".into(), "Herdr".into()),
            "tmux" => return ("terminal".into(), "tmux".into()),
            "zellij" => return ("terminal".into(), "zellij".into()),
            _ => {}
        }
        if *ppid <= 1 {
            break;
        }
        cur = *ppid;
    }
    ("terminal".into(), "终端".into())
}

fn cwd_of(pid: i64) -> String {
    let out = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    out.lines()
        .find(|l| l.starts_with('n'))
        .map(|l| l[1..].to_string())
        .unwrap_or_default()
}

fn read_presence() -> Presence {
    let ps = Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let mut alive: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    let mut table: std::collections::HashMap<i64, (i64, String)> = std::collections::HashMap::new();
    let mut apps: Vec<String> = Vec::new();
    for line in ps.lines() {
        let mut it = line.trim().splitn(3, ' ');
        let (Some(pid), Some(ppid), Some(comm)) = (it.next(), it.next(), it.next()) else { continue };
        if let (Ok(pid), Ok(ppid)) = (pid.parse::<i64>(), ppid.trim().parse::<i64>()) {
            {
                let comm = comm.trim().to_string();
                table.insert(pid, (ppid, comm.clone()));
                for (needle, name) in [
                    ("/Applications/Claude.app/Contents/MacOS/Claude", "Claude 桌面端"),
                    ("/ChatGPT.app/Contents/MacOS/ChatGPT", "ChatGPT 桌面端"),
                    ("/Cursor.app/Contents/MacOS/Cursor", "Cursor"),
                    ("/Visual Studio Code.app/Contents/MacOS/Electron", "VS Code"),
                ] {
                    if comm.ends_with(needle) || comm.contains(needle) {
                        if !apps.iter().any(|a| a == name) {
                            apps.push(name.to_string());
                        }
                    }
                }
                alive.insert(pid, comm);
            }
        }
    }
    let mut sessions: Vec<Session> = Vec::new();
    let mut seen_pids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    if let Ok(rd) = std::fs::read_dir(sessions_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x != "json").unwrap_or(true) {
                continue;
            }
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
            let Ok(mut s) = serde_json::from_str::<Session>(&txt) else { continue };
            s.registered = true;
            s.alive = match s.agent_pid {
                Some(pid) => alive.contains_key(&pid),
                None => true,
            };
            if let Some(pid) = s.agent_pid {
                seen_pids.insert(pid);
            }
            if s.alive {
                sessions.push(s);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    // Sessions that never ran the hook (started before it was installed).
    for (pid, comm) in &alive {
        if seen_pids.contains(pid) {
            continue;
        }
        let base = comm.rsplit('/').next().unwrap_or(comm).trim_start_matches('-');
        let agent = match base {
            "claude" => "claude-code",
            "codex" => "codex",
            _ => continue,
        };
        let (kind, app) = classify_chain(*pid, &table);
        let cwd = cwd_of(*pid);
        let project = cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
        sessions.push(Session {
            agent: agent.into(),
            session_id: format!("pid-{pid}"),
            cwd,
            project,
            agent_pid: Some(*pid),
            source_kind: kind,
            source_app: app,
            entrypoint: String::new(),
            started_at: 0.0,
            last_at: 0.0,
            state: "unknown".into(),
            prompts: 0,
            alive: true,
            registered: false,
        });
    }
    sessions.sort_by(|a, b| b.last_at.partial_cmp(&a.last_at).unwrap_or(std::cmp::Ordering::Equal));
    Presence { sessions, apps }
}

#[tauri::command]
async fn sessions() -> Result<Presence, String> {
    tauri::async_runtime::spawn_blocking(read_presence)
        .await
        .map_err(|e| e.to_string())
}

// ---------- transcript index: task id → sessions that touched it ----------

#[derive(Clone)]
struct Transcript {
    agent: String,
    session_id: String,
    cwd: String,
    mtime: f64,
    size: u64,
    scanned_to: u64,
    tasks: std::collections::HashMap<String, u32>,
}

static INDEX: Mutex<Option<std::collections::HashMap<PathBuf, Transcript>>> = Mutex::new(None);

fn walk_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_jsonl(&p, out, depth + 1);
        } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
            out.push(p);
        }
    }
}

fn epoch(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn task_prefix() -> String {
    // The board's issue prefix doubles as the Dolt database name in metadata.json.
    std::fs::read_to_string(beads_dir().join("metadata.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("dolt_database").and_then(|p| p.as_str()).map(String::from))
        .unwrap_or_else(|| "task".into())
}

// Incremental: only bytes appended since the last pass are re-read, so the
// 60s refresh is cheap even with hundreds of MB of history on disk.
fn refresh_index() {
    let prefix = task_prefix();
    let re_task = regex::Regex::new(&format!(r"\b{}-[a-z0-9]{{2,8}}\b", regex::escape(&prefix))).unwrap();
    let re_cwd = regex::Regex::new(r#""cwd":"([^"]+)""#).unwrap();
    let mut files: Vec<(PathBuf, &str)> = Vec::new();
    let mut v = Vec::new();
    walk_jsonl(&home().join(".claude/projects"), &mut v, 0);
    files.extend(v.drain(..).map(|p| (p, "claude-code")));
    walk_jsonl(&home().join(".codex/sessions"), &mut v, 0);
    files.extend(v.drain(..).map(|p| (p, "codex")));

    let mut idx = INDEX.lock().map(|g| g.clone().unwrap_or_default()).unwrap_or_default();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for (path, agent) in files {
        seen.insert(path.clone());
        let Ok(md) = std::fs::metadata(&path) else { continue };
        let mtime = epoch(md.modified());
        let size = md.len();
        let entry = idx.entry(path.clone()).or_insert_with(|| Transcript {
            agent: agent.into(),
            session_id: String::new(),
            cwd: String::new(),
            mtime: 0.0,
            size: 0,
            scanned_to: 0,
            tasks: Default::default(),
        });
        if entry.mtime == mtime && entry.size == size {
            continue;
        }
        if size < entry.scanned_to {
            entry.scanned_to = 0;
            entry.tasks.clear();
        }
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut f) = std::fs::File::open(&path) else { continue };
        let _ = f.seek(SeekFrom::Start(entry.scanned_to));
        let mut buf = String::new();
        if f.read_to_string(&mut buf).is_err() {
            // binary garbage or non-utf8 chunk: skip this file for now
            entry.mtime = mtime;
            entry.size = size;
            continue;
        }
        if entry.session_id.is_empty() {
            if agent == "claude-code" {
                entry.session_id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            } else if let Some(first) = buf.lines().next() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(first) {
                    let p = v.get("payload").cloned().unwrap_or(v.clone());
                    entry.session_id = p.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    entry.cwd = p.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string();
                }
            }
        }
        if entry.cwd.is_empty() {
            if let Some(c) = re_cwd.captures(&buf) {
                entry.cwd = c[1].to_string();
            }
        }
        for m in re_task.find_iter(&buf) {
            *entry.tasks.entry(m.as_str().to_string()).or_insert(0) += 1;
        }
        entry.scanned_to = size;
        entry.mtime = mtime;
        entry.size = size;
    }
    idx.retain(|p, _| seen.contains(p));
    if let Ok(mut g) = INDEX.lock() {
        *g = Some(idx);
    }
}

fn start_indexer() {
    std::thread::spawn(|| loop {
        refresh_index();
        std::thread::sleep(Duration::from_secs(60));
    });
}

#[derive(Serialize)]
struct SessionRef {
    agent: String,
    session_id: String,
    cwd: String,
    project: String,
    last_at: f64,
    mentions: u32,
    resume_cmd: String,
}

fn resume_command(agent: &str, session_id: &str, cwd: &str) -> String {
    let cd = if cwd.is_empty() { String::new() } else { format!("cd '{}' && ", cwd.replace('\'', "'\\''")) };
    match agent {
        "codex" => format!("{cd}codex resume {session_id}"),
        _ => format!("{cd}claude --resume {session_id}"),
    }
}

#[tauri::command]
async fn task_sessions(id: String) -> Result<Vec<SessionRef>, String> {
    let idx = INDEX.lock().map_err(|e| e.to_string())?.clone().unwrap_or_default();
    let mut out: Vec<SessionRef> = idx
        .values()
        .filter(|t| !t.session_id.is_empty() && t.tasks.contains_key(&id))
        .map(|t| SessionRef {
            agent: t.agent.clone(),
            session_id: t.session_id.clone(),
            cwd: t.cwd.clone(),
            project: t.cwd.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string(),
            last_at: t.mtime,
            mentions: t.tasks[&id],
            resume_cmd: resume_command(&t.agent, &t.session_id, &t.cwd),
        })
        .collect();
    out.sort_by(|a, b| b.last_at.partial_cmp(&a.last_at).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[tauri::command]
fn resume_cmd(agent: String, session_id: String, cwd: String) -> String {
    resume_command(&agent, &session_id, &cwd)
}

#[tauri::command]
async fn index_status() -> Result<(usize, bool), String> {
    let g = INDEX.lock().map_err(|e| e.to_string())?;
    Ok(match &*g {
        Some(m) => (m.len(), true),
        None => (0, false),
    })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            start_watcher(app.handle().clone());
            start_indexer();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bd_info, bd_run, bd_list, bd_show, bd_comments, bd_history, bd_claim, bd_set_status,
            bd_close, bd_reopen, bd_comment, bd_labels, bd_update, bd_create, sessions,
            task_sessions, resume_cmd, index_status, memories_list, memory_set, memory_forget
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
