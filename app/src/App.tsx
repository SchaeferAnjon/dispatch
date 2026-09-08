import { ConversationActions } from './components/ConversationActions';
import { GlobalContextMenu, ItemMenus, ProjectActions, ViewMenu, type ViewMenuItem } from './components/ContextMenu';
import { TaskActions, isTrashed } from "./components/TaskActions";
import { UsageView } from "./components/Quota";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi, isTauri, isServed, type Api, type AgentStartInput } from "./api";
import { Detail } from "./components/Detail";
import { NewSession, SessionActions } from "./components/SessionActions";
import { NewTask } from "./components/NewTask";
import { Sidebar, type Filters } from "./components/Sidebar";
import { AgentsView, Board, TableView } from "./components/views";
import { PitfallsView } from "./components/Pitfalls";
import { SessionsView } from "./components/Sessions";
import { SkillsView } from "./components/Skills";
import { RulesView } from "./components/InstructionCenter";
import { EnvView } from "./components/Env";
import { InboxView, type InboxItems } from "./components/Inbox";
import { ProjectHub } from "./components/ProjectHub";
import { HomeView } from "./components/Home";
import { SearchPalette } from "./components/Search";
import { DEFAULT_SETTINGS, PROJECT_FLAGS_KEY, SETTINGS_KEY, parseProjectFlags, parseSettings, serializeProjectFlags, serializeSettings, withProjectFlag, type DispatchSettings, type ProjectFlags } from "./projectFlags";
import { SettingsView } from "./components/Settings";
import { SetupView, type InitStatus } from "./components/Setup";
import type { UpdateInfo } from "./components/Settings";
import { Delegate } from "./components/Delegate";
import { Avatar } from "./components/ui";
import { isOutcome, knownProjects, linkedSessions, projectGroups, sourceTasks, projectConversations } from "./projectModel";
import { UNGROUPED_PROJECT, activityKey, conversationProject, isScriptSession, isSubagentSession, mergeActivity, resolveProject } from "./activity";
import { isArchived, isStarred, rankProjects } from "./projectFlags";
import { GraphView } from "./components/Graph";
import { Tour } from "./components/Guide";
import { MobileNav } from "./components/MobileNav";
import { needsReview, needsAttention, agentsFrom, columnOf, projectOf, rootsOf, hostOfIssue } from "./derive";
import type { Activity, ActivitySnapshot, Column, Host, Info, Issue, NewIssue, Presence, Quota, SessionRef, View } from "./types";

type Theme = "light" | "dark" | "";
const VIEW_LABEL: Record<View, string> = { home: "工作台", inbox: "等我", board: "全部任务", table: "全部任务", graph: "脉络", projects: "项目", agents: "Agent 状态", settings: "设置", sessions: "会话", stats: "统计与额度", skills: "技能", rules: "规则与资料", pitfalls: "知识库", env: "环境", quota: "统计与额度", trash: "回收站", setup: "首次设置" };
const VIEWS: View[] = ["home", "inbox", "board", "table", "graph", "projects", "agents", "settings", "sessions", "stats", "skills", "rules", "pitfalls", "env", "quota", "trash", "setup"];
const BOARD_VIEWS: View[] = ["board", "table"];
// ⌘1…⌘9 in sidebar order.
const SHORTCUT_VIEWS: View[] = ["home", "projects", "inbox", "sessions", "board", "graph", "agents", "stats", "pitfalls"];
const EMPTY_FILTERS: Filters = { project: null, mine: false, urgent: false, agent: null, blocked: false, review: false };

