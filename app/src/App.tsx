import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi, isTauri, type Api } from "./api";
import { Detail } from "./components/Detail";
import { NewTask } from "./components/NewTask";
import { Sidebar, type Filters } from "./components/Sidebar";
import { AgentsView, Board, TableView } from "./components/views";
import { PitfallsView } from "./components/Pitfalls";
import { SessionsView } from "./components/Sessions";
import { SkillsView } from "./components/Skills";
import { RulesView } from "./components/Rules";
import { EnvView } from "./components/Env";
import { InboxView, type InboxItems } from "./components/Inbox";
import { HomeView } from "./components/Home";
import { GraphView } from "./components/Graph";
import { FoldersView } from "./components/Folders";
import { ProjectsView } from "./components/Projects";
import { Tour } from "./components/Guide";
import { StatsView } from "./components/Stats";
import { agentsFrom, columnOf, isReviewed, projectOf, rootsOf } from "./derive";
import type { Column, Info, Issue, NewIssue, Presence, SessionRef, View } from "./types";

type Theme = "light" | "dark" | "";
const VIEW_LABEL: Record<View, string> = { home: "总览", inbox: "等你", board: "全部任务", table: "全部任务", graph: "脉络", projects: "项目", folders: "文件夹", agents: "Agent 状态", sessions: "聊天记录", stats: "统计", skills: "技能", rules: "规则", pitfalls: "知识库", env: "环境" };
const VIEWS: View[] = ["home", "inbox", "board", "table", "graph", "projects", "folders", "agents", "sessions", "stats", "skills", "rules", "pitfalls", "env"];
const BOARD_VIEWS: View[] = ["board", "table"];

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [presence, setPresence] = useState<Presence>({ sessions: [], apps: [] });
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [view, setView] = useState<View>("home");
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ project: null, mine: false, urgent: false, agent: null, blocked: false, review: false });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [sessionFocus, setSessionFocus] = useState<string | null>(null);
  // The tour never opens on its own; the design should carry itself. `?` still has it.
  const [tour, setTour] = useState(false);
  const closeTour = () => setTour(false);
  const openSession = (id: string) => { setSessionFocus(id); setView("sessions"); };
  const [version, setVersion] = useState(0);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem("dispatch-theme") as Theme) ?? ""; } catch { return ""; } });
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const me = info?.actor ?? "schaefer";

  const say = useCallback((text: string, isErr = false) => {
    setToast({ text, err: isErr });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), isErr ? 6000 : 1800);
  }, []);

  const reload = useCallback(async (a?: Api) => {
    const x = a ?? api;
    if (!x) return;
    try {
      const list = await x.list();
      setIssues(list);
      setErr(null);
      setLastSync(new Date());
      setVersion((v) => v + 1);
    } catch (e) { setErr(String(e)); }
  }, [api]);

  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      const a = await getApi();
      setApi(a);
      try {
        const inf = await a.info();
        setInfo(inf);
        if ((VIEWS as string[]).includes(inf.initial_view ?? "")) setView(inf.initial_view as View);
        if (inf.initial_task && !inf.initial_task.startsWith("session:")) setSelected(inf.initial_task);
      } catch (e) { setErr(String(e)); }
      await reload(a);
      off = await a.onChange(() => reload(a));
    })();
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!api) return;
    // Backstop for the file watcher; cheap now that bd runs against the shared server.
    const t = window.setInterval(() => reload(), 10_000);
    return () => window.clearInterval(t);
  }, [api, reload]);

  // Presence is cheap (a ps call + a few JSON files), so poll it often.
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const p = await api.presence(); if (alive) setPresence(p); } catch { /* keep last */ } };
    tick();
    const t = window.setInterval(tick, 5_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [api]);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("dispatch-theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating(true); }
      if (e.key === "Escape" && document.activeElement === searchRef.current) { setQuery(""); searchRef.current?.blur(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Lineage roots (which thread each task belongs to), refreshed with the issue list.
  const [roots, setRoots] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.graph().then((g) => { if (alive) setRoots(rootsOf(g.edges)); }).catch(() => {});
    return () => { alive = false; };
  }, [api, version]);
  const rootIssue = useCallback((id: string): Issue | undefined => { const r = roots.get(id); return r ? issues.find((i) => i.id === r) : undefined; }, [roots, issues]);

  const agents = useMemo(() => agentsFrom(issues, me, presence.sessions), [issues, me, presence]);
  const liveSessions = presence.sessions.filter((s) => s.alive).length;

  // Transcript index (titles, last claimed task) keyed by session id, for the Agents view.
  const [refs, setRefs] = useState<Map<string, SessionRef>>(new Map());
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const l = await api.sessionList(); if (alive) setRefs(new Map(l.map((r) => [r.session_id, r]))); } catch { /* index not ready */ } };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [api]);
  const projects = useMemo(() => {
    const m = new Map<string, number>();
    issues.forEach((i) => m.set(projectOf(i), (m.get(projectOf(i)) ?? 0) + 1));
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : b.count - a.count));
  }, [issues]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((i) => {
      if (filters.project !== null && projectOf(i) !== filters.project) return false;
      if (filters.mine && i.assignee !== me) return false;
      if (filters.urgent && i.priority > 1) return false;
      if (filters.agent && i.assignee !== filters.agent) return false;
      if (filters.blocked && i.status !== "blocked") return false;
      if (filters.review && !(i.status === "closed" && !isReviewed(i))) return false;
      if (q && !(i.title.toLowerCase().includes(q) || i.id.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q) || (i.assignee ?? "").toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => a.priority - b.priority || b.updated_at.localeCompare(a.updated_at));
  }, [issues, filters, query, me]);

  const inbox = useMemo<InboxItems>(() => ({
    waiting: presence.sessions.filter((s) => s.alive && s.state === "idle" && s.registered).sort((a, b) => b.last_at - a.last_at),
    review: issues.filter((i) => i.status === "closed" && !isReviewed(i)).sort((a, b) => (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at)),
    blocked: issues.filter((i) => i.status === "blocked"),
  }), [issues, presence]);

  const counts = useMemo(() => ({
    total: issues.filter((i) => i.status !== "closed").length,
    blocked: inbox.blocked.length,
    review: inbox.review.length,
    agents: agents.filter((a) => a.online).length,
    inbox: inbox.waiting.length + inbox.review.length + inbox.blocked.length,
  }), [issues, agents, inbox]);

  // Notifications: only for things that newly entered the inbox after the first load.
  const seen = useRef<{ ready: boolean; waiting: Set<string>; review: Set<string> }>({ ready: false, waiting: new Set(), review: new Set() });
  useEffect(() => {
    if (!api) return;
    const s = seen.current;
    const w = new Set(inbox.waiting.map((x) => x.session_id));
    const r = new Set(inbox.review.map((x) => x.id));
    if (s.ready) {
      for (const x of inbox.waiting) if (!s.waiting.has(x.session_id)) api.notify(`${x.agent === "codex" ? "Codex" : x.agent === "zcode" ? "ZCode" : x.agent === "qoder" ? "Qoder" : x.agent === "qoder-ide" ? "Qoder IDE" : "Claude Code"} 在等你`, `${x.herdr?.title || x.title || x.project || x.cwd}（${x.source_app}）`);
      for (const x of inbox.review) if (!s.review.has(x.id)) api.notify("有任务待你审核", `${x.id} ${x.title}`);
    }
    s.waiting = w; s.review = r;
    if (!s.ready && (presence.sessions.length > 0 || issues.length > 0)) s.ready = true;
  }, [inbox, api, presence.sessions.length, issues.length]);

  useEffect(() => {
    if (!api) return;
    const working = presence.sessions.filter((s) => s.alive && s.state === "working").length;
    // Menu bars fill up fast; keep the status text to a few characters.
    const parts = [working ? `${working}跑` : "", inbox.waiting.length ? `${inbox.waiting.length}等` : "", inbox.review.length ? `${inbox.review.length}审` : ""].filter(Boolean);
    api.tray(parts.join(" "), `Dispatch · ${working} 在跑 · ${inbox.waiting.length} 等你 · ${inbox.review.length} 待审 · ${issues.filter((i) => i.status !== "closed").length} 项未完成`).catch(() => {});
  }, [api, presence, inbox, issues]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); say(label); await reload(); } catch (e) { say(String(e), true); }
  };

  const move = (id: string, to: Column) => {
    if (!api) return;
    const i = issues.find((x) => x.id === id);
    if (!i || columnOf(i) === to) return;
    const closed = i.status === "closed";
    if (to === "todo") return run("移到待办", async () => { if (closed) await api.reopen(id); else await api.setStatus(id, "open"); });
    // Moving to 进行中 only changes status; the person viewing never becomes the assignee.
    if (to === "prog") return run("移到进行中", async () => { if (closed) await api.reopen(id); await api.setStatus(id, "in_progress"); });
    if (to === "done") return run("标记完成", async () => { if (closed) await api.labels(id, [], ["reviewed"]); else await api.close(id, "在 Dispatch 里拖到已完成"); });
    if (to === "reviewed") return run("审核通过", async () => { if (!closed) await api.close(id, "在 Dispatch 里拖到已审核"); await api.labels(id, ["reviewed"], []); });
  };

  const create = async (input: NewIssue) => {
    if (!api) return;
    try { const i = await api.create(input); setCreating(false); say(`已创建 ${i?.id ?? ""}`); await reload(); if (i?.id) setSelected(i.id); } catch (e) { say(String(e), true); }
  };

  const nextTheme = () => setTheme(theme === "" ? "dark" : theme === "dark" ? "light" : "");

  const focusSession = async (id: string) => {
    if (!api) return;
    try { say((await api.focusSession(id)).trim() || "已切过去"); } catch (e) { say(String(e), true); }
  };

  const copyResume = async (agent: string, sessionId: string, cwd: string) => {
    if (!api) return;
    try { const cmd = await api.resumeCmd(agent, sessionId, cwd); await api.copy(cmd); say("恢复命令已复制，去终端粘贴回车"); } catch (e) { say(String(e), true); }
  };

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="lead" data-tauri-drag-region><b>Dispatch</b><span className="muted">调度台</span></div>
        <div className="crumb" data-tauri-drag-region>
          <b className="link" onClick={() => setView("home")}>全局板</b><span className="sep">›</span><span>{VIEW_LABEL[view]}</span>
          {filters.project !== null && <><span className="sep">›</span><span>{filters.project || "未分项目"}</span></>}
          <span className="sync" title={info ? `${info.bd_bin} · ${info.version}` : ""}>{lastSync ? `同步 ${lastSync.toLocaleTimeString("zh-CN", { hour12: false })}` : "连接中…"}{!isTauri && " · 浏览器预览"}</span>
        </div>
        <div className="tb-right">
          <label className="search">🔍<input ref={searchRef} placeholder="搜任务、ID、Agent…" value={query} onChange={(e) => setQuery(e.target.value)} /><kbd>⌘K</kbd></label>
          <button className="btn ghost" onClick={() => setTour(true)} title="导览：这个软件怎么用">?</button>
          <button className="btn ghost" onClick={nextTheme} title="切换主题">{theme === "dark" ? "☾" : theme === "light" ? "☼" : "◐"}</button>
          <button className="btn ghost status" onClick={() => setView("agents")} title="查看 Agent 状态"><span className="pulse" />{counts.agents} 在线 · {liveSessions} 窗口 ›</button>
          <button className="btn ghost" onClick={() => setCreating(true)} title="任务通常由 Agent 自己建；这里手动建一条">＋</button>
        </div>
      </div>

      <div className={`body${selected ? " with-detail" : ""}`}>
        <Sidebar info={info} view={view} setView={setView} counts={counts} projects={projects} agents={agents} filters={filters} setFilters={setFilters} />
        <main className="main">
          <div className="toolbar">
            <h2>{VIEW_LABEL[view]}{BOARD_VIEWS.includes(view) && filters.project !== null && <span className="muted"> · {filters.project || "未分项目"}</span>}</h2>
            {BOARD_VIEWS.includes(view) && (
              <div className="views">
                <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>看板</button>
                <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>表格</button>
              </div>
            )}
            <span className="spacer" />
            {BOARD_VIEWS.includes(view) && (<>
              <button className={`chip${!filters.blocked && !filters.review && !filters.agent ? " on" : ""}`} onClick={() => setFilters({ ...filters, agent: null, blocked: false, review: false })}>全部</button>
              <button className={`chip${filters.review ? " on" : ""}`} onClick={() => setFilters({ ...filters, review: !filters.review, blocked: false })}>待审核 {counts.review}</button>
              <button className={`chip${filters.blocked ? " on" : ""}`} onClick={() => setFilters({ ...filters, blocked: !filters.blocked, review: false })}>阻塞 {counts.blocked}</button>
              <button className={`chip${filters.urgent ? " on" : ""}`} onClick={() => setFilters({ ...filters, urgent: !filters.urgent })}>P0–P1</button>
              {filters.agent && <button className="chip on" onClick={() => setFilters({ ...filters, agent: null })}>{filters.agent} ✕</button>}
              <span className="muted mono" style={{ fontSize: 11 }}>{visible.length} 项</span>
            </>)}
          </div>
          {err && <div className="err">{err}</div>}
          <section className="view">
            {view === "home" && api && <HomeView api={api} issues={issues} agents={agents} refs={refs} me={me} counts={{ working: presence.sessions.filter((s) => s.alive && s.state === "working").length, waiting: inbox.waiting.length, review: inbox.review.length, blocked: inbox.blocked.length }} onSelect={setSelected} onView={setView} onFocus={focusSession} />}
            {view === "graph" && api && <GraphView api={api} me={me} version={version} selected={selected} onSelect={setSelected} />}
            {view === "inbox" && <InboxView items={inbox} me={me} onSelect={setSelected} onResume={copyResume} onFocus={focusSession} onReview={(id) => run("审核通过", () => api!.labels(id, ["reviewed"], []))} />}
            {view === "board" && <Board issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} onMove={move} onAdd={() => setCreating(true)} />}
            {view === "table" && <TableView issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} />}
            {view === "agents" && <AgentsView agents={agents} apps={presence.apps} onSelect={(id) => { setSelected(id); }} onCopyResume={copyResume} onFocus={focusSession} refs={refs} />}
            {view === "sessions" && api && <SessionsView key={sessionFocus ?? "all"} api={api} me={me} live={presence.sessions} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} initialId={sessionFocus ?? (info?.initial_task?.startsWith("session:") ? info.initial_task.slice(8) : null)} />}
            {view === "projects" && api && <ProjectsView api={api} me={me} issues={issues} onSelect={setSelected} onBoard={(p) => { setFilters({ ...filters, project: p, blocked: false, review: false, agent: null }); setView("board"); }} onFolder={() => setView("folders")} />}
            {view === "stats" && api && <StatsView api={api} me={me} onError={(m) => say(m, true)} />}
            {view === "folders" && api && <FoldersView api={api} me={me} issues={issues} onOpenSession={openSession} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
            {view === "skills" && api && <SkillsView api={api} onDone={say} onError={(m) => say(m, true)} />}
            {view === "rules" && api && <RulesView api={api} onDone={say} onError={(m) => say(m, true)} />}
            {view === "env" && api && <EnvView api={api} onDone={say} onError={(m) => say(m, true)} />}
            {view === "pitfalls" && api && <PitfallsView api={api} projects={projects.map((p) => p.name).filter(Boolean)} version={version} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
          </section>
        </main>
        {selected && api && (
          <Detail id={selected} api={api} me={me} root={rootIssue(selected) ?? null} initial={issues.find((i) => i.id === selected) ?? null} stamp={issues.find((i) => i.id === selected)?.updated_at ?? String(version)} live={presence.sessions} onClose={() => setSelected(null)} onSelect={setSelected} onError={(m) => say(m, true)} onDone={(m) => { say(m); reload(); }} />
        )}
      </div>

      {tour && <Tour onClose={closeTour} onGo={(v) => setView(v)} />}
      {creating && <NewTask projects={projects.map((p) => p.name).filter(Boolean)} defaultProject={filters.project} onCancel={() => setCreating(false)} onCreate={create} />}
      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.text}</div>}
    </div>
  );
}
