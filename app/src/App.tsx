import { TaskActions, isTrashed } from "./components/TaskActions";
import { UsageView } from "./components/Quota";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi, isTauri, isServed, type Api } from "./api";
import { Detail } from "./components/Detail";
import { NewTask } from "./components/NewTask";
import { Sidebar, type Filters } from "./components/Sidebar";
import { AgentsView, Board, TableView } from "./components/views";
import { PitfallsView } from "./components/Pitfalls";
import { SessionsView } from "./components/Sessions";
import { SkillsView } from "./components/Skills";
import { RulesView } from "./components/InstructionCenter";
import { EnvView } from "./components/Env";
import { InboxView, type InboxItems } from "./components/Inbox";
import { Workspace } from "./components/Workspace";
import { activityKey, mergeActivity } from "./activity";
import { GraphView } from "./components/Graph";
import { FoldersView } from "./components/Folders";
import { ProjectsView } from "./components/Projects";
import { Tour } from "./components/Guide";
import { MobileNav } from "./components/MobileNav";
import { needsReview, needsAttention, agentsFrom, columnOf, projectOf, rootsOf, hostOfIssue } from "./derive";
import type { Activity, ActivitySnapshot, Column, Host, Info, Issue, NewIssue, Presence, SessionRef, View } from "./types";