export default function App() {
  const [newSession, setNewSession] = useState(false);
  const [newSessionContext, setNewSessionContext] = useState<Activity>();
  const [newSessionProject,setNewSessionProject] = useState<string|null>(null);
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
    } catch { setToast({text: "标记已读失败，请重试", err: true}); }
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
  const [initStatus, setInitStatus] = useState<InitStatus | null>(null);
  // New releases: checked once a day after start-up; the title bar shows a chip when one exists.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const checkUpdate = useCallback(async () => { if (!api || !isTauri) return; try { const r = JSON.parse((await api.on("local", ["update", "check", "--json"])).replace(/^[^{]*/, "")) as UpdateInfo; setUpdate(r); } catch (e) { setUpdate({ current: "?", latest: "", url: "", error: String(e) }); } }, [api]);
  useEffect(() => { if (!api || !isTauri) return; const t = window.setTimeout(() => void checkUpdate(), 8_000); const d = window.setInterval(() => void checkUpdate(), 24 * 3600_000); return () => { window.clearTimeout(t); window.clearInterval(d); }; }, [api, checkUpdate]);
  const applyUpdate = async () => { if (!api) return; try { say("正在下载新版本…"); const r = JSON.parse((await api.on("local", ["update", "apply", "--json"])).replace(/^[^{]*/, "")); if (r.error) say(String(r.error), true); else say(`已更新到 v${r.updated_to}，正在重启`); } catch (e) { say(String(e), true); } };
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [presence, setPresence] = useState<Presence>({ sessions: [], apps: [] });
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [view, changeView] = useState<View>("home");
  const [inboxTab, setInboxTab] = useState<keyof InboxItems | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [projectSelection, setProjectSelection] = useState<string | null>(()=>new URLSearchParams(location.search).get("project"));
  const [backStack, setBackStack] = useState<{ view: View; selected: string | null }[]>([]);
  const navigateContext = (next: View) => { setBackStack((stack) => [...stack, { view, selected }]); changeView(next); setSelected(null); };
  const goBack = () => { const previous = backStack[backStack.length - 1]; if (previous) { changeView(previous.view); setSelected(previous.selected); setBackStack((stack) => stack.slice(0, -1)); } };
  const setView = useCallback((next: View) => { changeView(next); setSelected(null); setInboxTab(null); setBackStack([]); if (next === "projects") setProjectSelection(null); }, []);
  const openProject = (name: string) => { setProjectSelection(name); navigateContext("projects"); };
  const [filters, setFilters] = useState<Filters>({ project: null, mine: false, urgent: false, agent: null, blocked: false, review: false });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(false);
  const [delegate, setDelegate] = useState<{ host?: string; task?: string } | null>(null);
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
  const allTasks = () => { setFilters(EMPTY_FILTERS); setQuery(""); setView("board"); };
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
        if ((VIEWS as string[]).includes(requestedView ?? "")) changeView(requestedView as View);
        if (inf.initial_task && !inf.initial_task.startsWith("session:")) setSelected(inf.initial_task);
        // The first-run guide, until it is finished or skipped once.
        if (isTauri) { try { const st = JSON.parse((await a.on("local", ["init", "status", "--json"])).replace(/^[^{]*/, "")) as InitStatus; setInitStatus(st); if (!st.done && !requestedView) changeView("setup"); } catch { /* CLI too old */ } }
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch(true); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); setNewSession(true); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") { e.preventDefault(); setCreating(true); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") { e.preventDefault(); void reload(); }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) { const v = SHORTCUT_VIEWS[Number(e.key) - 1]; if (v) { e.preventDefault(); v === "board" ? allTasks() : setView(v); } }
      if (e.key === "Escape" && document.activeElement === searchRef.current) { setQuery(""); searchRef.current?.blur(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

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

  // Usage limits per agent, refreshed every minute; shown on the workbench and in the menu bar.
  const [quota, setQuota] = useState<Quota[]>([]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const q = await api.quota(); if (alive) setQuota(q); } catch { /* keep last */ } };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [api]);


  // One line of the cross-agent insights for the workbench; the full card lives on 统计.
  const [insight, setInsight] = useState<string>("");
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const r = await api.insights(14); if (alive) setInsight(r?.findings?.[0] ?? ""); } catch { /* optional */ } };
    const first = window.setTimeout(tick, 4_000);
    const t = window.setInterval(tick, 30 * 60_000);
    return () => { alive = false; window.clearTimeout(first); window.clearInterval(t); };
  }, [api]);

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
  const [settings, setSettings] = useState<DispatchSettings>(DEFAULT_SETTINGS);
  const archiveDays = settings.session_archive_days;
  const saveSettings = async (next: DispatchSettings) => { if (!api) return; try { await api.remember(SETTINGS_KEY, serializeSettings(next)); setSettings(next); say("设置已保存"); } catch (e) { say(String(e), true); } };
  const known = useMemo(() => knownProjects(issues, activity.sessions), [issues, activity]);
  const normalise = useCallback(<T extends { cwd: string; project: string; project_override?: string; scheduled?: boolean; path?: string; entrypoint?: string }>(x: T): T => ({ ...x, project: resolveProject(x, known, settings.workspace_roots), scheduled: x.scheduled ?? (settings.sdk_sessions_scheduled && isScriptSession(x) ? true : undefined) }), [known, settings.sdk_sessions_scheduled, settings.workspace_roots]);
  const activityRows = useMemo(() => activity.sessions.filter((a) => !isSubagentSession(a)).map(normalise), [activity, normalise]);
  const observedPresence = useMemo(() => mergeActivity(presence, activityRows), [presence, activityRows]);
  const presenceF = useMemo(() => hostFilter ? { ...observedPresence, sessions: observedPresence.sessions.filter((x) => (x.host_name ?? localName) === hostFilter) } : observedPresence, [observedPresence, hostFilter, localName]);
  // Every conversation carries its resolved project from here on, so each view agrees on it.
  const refsF = useMemo(() => new Map([...refs].filter(([, r]) => !isSubagentSession(r) && (!hostFilter || (r.host_name ?? localName) === hostFilter)).map(([id, r]) => [id, normalise(r)])), [refs, hostFilter, localName, normalise]);
  const activityF = useMemo(() => activityRows.filter(a => !hostFilter || (a.host_name ?? localName) === hostFilter), [activityRows, hostFilter, localName]);
  const scriptCount = useMemo(() => [...refsF.values()].filter(isScriptSession).length, [refsF]);
  const projectRows = useMemo(()=>projectConversations(activityF,[...refsF.values()]),[activityF,refsF]);
  // 收藏 / 归档 per project: one shared bd memory, re-read whenever the board changes.
  const [projectFlags, setProjectFlags] = useState<ProjectFlags>({});
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.memories().then((m) => { if (alive) { setProjectFlags(parseProjectFlags(m)); setSettings(parseSettings(m)); } }).catch(() => {});
    return () => { alive = false; };
  }, [api, version]);
  const setProjectFlag = async (name: string, change: { starred?: boolean; archived?: boolean }) => {
    if (!api) return;
    const next = withProjectFlag(projectFlags, name, change);
    try { await api.remember(PROJECT_FLAGS_KEY, serializeProjectFlags(next)); setProjectFlags(next); say(change.starred === true ? `已收藏 ${name}` : change.starred === false ? `已取消收藏 ${name}` : change.archived === true ? `已归档 ${name}，工作台不再显示` : `已取消归档 ${name}`); }
    catch (e) { say(String(e), true); }
  };
  const hostIssues = useMemo(() => hostFilter ? issues.filter((i) => hostOfIssue(i, refs) === hostFilter) : issues, [issues, refs, hostFilter]);
  const issuesF = useMemo(() => hostIssues.filter(i=>!isTrashed(i)&&!isOutcome(i)), [hostIssues]);
  const outcomesF = useMemo(() => issues.filter(i=>!isTrashed(i)&&isOutcome(i)&&(!hostFilter || linkedSessions(i).some(id=>!!refs.get(id)&&(refs.get(id)?.host_name||localName)===hostFilter) || sourceTasks(i).some(id=>hostIssues.some(t=>t.id===id)))), [issues, hostIssues, hostFilter, refs, localName]);
  const liveSessions = useMemo(() => presenceF.sessions.filter((s) => !s.scheduled), [presenceF]);
  const scheduledSessions = useMemo(() => presenceF.sessions.filter((s) => s.scheduled), [presenceF]);
  const agents = useMemo(() => agentsFrom(issuesF, me, liveSessions), [issuesF, me, liveSessions]);
  const runningSessions = liveSessions.filter((s) => s.alive && s.state === "working").length;
  // The same project list the workbench and project hub show: resolved from conversations,
  // task labels and outcomes together, archived ones set aside.
  const projectList = useMemo(() => rankProjects(projectGroups(projectRows, issuesF, outcomesF).filter((p) => p.name !== UNGROUPED_PROJECT), projectFlags), [projectRows, issuesF, outcomesF, projectFlags]);
  const projects = useMemo(() => projectList.active.map((p) => ({ name: p.name, count: p.items.length })), [projectList]);

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
    if (!api || (view !== "board" && view !== "home")) return;
    let alive = true;
    // Only the visible active tasks need recent progress; avoid fetching the whole archive.
    const active = (view === "home" ? issuesF : visible).filter((i) => i.status === "in_progress");
    Promise.all(active.map(async (i) => {
      try { const notes = await api.comments(i.id); const latest = notes.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]; return [i.id, latest?.text ?? ""] as const; }
      catch { return [i.id, ""] as const; }
    })).then((entries) => { if (alive) setProgress(Object.fromEntries(entries)); });
    return () => { alive = false; };
  }, [api, view, visible, issuesF]);

  const inArchivedProject = useCallback((x: { cwd: string; project: string; project_override?: string }) => isArchived(projectFlags, resolveProject(x, known, settings.workspace_roots)), [projectFlags, known, settings.workspace_roots]);
  const inbox = useMemo<InboxItems>(() => ({
    unread: activityF.filter(a => a.unread && !a.scheduled && !a.archived && !inArchivedProject(a) && !(a.state === "working" && !a.stale)),
    waiting: presenceF.sessions.filter((s) => needsAttention(s) && !s.scheduled && !inArchivedProject(s)).sort((a, b) => b.last_at - a.last_at),
    idle: presenceF.sessions.filter((s) => s.alive && s.state === "idle" && !needsAttention(s) && !s.scheduled),
    review: issuesF.filter((i) => needsReview(i)).sort((a, b) => (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at)),
    blocked: issuesF.filter((i) => i.status === "blocked"),
  }), [issuesF, presenceF, activityF, inArchivedProject]);

  const counts = useMemo(() => ({
    total: issuesF.length,
    blocked: inbox.blocked.length,
    review: inbox.review.length,
    agents: agents.filter((a) => a.online).length,
    inbox: inbox.unread.length + inbox.waiting.filter(s => !inbox.unread.some(a => a.session_id === s.session_id)).length,
  }), [issuesF, agents, inbox]);

  // Use unfiltered data: switching machines is not a new event.
  const notificationInbox = useMemo(() => ({
    waiting: observedPresence.sessions.filter((s) => needsAttention(s) && !s.scheduled && !inArchivedProject(s)),
    review: issues.filter((i) => needsReview(i) && !isOutcome(i)),
  }), [observedPresence, issues, inArchivedProject]);

  // Ignore transient failures; wait for a stable explicit request. Keep identities
  // across disconnects and distinguish the same session id on different machines.
  const notified = useRef(new Set<string>());
  const requestSignature = notificationInbox.waiting.map(x => `${x.host ?? 'local'}:${x.agent}:${x.session_id}:${x.last_at}`).sort().join('|');
  const notificationReady = useRef(false);
  const activityReady = activity.updated_at > 0;
  useEffect(() => {
    if (!api || !issuesLoaded || !presenceLoaded || !activityReady) return;
    const key = (x: typeof presence.sessions[number]) => `${x.host ?? 'local'}:${x.agent}:${x.session_id}:${x.last_at}`;
    if (!notificationReady.current) {
      notificationInbox.waiting.forEach(x => notified.current.add(key(x)));
      notificationReady.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      for (const x of notificationInbox.waiting) {
        if (notified.current.has(key(x))) continue;
        notified.current.add(key(x));
        api.notify(`${x.agent === 'codex' ? 'Codex' : x.agent === 'zcode' ? 'ZCode' : 'Claude Code'} 等待确认`, `${x.herdr?.title || x.title || x.project || x.cwd} · ${x.host_name || '本机'} · 请打开会话查看确认请求`).catch(() => {});
      }
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [requestSignature, api, issuesLoaded, presenceLoaded, activityReady]);

  useEffect(() => {
    if (!api) return;
    const working = observedPresence.sessions.filter((s) => s.alive && s.state === "working" && !s.scheduled).length;
    // Menu bars fill up fast; keep the status text to a few characters.
    const unread = activityRows.filter(a => a.unread && !a.scheduled && !a.archived && !inArchivedProject(a) && !(a.state === "working" && !a.stale)).length;
    // Quota in the menu bar: this Mac's worst window per agent, as one letter and a percent.
    const local = quota.filter((q) => !q.remote && q.windows.length);
    const names: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "pi", zcode: "ZCode" };
    const until = (epoch: number | null) => { if (!epoch) return ""; const m = Math.round((epoch * 1000 - Date.now()) / 60_000); return m <= 0 ? "" : m < 60 ? `${m}m 后重置` : m < 48 * 60 ? `${Math.floor(m / 60)}h 后重置` : `${Math.round(m / 1440)}d 后重置`; };
    // The title stays short; each agent's quota goes into the click menu, one line per window.
    const quotaLines = local.flatMap((q) => q.windows.map((w) => `${names[q.agent] ?? q.agent} · ${w.label} ${w.used_percent === null ? "—" : Math.round(w.used_percent) + "%"}${until(w.resets_at) ? ` · ${until(w.resets_at)}` : ""}`));
    const parts = [unread ? `${unread}未读` : "", working ? `${working}跑` : "", notificationInbox.waiting.length ? `${notificationInbox.waiting.length}等` : "", notificationInbox.review.length ? `${notificationInbox.review.length}审` : ""].filter(Boolean);
    api.tray(parts.join(" "), `Dispatch · ${unread} 未读回复 · ${working} 在跑 · ${notificationInbox.waiting.length} 等你 · ${notificationInbox.review.length} 待 Agent 复核 · ${issues.filter((i) => i.status !== "closed" && !isOutcome(i) && !isTrashed(i)).length} 项未完成`, quotaLines).catch(() => {});
  }, [api, observedPresence, notificationInbox, issues, activityRows, quota, inArchivedProject]);

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

  // The most recent conversation folder of a project: where a delegated agent should start.
  const dirOfProject = useCallback((name: string) => { const p = projectGroups(projectRows, issuesF, outcomesF).find((g) => g.name === name); const a = p?.sessions.find((x) => x.cwd && !/^\/(?:Users|home)\/[^/]+\/?$/.test(x.cwd)); return a?.cwd ?? ""; }, [projectRows, issuesF, outcomesF]);
  const startAgent = async (i: AgentStartInput) => { const r = await api!.agentStart(i); say(r ? `已在 ${r.host} 起了 ${r.kind}` : "起 Agent 失败"); return r; };

  const phoneLink = isTauri && api ? async () => { try { await api.copy((await api.on("local", ["serve", "url"])).trim()); say("手机访问链接已复制"); } catch (e) { say(String(e), true); } } : undefined;

  // Every conversation a row can stand for, by activity key, for the global right-click.
  const sessionByKey = useMemo(() => {
    const m = new Map<string, Activity>();
    const put = (a: Activity) => { if (!m.has(activityKey(a))) m.set(activityKey(a), a); };
    activityRows.forEach(put); projectRows.forEach(put);
    for (const r of refs.values()) put({ ...r, key: `${r.agent}:${r.session_id}`, tasks: Object.keys(r.tasks || {}), state: "unknown", stale: true, unread: false, activity: "", version: "", events: [], tracking_since: 0, source: "catalog" } as Activity);
    for (const x of observedPresence.sessions) put({ key: `${x.agent}:${x.session_id}`, agent: x.agent, session_id: x.session_id, cwd: x.cwd, project: x.project, title: x.herdr?.title || x.title || x.cwd, last_at: x.last_at, state: x.state, activity: "", version: "", events: [], tasks: [], unread: false, stale: !x.alive, tracking_since: 0, source: "presence", scheduled: x.scheduled, host: x.host, host_name: x.host_name, remote: x.remote });
    return m;
  }, [activityRows, projectRows, refs, observedPresence]);
  // This Mac's usage windows per agent, shown in the title bar.
  const quotaByAgent = useMemo(() => agents.filter((a) => a.actor.kind !== "human").map((a) => ({ agent: a, qs: quota.filter((x) => x.agent === a.actor.id && x.windows.length && (hostFilter ? (x.host_name ?? "") === hostFilter : !x.remote)) })).filter((x) => x.qs.length), [agents, quota, hostFilter]);
  const viewMenuItems: ViewMenuItem[] = [
    // What this page can do, then what every page can do.
    ...(BOARD_VIEWS.includes(view) ? [
      { label: view === "board" ? "切到表格" : "切到看板", onClick: () => setView(view === "board" ? "table" : "board") },
      { label: "清除筛选", onClick: () => { setFilters(EMPTY_FILTERS); setQuery(""); }, disabled: !Object.values(filters).some(Boolean) && filters.project === null && !query },
      { label: "回收站", onClick: () => setView("trash") },
    ] : []),
    ...(view === "inbox" && inbox.unread.length > 0 ? [{ label: `全部标记已读（${inbox.unread.length}）`, onClick: async () => { for (const a of inbox.unread) if (a.reply_id) await markRead(a, a.reply_id); } }] : []),
    ...(view === "settings" ? [{ label: "检查更新", onClick: () => void checkUpdate() }] : []),
    { label: "新建会话", hint: "⌘N", onClick: () => setNewSession(true) },
    { label: "新建任务", hint: "⌘T", onClick: () => setCreating(true) },
    { label: "刷新", hint: "⌘R", onClick: () => void reload() },
    { label: "搜索", hint: "⌘K", onClick: () => setSearch(true) },
    ...(isTauri && api ? [{ label: "复制手机访问链接", onClick: () => void phoneLink?.() }] : []),
    { label: theme === "dark" ? "切换为浅色主题" : theme === "light" ? "跟随系统主题" : "切换为深色主题", onClick: () => nextTheme() },
  ];

  const copyResume = async (agent: string, sessionId: string, cwd: string) => {
    if (!api) return;
    try { const cmd = await api.resumeCmd(agent, sessionId, cwd); await api.copy(cmd); say("恢复命令已复制，去终端粘贴回车"); } catch (e) { say(String(e), true); }
  };

  // Until first-run setup is finished, the app is a blank shell around the guide: no board,
  // no agents, no quota — nothing that would be read from a machine that is not set up yet.
  if (isTauri && initStatus && !initStatus.done && api) {
    return (
      <div className="app setup-shell">
        <div className="titlebar" data-tauri-drag-region>
          <div className="lead" data-tauri-drag-region><b>Dispatch</b><span className="muted">调度台</span></div>
          <div className="crumb" data-tauri-drag-region><b>首次设置</b></div>
          <div className="tb-right"><button className="btn ghost" onClick={nextTheme} title="切换主题">{theme === "dark" ? "☾" : theme === "light" ? "☼" : "◐"}</button></div>
        </div>
        <div className="body setup-body-wrap">
          <main className="main"><section className="view"><SetupView api={api} status={initStatus} onStatus={setInitStatus} onDone={async () => { try { const st = JSON.parse((await api.on("local", ["init", "status", "--json"])).replace(/^[^{]*/, "")) as InitStatus; setInitStatus(st); } catch { setInitStatus({ ...initStatus, done: true }); } void reload(); setView("home"); }} onError={(m) => say(m, true)} onNotify={say} /></section></main>
        </div>
        {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.text}</div>}
      </div>
    );
  }

  return (
    <SessionActions api={api} notify={say}><ConversationActions api={api} projects={Array.from(new Set([...projects.map(p=>p.name),...activity.sessions.map(a=>a.project_override||a.project)])).filter(Boolean)} onSaved={(a,c)=>{setRefs(old=>new Map([...old].map(([id,r])=>[id,r.session_id===a.session_id?{...r,...c}:r])));setActivity(old=>({...old,sessions:old.sessions.map(x=>activityKey(x)===activityKey(a)?{...x,...c}:x)}));say(c.scheduled===true?'已归入定时会话，默认隐藏':c.scheduled===false?'已恢复普通会话':c.starred===true?'已收藏：追踪中，不会自动归档':c.starred===false?'已取消收藏':c.archived===true?'已归档，会话页「已归档」可找回':c.archived===false?'已取消归档':'项目关联已保存');}} archiveDays={archiveDays} actions={{ onOpen: openSession, onRead: (a) => markRead(a, a.reply_id!), onResume: (a) => void copyResume(a.agent, a.session_id, a.cwd), hosts, onMove: async (a, hostId, hostName) => { say(`正在把会话和项目目录搬到 ${hostName}…`); try { const r = JSON.parse((await api!.on("local", ["move", a.session_id, "--to", hostId, "--json"])).replace(/^[^{]*/, "")); if (r.error) say(String(r.error), true); else say(`已迁移到 ${hostName}：${r.remote_cwd}，那边会话页能看到它继续；这里的原会话可以关了`); } catch (e) { say(String(e), true); } } }}><ProjectActions starred={(n) => isStarred(projectFlags, n)} archived={(n) => isArchived(projectFlags, n)} onFlag={setProjectFlag} onProject={openProject} onNew={(n) => { setNewSessionProject(n); setNewSessionContext(projectRows.find((a) => conversationProject(a) === n)); setNewSession(true); }} onTasks={(n) => { setFilters({ ...EMPTY_FILTERS, project: n === UNGROUPED_PROJECT ? "" : n }); setQuery(""); setView("board"); }}><ViewMenu items={viewMenuItems}><ItemMenus><TaskActions api={api} onOpen={setSelected} onDelegate={(id) => setDelegate({ task: id })} onDone={(m,id)=>{say(m);if(id===selected)setSelected(null);void reload();}} onError={m=>say(m,true)}><div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="lead" data-tauri-drag-region><b>Dispatch</b><span className="muted">调度台</span></div>
        <div className="crumb" data-tauri-drag-region>
          {backStack.length > 0 && <button className="btn ghost sm" onClick={goBack}>‹ 返回{VIEW_LABEL[backStack[backStack.length - 1].view]}</button>}{hostFilter && <><span>{hostFilter}</span><span className="sep">›</span></>}<b>{VIEW_LABEL[view]}</b>
          {view === "projects" && projectSelection && <><span className="sep">›</span><span>{projectSelection}</span></>}
          {BOARD_VIEWS.includes(view) && filters.project !== null && <><span className="sep">›</span><span>{filters.project || "未分项目"}</span></>}
          <span className="sync" title={info ? `${info.bd_bin} · ${info.version}` : ""}>{lastSync ? `同步 ${lastSync.toLocaleTimeString("zh-CN", { hour12: false })}` : "连接中…"}{!isTauri && (isServed ? " · 网页连接" : " · 示例数据")}</span>
        </div>
        <div className="tb-right">
          <button className="btn ghost" onClick={() => setSearch(true)} title="搜项目、会话、任务">搜索 <kbd>⌘K</kbd></button>
          <button className="btn ghost" onClick={() => setTour(true)} title="导览：这个软件怎么用">?</button>
          <button className="btn ghost" onClick={nextTheme} title="切换主题">{theme === "dark" ? "☾" : theme === "light" ? "☼" : "◐"}</button>
          {quotaByAgent.map(({ agent: a, qs }) => (
            <button key={a.actor.id} className="home-quota" onClick={() => setView("quota")} title={`${a.actor.name} 的额度${hostFilter ? ` · ${hostFilter}` : ""} · 点开看详情`}>
              <Avatar actor={a.actor} online={a.online} size={16} />
              {qs[0].windows.map((w) => { const p = w.used_percent ?? 0; return <span key={w.label} className={`q${p >= 90 ? " crit" : p >= 70 ? " warn" : ""}`}><span className="ql">{w.label}</span><span className="qbar"><i style={{ width: `${Math.min(100, p)}%` }} /></span><span className="mono">{w.used_percent === null ? "—" : `${Math.round(p)}%`}</span></span>; })}
            </button>
          ))}
          {update?.newer && !update.error && <button className="btn ghost update-chip" onClick={() => setView("settings")} title={`有新版本 v${update.latest}，点开设置更新`}>↑ v{update.latest}</button>}
          <button className="btn ghost status" onClick={() => setView("agents")} title="查看 Agent 状态"><span className="pulse" />{counts.agents} 在线 · {runningSessions} 进行中 ›</button>
          <button className="btn ghost" onClick={() => setNewSession(true)} title="新建会话（⌘N）">＋ 会话</button>
        </div>
      </div>

      <div className={`body${selected ? " with-detail" : ""}`}>
        <Sidebar info={info} view={view} setView={setView} counts={counts} projects={projects} agents={agents} filters={filters} setFilters={setFilters} hosts={hosts} hostFilter={hostFilter} setHostFilter={(h) => { setHostFilter(h); setSelected(null); }} onAllTasks={allTasks} />
        <main className="main">
          <div className={`toolbar${BOARD_VIEWS.includes(view) ? "" : " bare"}`}>
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
              <label className="search board-search">🔍<input ref={searchRef} placeholder="筛任务、ID、Agent…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button aria-label="清除任务筛选" onClick={() => setQuery("")}>✕</button>}</label>
              <button className="chip" onClick={() => setCreating(true)} title="任务通常由 Agent 自己建；这里手动建一条">＋ 新任务</button>
              <button className={`chip${hostIssues.some(isTrashed) ? "" : " zero"}`} onClick={()=>setView("trash")}>回收站 {hostIssues.filter(isTrashed).length}</button>
              <button className="chip" disabled={!Object.values(filters).some(Boolean) && filters.project === null && !query} onClick={() => { setFilters(EMPTY_FILTERS); setQuery(""); }}>清除筛选</button>
              <button className={`chip${filters.review ? " on" : ""}${counts.review ? "" : " zero"}`} onClick={() => setFilters({ ...filters, review: !filters.review, blocked: false })}>Agent 复核 {counts.review}</button>
              <button className={`chip${filters.blocked ? " on" : ""}${counts.blocked ? "" : " zero"}`} onClick={() => setFilters({ ...filters, blocked: !filters.blocked, review: false })}>阻塞 {counts.blocked}</button>
              <button className={`chip${filters.urgent ? " on" : ""}`} onClick={() => setFilters({ ...filters, urgent: !filters.urgent })}>P0–P1</button>
              {filters.agent && <button className="chip on" onClick={() => setFilters({ ...filters, agent: null })}>{filters.agent} ✕</button>}
              <span className="muted mono" style={{ fontSize: 11 }}>{visible.length} 项</span>
            </>)}
          </div>
          {err && <div className="err">{err}</div>}
          <section className="view">
            {view === "home" && api && <HomeView insight={insight} me={me} loaded={activity.updated_at>0} connectionError={activityError} unavailable={activity.unavailable_hosts} rows={projectRows} issues={issuesF} outcomes={outcomesF} inbox={inbox} progress={progress} flags={projectFlags} onFlag={setProjectFlag} archiveDays={archiveDays} expandedDefault={settings.home_expanded} onOpen={openSession} onFocus={focusSession} onTask={setSelected} onProject={openProject} onView={(v)=>{ if (v==="board") allTasks(); else setView(v); }} onNew={a=>{setNewSessionProject(a?conversationProject(a):null);setNewSessionContext(a);setNewSession(true);}} />}
            {view === "projects" && api && <ProjectHub archiveDays={archiveDays} flags={projectFlags} onFlag={setProjectFlag} connectionError={activityError} unavailable={activity.unavailable_hosts} rows={projectRows} tasks={issuesF} outcomes={outcomesF} api={api} me={me} selected={projectSelection} onProject={setProjectSelection} onOpen={openSession} onTask={setSelected} onRead={a=>markRead(a,a.reply_id!)} onReload={reload} onNew={a=>{setNewSessionProject(projectSelection);setNewSessionContext(a);setNewSession(true);}} loaded={activity.updated_at>0} />}
            {view === "graph" && api && <GraphView api={api} me={me} version={version} selected={selected} onSelect={setSelected} />}
            {view === "inbox" && <InboxView onRead={a => markRead(a, a.reply_id!)} onOpen={openSession} initialTab={inboxTab} items={inbox} me={me} onSelect={setSelected} onFocus={focusSession} />}
            {view === "board" && <Board progress={progress} issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} onMove={move} onAdd={() => setCreating(true)} />}
            {view === "table" && <TableView issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} />}
            {view === "agents" && <AgentsView agents={agents} scheduled={scheduledSessions} apps={presenceF.apps} issues={issuesF} me={me} onSelect={(id) => { setSelected(id); }} onFocus={focusSession} refs={refsF} hosts={hosts} onOpenUrl={(u) => api?.openPath(u).catch((e) => say(String(e), true))} onCopyText={(t, what) => api?.copy(t).then(() => say(what.endsWith("。") ? what : `${what}已复制`)).catch((e) => say(String(e), true))} onDelegate={(h) => setDelegate({ host: h.id })} />}
            {view === "sessions" && api && <SessionsView archivedProjects={new Set(projectList.archived.map((p) => p.name))} refs={[...refsF.values()]} scriptCount={scriptCount} refsLoaded={refs.size > 0 || activity.updated_at > 0} archiveDays={archiveDays} outcomes={outcomesF} activities={activityF} issues={issuesF} onSeen={markRead} activityError={activityError} key={(sessionFocus ?? "all") + hostId} api={api} me={me} live={presenceF.sessions} hostId={hostId} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} initialId={sessionFocus ?? (info?.initial_task?.startsWith("session:") ? info.initial_task.slice(8) : null)} />}
            {view === "trash" && <><p className="trash-note">移除的任务保留记录与依赖，不会进入待办队列。右键或点击 ⋯ 可恢复。</p><TableView issues={hostIssues.filter(isTrashed)} selected={selected} onSelect={setSelected} me={me}/></>}
            {(view === "stats" || view === "quota") && api && <UsageView key={view} initialTab={view === "quota" ? "quota" : undefined} onDone={say} onStart={startAgent} api={api} me={me} host={hostId} hostName={hostFilter} onError={(m) => say(m, true)} />}
            {view === "skills" && api && <SkillsView hostId={hostId} api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "rules" && api && <RulesView hostId={hostId} api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "settings" && <SettingsView update={update} onCheckUpdate={checkUpdate} onApplyUpdate={applyUpdate} settings={settings} onSave={saveSettings} theme={theme} onTheme={setTheme} onPhone={phoneLink} hosts={hosts} onSetup={isTauri && api ? async () => { try { const st = JSON.parse((await api.on("local", ["init", "status", "--json"])).replace(/^[^{]*/, "")) as InitStatus; setInitStatus(st); setView("setup"); } catch (e) { say(String(e), true); } } : undefined} />}
            {view === "setup" && api && initStatus && <SetupView api={api} status={initStatus} onStatus={setInitStatus} onDone={() => { void reload(); setView("home"); }} onError={(m) => say(m, true)} onNotify={say} />}
            {view === "env" && api && <EnvView hostId={hostId} api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "pitfalls" && api && <PitfallsView api={api} projects={projects.map((p) => p.name).filter(Boolean)} version={version} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
          </section>
        </main>
        {selected && api && (
          <Detail rows={projectRows} onOpenSession={openSession} key={selected} id={selected} api={api} me={me} root={rootIssue(selected) ?? null} initial={issues.find((i) => i.id === selected) ?? null} stamp={issues.find((i) => i.id === selected)?.updated_at ?? String(version)} live={presence.sessions} onClose={() => setSelected(null)} onSelect={setSelected} onError={(m) => say(m, true)} onDone={(m) => { say(m); reload(); }} />
        )}
      </div>

      <MobileNav view={view} setView={(v) => { if (v === "board" || v === "table") allTasks(); else setView(v); }} badge={counts.inbox} />
      {tour && <Tour onClose={closeTour} onGo={(v) => setView(v)} />}
      {newSession && api && <NewSession api={api} hosts={hosts} initialHost={newSessionContext?.host || hostId} initialCwd={newSessionContext?.cwd} onComputer={host => { setNewSession(false); setHostFilter(hosts.find(h => host === (h.local ? "local" : h.id))?.name || ""); setView("agents"); }} onClose={() => {setNewSession(false);setNewSessionContext(undefined);setNewSessionProject(null);}} onCreated={async (sid, host, agent) => { if(newSessionProject&&newSessionProject!==UNGROUPED_PROJECT)try{await api.on(host,["session-preferences",`${agent}:${sid}`,JSON.stringify({project_override:newSessionProject}),"--json"]);}catch(e){say(`会话已创建，项目关联失败：${String(e)}`,true);} setNewSessionProject(null);setNewSessionContext(undefined); setNewSession(false); setHostFilter(hosts.find(h => host === (h.local ? "local" : h.id))?.name || ""); openSession(sid); }} />}
      {delegate && api && <Delegate hosts={hosts} initialHost={delegate.host} initialTask={delegate.task} issues={issuesF} me={me} dirOfProject={dirOfProject} onClose={() => { setDelegate(null); void reload(); }} onStart={startAgent} />}
      {search && <SearchPalette archiveDays={archiveDays} projects={projects.map((p) => p.name)} rows={projectRows} issues={issuesF} me={me} onProject={openProject} onSession={openSession} onTask={(id) => setSelected(id)} onClose={() => setSearch(false)} />}
      {creating && <NewTask projects={projects.map((p) => p.name).filter(Boolean)} defaultProject={filters.project} onCancel={() => setCreating(false)} onCreate={create} />}
      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.text}</div>}
      <GlobalContextMenu issues={issues} sessions={sessionByKey} />
    </div></TaskActions></ItemMenus></ViewMenu></ProjectActions></ConversationActions></SessionActions>
  );
}