type Theme = "light" | "dark" | "";
const VIEW_LABEL: Record<View, string> = { home: "工作台", inbox: "等我", board: "全部任务", table: "全部任务", graph: "脉络", projects: "项目", folders: "文件夹", agents: "Agent 状态", sessions: "会话", stats: "统计与额度", skills: "技能", rules: "规则与资料", pitfalls: "知识库", env: "环境", quota: "统计与额度", trash: "回收站" };
const VIEWS: View[] = ["home", "inbox", "board", "table", "graph", "projects", "folders", "agents", "sessions", "stats", "skills", "rules", "pitfalls", "env", "quota", "trash"];
const BOARD_VIEWS: View[] = ["board", "table"];
const EMPTY_FILTERS: Filters = { project: null, mine: false, urgent: false, agent: null, blocked: false, review: false };

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [issuesLoaded, setIssuesLoaded] = useState(false);
  const [activity, setActivity] = useState<ActivitySnapshot>({ sessions: [], updated_at: 0, unavailable_hosts: [] });
  const [activityError, setActivityError] = useState(false);
  const acknowledged = useRef(new Map<string, string>());
  const markRead = useCallback(async (a: Activity, reply: string) => {
    if (!api || acknowledged.current.get(activityKey(a)) === reply) return;
    try {
      await api.sessionSeen(a.host ?? 'local', a.key, reply);
      acknowledged.current.set(activityKey(a), reply);
      setActivity(old => ({ ...old, sessions: old.sessions.map(x => activityKey(x) === activityKey(a) && x.reply_id === reply ? { ...x, unread: false } : x) }));
    } catch { /* Keep unread on failed acknowledgement; next visible poll retries. */ }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let stopped = false; let timer = 0;
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const snapshot = await api.sessionActivity();
          if (!stopped) { setActivity({ ...snapshot, sessions: snapshot.sessions.map(a => acknowledged.current.get(activityKey(a)) === a.reply_id ? { ...a, unread: false } : a) }); setActivityError(false); }
        } catch { if (!stopped) setActivityError(true); }
      }
      if (!stopped) timer = window.setTimeout(tick, 3000);
    };
    tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [api]);
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [presence, setPresence] = useState<Presence>({ sessions: [], apps: [] });
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [view, changeView] = useState<View>("home");
  const [inboxTab, setInboxTab] = useState<keyof InboxItems | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [projectSelection, setProjectSelection] = useState<string | null>(null);
  const [folderSelection, setFolderSelection] = useState<string | null>(null);
  const [backStack, setBackStack] = useState<{ view: View; selected: string | null }[]>([]);
  const navigateContext = (next: View) => { setBackStack((stack) => [...stack, { view, selected }]); changeView(next); setSelected(null); };
  const goBack = () => { const previous = backStack[backStack.length - 1]; if (previous) { changeView(previous.view); setSelected(previous.selected); setBackStack((stack) => stack.slice(0, -1)); } };
  const setView = useCallback((next: View) => { changeView(next); setSelected(null); setInboxTab(null); setBackStack([]); }, []);
  const [filters, setFilters] = useState<Filters>({ project: null, mine: false, urgent: false, agent: null, blocked: false, review: false });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [sessionFocus, setSessionFocus] = useState<string | null>(null);
  // The tour never opens on its own; the design should carry itself. `?` still has it.
  const [tour, setTour] = useState(false);
  const closeTour = () => setTour(false);
  const openSession = (id: string) => { setSessionFocus(id); navigateContext("sessions"); };
  const [version, setVersion] = useState(0);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  // Which Mac to look at: "" = all, else a host *name* (matches session.host_name and the host:<name> task label).
  const [hostFilter, setHostFilter] = useState<string>(() => { try { return localStorage.getItem("dispatch-host") ?? ""; } catch { return ""; } });
  useEffect(() => { try { localStorage.setItem("dispatch-host", hostFilter); } catch { /* ignore */ } }, [hostFilter]);
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem("dispatch-theme") as Theme) ?? ""; } catch { return ""; } });
  const searchRef = useRef<HTMLInputElement>(null);
  const [focusSearch, setFocusSearch] = useState(false);
  const allTasks = () => { setFilters(EMPTY_FILTERS); setQuery(""); setView("board"); };
  const searchTasks = useCallback(() => { setFilters(EMPTY_FILTERS); setView("table"); setFocusSearch(true); }, [setView]);
  useEffect(() => { if (focusSearch) { searchRef.current?.focus(); searchRef.current?.select(); setFocusSearch(false); } }, [focusSearch]);
  const toastTimer = useRef<number | undefined>(undefined);

  const me = info?.actor ?? "user";

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
      setIssuesLoaded(true);
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
        const requestedView = new URLSearchParams(window.location.search).get("page") ?? inf.initial_view;
        if ((VIEWS as string[]).includes(requestedView ?? "")) setView(requestedView as View);
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
    const tick = async () => { try { const p = await api.presence(); if (alive) { setPresence(p); setPresenceLoaded(true); } } catch { /* keep last */ } };
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchTasks(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); setCreating(true); }
      if (e.key === "Escape" && document.activeElement === searchRef.current) { setQuery(""); searchRef.current?.blur(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchTasks]);

  // Lineage roots (which thread each task belongs to), refreshed with the issue list.
  const [roots, setRoots] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.graph().then((g) => { if (alive) setRoots(rootsOf(g.edges)); }).catch(() => {});
    return () => { alive = false; };
  }, [api, version]);
  const rootIssue = useCallback((id: string): Issue | undefined => { const r = roots.get(id); return r ? issues.find((i) => i.id === r) : undefined; }, [roots, issues]);

  const [hosts, setHosts] = useState<Host[]>([]);

  // The Macs on the tailnet (this one + hosts.json), for the 机器 strip on the Agents view.
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const h = await api.hosts(); if (alive) setHosts(h); } catch { /* keep last */ } };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [api]);

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
  const hostId = useMemo(() => { if (!hostFilter) return ""; const h = hosts.find((x) => x.name === hostFilter); return h ? (h.local ? "local" : h.id) : ""; }, [hostFilter, hosts]);
  const localName = hosts.find((h) => h.local)?.name ?? "";
  const observedPresence = useMemo(() => mergeActivity(presence, activity.sessions), [presence, activity]);
  const presenceF = useMemo(() => hostFilter ? { ...observedPresence, sessions: observedPresence.sessions.filter((x) => (x.host_name ?? localName) === hostFilter) } : observedPresence, [observedPresence, hostFilter, localName]);
  const refsF = useMemo(() => hostFilter ? new Map([...refs].filter(([, r]) => (r.host_name ?? localName) === hostFilter)) : refs, [refs, hostFilter, localName]);
  const activityF = useMemo(() => hostFilter ? activity.sessions.filter(a => (a.host_name ?? localName) === hostFilter) : activity.sessions, [activity, hostFilter, localName]);
  const hostIssues = useMemo(() => hostFilter ? issues.filter((i) => hostOfIssue(i, refs) === hostFilter) : issues, [issues, refs, hostFilter]);
  const issuesF = useMemo(() => hostIssues.filter(i=>!isTrashed(i)), [hostIssues]);
  const agents = useMemo(() => agentsFrom(issuesF, me, presenceF.sessions), [issuesF, me, presenceF]);
  const runningSessions = presenceF.sessions.filter((s) => s.alive && s.state === "working").length;
  const projects = useMemo(() => {
    const m = new Map<string, number>();
    issuesF.forEach((i) => m.set(projectOf(i), (m.get(projectOf(i)) ?? 0) + 1));
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : b.count - a.count));
  }, [issuesF]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issuesF.filter((i) => {
      if (filters.project !== null && projectOf(i) !== filters.project) return false;
      if (filters.mine && i.assignee !== me) return false;
      if (filters.urgent && i.priority > 1) return false;
      if (filters.agent && i.assignee !== filters.agent) return false;
      if (filters.blocked && i.status !== "blocked") return false;
      if (filters.review && !(needsReview(i))) return false;
      if (q && !(i.title.toLowerCase().includes(q) || i.id.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q) || (i.assignee ?? "").toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => a.priority - b.priority || b.updated_at.localeCompare(a.updated_at));
  }, [issuesF, filters, query, me]);

  useEffect(() => {
    if (!api || view !== "board") return;
    let alive = true;
    // Only the visible active tasks need recent progress; avoid fetching the whole archive.
    const active = visible.filter((i) => i.status === "in_progress");
    Promise.all(active.map(async (i) => {
      try { const notes = await api.comments(i.id); const latest = notes.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]; return [i.id, latest?.text ?? ""] as const; }
      catch { return [i.id, ""] as const; }
    })).then((entries) => { if (alive) setProgress(Object.fromEntries(entries)); });
    return () => { alive = false; };
  }, [api, view, visible]);

  const inbox = useMemo<InboxItems>(() => ({
    unread: activityF.filter(a => a.unread),
    waiting: presenceF.sessions.filter((s) => needsAttention(s)).sort((a, b) => b.last_at - a.last_at),
    idle: presenceF.sessions.filter((s) => s.alive && s.state === "idle" && !needsAttention(s)),
    review: issuesF.filter((i) => needsReview(i)).sort((a, b) => (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at)),
    blocked: issuesF.filter((i) => i.status === "blocked"),
  }), [issuesF, presenceF, activityF]);

  const counts = useMemo(() => ({
    total: issuesF.length,
    blocked: inbox.blocked.length,
    review: inbox.review.length,
    agents: agents.filter((a) => a.online).length,
    inbox: inbox.unread.length + inbox.waiting.filter(s => !inbox.unread.some(a => a.session_id === s.session_id)).length + inbox.blocked.length,
  }), [issuesF, agents, inbox]);

  // Use unfiltered data: switching machines is not a new event.
  const notificationInbox = useMemo(() => ({
    waiting: presence.sessions.filter((s) => needsAttention(s)),
    review: issues.filter((i) => needsReview(i)),
  }), [presence, issues]);

  // Notifications: only for things that newly entered the inbox after the first load.
  const seen = useRef<{ ready: boolean; waiting: Set<string>; review: Set<string> }>({ ready: false, waiting: new Set(), review: new Set() });
  useEffect(() => {
    if (!api || !issuesLoaded || !presenceLoaded) return;
    const s = seen.current;
    const w = new Set(notificationInbox.waiting.map((x) => x.session_id));
    const r = new Set(notificationInbox.review.map((x) => x.id));
    if (s.ready) {
      for (const x of notificationInbox.waiting) if (!s.waiting.has(x.session_id)) api.notify(`${x.agent === "codex" ? "Codex" : x.agent === "zcode" ? "ZCode" : "Claude Code"} 需要处理`, `${x.attention === "failure" ? "工具执行失败" : "等待确认"} · ${x.herdr?.title || x.title || x.project || x.cwd}（${x.source_app}）`).catch(() => {});
    }
    s.waiting = w; s.review = r;
    if (!s.ready && (presence.sessions.length > 0 || issues.length > 0)) s.ready = true;
  }, [notificationInbox, api, presence.sessions.length, issues.length, issuesLoaded, presenceLoaded]);

  useEffect(() => {
    if (!api) return;
    const working = observedPresence.sessions.filter((s) => s.alive && s.state === "working").length;
    // Menu bars fill up fast; keep the status text to a few characters.
    const unread = activity.sessions.filter(a => a.unread).length;
    const parts = [unread ? `${unread}未读` : "", working ? `${working}跑` : "", notificationInbox.waiting.length ? `${notificationInbox.waiting.length}等` : "", notificationInbox.review.length ? `${notificationInbox.review.length}审` : ""].filter(Boolean);
    api.tray(parts.join(" "), `Dispatch · ${unread} 未读回复 · ${working} 在跑 · ${notificationInbox.waiting.length} 等你 · ${notificationInbox.review.length} 待 Agent 复核 · ${issues.filter((i) => i.status !== "closed").length} 项未完成`).catch(() => {});
  }, [api, observedPresence, notificationInbox, issues, activity]);

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
    if (to === "done") return run("标记完成", async () => { if (!closed) await api.close(id, "在 Dispatch 里拖到已完成"); });
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
    <TaskActions api={api} onOpen={setSelected} onDone={(m,id)=>{say(m);if(id===selected)setSelected(null);void reload();}} onError={m=>say(m,true)}><div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="lead" data-tauri-drag-region><b>Dispatch</b><span className="muted">调度台</span></div>
        <div className="crumb" data-tauri-drag-region>
          {backStack.length > 0 && <button className="btn ghost sm" onClick={goBack}>‹ 返回{VIEW_LABEL[backStack[backStack.length - 1].view]}</button>}<b className="link" onClick={() => setView("home")}>全局板</b>{hostFilter && <><span className="sep">›</span><span>{hostFilter}</span></>}<span className="sep">›</span><span>{VIEW_LABEL[view]}</span>
          {BOARD_VIEWS.includes(view) && filters.project !== null && <><span className="sep">›</span><span>{filters.project || "未分项目"}</span></>}
          <span className="sync" title={info ? `${info.bd_bin} · ${info.version}` : ""}>{lastSync ? `同步 ${lastSync.toLocaleTimeString("zh-CN", { hour12: false })}` : "连接中…"}{!isTauri && (isServed ? " · 网页连接" : " · 示例数据")}</span>
        </div>
        <div className="tb-right">
          {BOARD_VIEWS.includes(view) ? <label className="search">🔍<input ref={searchRef} placeholder="搜任务、ID、Agent…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button aria-label="清除任务搜索" onClick={() => setQuery("")}>✕</button>}<kbd>⌘K</kbd></label> : <button className="btn ghost" onClick={searchTasks}>搜索任务 <kbd>⌘K</kbd></button>}
          <button className="btn ghost" onClick={() => setTour(true)} title="导览：这个软件怎么用">?</button>
          <button className="btn ghost" onClick={nextTheme} title="切换主题">{theme === "dark" ? "☾" : theme === "light" ? "☼" : "◐"}</button>
          <button className="btn ghost status" onClick={() => setView("agents")} title="查看 Agent 状态"><span className="pulse" />{counts.agents} 在线 · {runningSessions} 进行中 ›</button>
          <button className="btn ghost" onClick={() => setCreating(true)} title="任务通常由 Agent 自己建；这里手动建一条">＋</button>
        </div>
      </div>

      <div className={`body${selected ? " with-detail" : ""}`}>
        <Sidebar info={info} view={view} setView={setView} counts={counts} projects={projects} agents={agents} filters={filters} setFilters={setFilters} hosts={hosts} hostFilter={hostFilter} setHostFilter={(h) => { setHostFilter(h); setSelected(null); }} onAllTasks={allTasks} />
        <main className="main">
          <div className="toolbar">
            {backStack.length > 0 && <button className="btn sm mobile-context-back" onClick={goBack}>‹ 返回</button>}
            <h2>{VIEW_LABEL[view]}{BOARD_VIEWS.includes(view) && filters.project !== null && <span className="muted"> · {filters.project || "未分项目"}</span>}</h2>
            {hosts.length > 1 && <select className="mobile-host-filter" aria-label="选择机器" value={hostFilter} onChange={e => { setHostFilter(e.target.value); setSelected(null); }}><option value="">全部机器</option>{hosts.map(h => <option key={h.id} value={h.name}>{h.name}</option>)}</select>}
            {BOARD_VIEWS.includes(view) && (
              <div className="views">
                <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>看板</button>
                <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>表格</button>
              </div>
            )}
            <span className="spacer" />
            {BOARD_VIEWS.includes(view) && (<>
              <button className="chip" onClick={()=>setView("trash")}>回收站 {hostIssues.filter(isTrashed).length}</button>
              <button className="chip" disabled={!Object.values(filters).some(Boolean) && filters.project === null && !query} onClick={() => { setFilters(EMPTY_FILTERS); setQuery(""); }}>清除筛选</button>
              <button className={`chip${filters.review ? " on" : ""}`} onClick={() => setFilters({ ...filters, review: !filters.review, blocked: false })}>Agent 复核 {counts.review}</button>
              <button className={`chip${filters.blocked ? " on" : ""}`} onClick={() => setFilters({ ...filters, blocked: !filters.blocked, review: false })}>阻塞 {counts.blocked}</button>
              <button className={`chip${filters.urgent ? " on" : ""}`} onClick={() => setFilters({ ...filters, urgent: !filters.urgent })}>P0–P1</button>
              {filters.agent && <button className="chip on" onClick={() => setFilters({ ...filters, agent: null })}>{filters.agent} ✕</button>}
              <span className="muted mono" style={{ fontSize: 11 }}>{visible.length} 项</span>
            </>)}
          </div>
          {err && <div className="err">{err}</div>}
          <section className="view">
            {view === "home" && <Workspace onPhone={isTauri ? async () => { if (!api) return; try { const url = (await api.on("local", ["serve", "url"])).trim(); await api.copy(url); say("手机访问链接已复制，在同一 Tailscale 网络的手机浏览器打开"); } catch(e) { say(String(e), true); } } : undefined} rows={activityF} loaded={activity.updated_at > 0} error={activityError} unavailable={activity.unavailable_hosts} issues={issuesF} me={me} onOpen={openSession} onTask={setSelected} onInbox={() => { setView("inbox"); setInboxTab("unread"); }} onSessions={() => setView("sessions")} />}
            {view === "graph" && api && <GraphView api={api} me={me} version={version} selected={selected} onSelect={setSelected} />}
            {view === "inbox" && <InboxView onOpen={openSession} initialTab={inboxTab} items={inbox} me={me} onSelect={setSelected} onResume={copyResume} onFocus={focusSession} />}
            {view === "board" && <Board progress={progress} issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} onMove={move} onAdd={() => setCreating(true)} />}
            {view === "table" && <TableView issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} />}
            {view === "agents" && <AgentsView agents={agents} apps={presenceF.apps} onSelect={(id) => { setSelected(id); }} onCopyResume={copyResume} onFocus={focusSession} refs={refsF} hosts={hosts} onOpenUrl={(u) => api?.openPath(u).catch((e) => say(String(e), true))} onCopyText={(t, what) => api?.copy(t).then(() => say(`${what}已复制`)).catch((e) => say(String(e), true))} onStart={async (i) => { const r = await api!.agentStart(i); say(r ? `已在 ${r.host} 起了 ${r.kind}` : "起 Agent 失败"); return r; }} />}
            {view === "sessions" && api && <SessionsView activities={activityF} issues={issuesF} onSeen={markRead} activityError={activityError} key={(sessionFocus ?? "all") + hostId} api={api} me={me} live={presenceF.sessions} hostId={hostId} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} initialId={sessionFocus ?? (info?.initial_task?.startsWith("session:") ? info.initial_task.slice(8) : null)} />}
            {view === "projects" && api && <ProjectsView selectedProject={projectSelection} onProjectChange={setProjectSelection} api={api} me={me} issues={issuesF} onSelect={setSelected} onBoard={(p) => { setFilters({ ...filters, project: p, blocked: false, review: false, agent: null }); navigateContext("board"); }} onFolder={(cwd) => { setFolderSelection(cwd); navigateContext("folders"); }} />}
            {view === "trash" && <><p className="trash-note">移除的任务保留记录与依赖，不会进入待办队列。右键或点击 ⋯ 可恢复。</p><TableView issues={hostIssues.filter(isTrashed)} selected={selected} onSelect={setSelected} me={me}/></>}
            {(view === "stats" || view === "quota") && api && <UsageView key={view} initialTab={view === "quota" ? "quota" : undefined} onDone={say} api={api} me={me} host={hostId} hostName={hostFilter} onError={(m) => say(m, true)} />}
            {view === "folders" && api && <FoldersView selectedFolder={folderSelection} onFolderChange={setFolderSelection} api={api} me={me} issues={issuesF} onOpenSession={openSession} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
            {view === "skills" && api && <SkillsView api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "rules" && api && <RulesView api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "env" && api && <EnvView api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "pitfalls" && api && <PitfallsView api={api} projects={projects.map((p) => p.name).filter(Boolean)} version={version} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
          </section>
        </main>
        {selected && api && (
          <Detail onOpenSession={openSession} key={selected} id={selected} api={api} me={me} root={rootIssue(selected) ?? null} initial={issues.find((i) => i.id === selected) ?? null} stamp={issues.find((i) => i.id === selected)?.updated_at ?? String(version)} live={presence.sessions} onClose={() => setSelected(null)} onSelect={setSelected} onError={(m) => say(m, true)} onDone={(m) => { say(m); reload(); }} />
        )}
      </div>

      <MobileNav view={view} setView={(v) => { if (v === "board" || v === "table") allTasks(); else setView(v); }} badge={counts.inbox} />
      {tour && <Tour onClose={closeTour} onGo={(v) => setView(v)} />}
      {creating && <NewTask projects={projects.map((p) => p.name).filter(Boolean)} defaultProject={filters.project} onCancel={() => setCreating(false)} onCreate={create} />}
      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.text}</div>}
    </div></TaskActions>
  );
}
