import { confirmAction } from './confirm';
import { ConversationActions, useConversationActionItems } from './components/ConversationActions';
import { GlobalContextMenu, ItemMenus, ProjectActions, ViewMenu, useProjectActionItems, type ViewMenuItem } from './components/ContextMenu';
import { TaskActions, isArchivedTask, isTrashed, useTaskActionItems } from "./components/TaskActions";
import { selectQuotas, type SharedQuota } from './quotas';
import { UsageView } from "./components/Quota";
import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { openInApp, projectFolder, sessionFolder, useExternalApps } from "./editorApps";
import { getApi, isServed, unsupportedMessage, type Api, type AgentStartInput } from "./api";
import { firstInstalled, setInstalledAgents } from "./installedAgents";
import { setProjectHosts } from "./projectHosts";
import { Detail } from "./components/Detail";
import { SessionActions, closeChat } from "./components/SessionActions";
import { NewChat } from "./components/NewChat";
import { NewTask } from "./components/NewTask";
import { Sidebar, type Filters } from "./components/Sidebar";
import { AgentsView, Board, ListView, TableView, type BoardSort } from "./components/views";
import { TaskTabs } from "./components/TaskTabs";
import { PitfallsView } from "./components/Pitfalls";
import { SessionsView } from "./components/Sessions";
import { SkillsView } from "./components/Skills";
import { RulesView } from "./components/InstructionCenter";
import { EnvView } from "./components/Env";
import { InboxView, type InboxItems } from "./components/Inbox";
import { ProjectHub, projectPlace } from "./components/ProjectHub";
import { HomeView } from "./components/Home";
import { ActionPanel, type PanelSection } from "./components/ActionPanel";
import { AssignProjectProvider } from "./components/AssignProject";
import { ShellProvider, type ActionTarget, type PrimaryAction, type ShellHeader } from "./components/Shell";
import { Kbd, Shortcut } from "./components/primitives";
import { Icon } from "./components/icons";
import type { QuotaBrief } from "./components/Sidebar";
import { foldHostCopies, migrationCheckPrompt, refMap, type MigrationCheck } from "./moves";
import { DEFAULT_SETTINGS, PROJECT_FLAGS_KEY, newSessionTarget, ownerHostId, parseProjectFlags, parseProjectOwners, parseSettings, serializeProjectFlags, settingsPatch, withProjectFlag, type DispatchSettings, type ProjectFlagChange, type ProjectFlags, type ProjectOwner, projectLabel, projectDirs } from "./projectFlags";
import { SettingsView } from "./components/Settings";
import type { UpdateInfo } from "./components/Settings";
import { Delegate } from "./components/Delegate";
import { DiscussDialog } from "./components/Discuss";
import { DiscussView } from "./components/DiscussView";
import { isOutcome, knownProjects, linkedSessions, projectGroups, projectHome, sourceTasks, projectConversations } from "./projectModel";
import { isHome, isMac, isWindows, modKey } from "./platform";
import { UNGROUPED_PROJECT, tildePath, activityKey, conversationProject, isScriptSession, isSubagentSession, mergeActivity, resolveProject } from "./activity";
import { isArchived, isStarred, rankProjects } from "./projectFlags";
import { ThreadView } from "./components/Thread";
import { OverviewView, Tour } from "./components/Guide";
import { MobileNav } from "./components/MobileNav";
import { needsReview, needsAttention, agentsFrom, columnOf, projectOf, rootsOf, hostOfIssue , setHumanAliases } from "./derive";
import { intlLocale, useLocale, useT , subscribe as subscribeLocale } from "./i18n";
import type { Activity, ActivitySnapshot, Column, Host, Info, Issue, NewIssue, Presence, Quota, SessionRef, View, MoveJob } from "./types";

type Theme = "light" | "dark" | "";
const VIEW_LABEL: Record<View, string> = { home: "工作台", inbox: "等我", list: "全部任务", board: "全部任务", table: "全部任务", graph: "脉络", projects: "项目", agents: "Agent 状态", settings: "设置", sessions: "会话", discuss: "讨论", stats: "统计与额度", skills: "技能", rules: "规则与资料", pitfalls: "知识库", env: "环境", quota: "统计与额度", trash: "回收站", archive: "已归档任务", overview: "总览", "new-chat": "新会话" };
const VIEWS: View[] = ["home", "inbox", "list", "board", "table", "graph", "projects", "agents", "settings", "sessions", "discuss", "stats", "skills", "rules", "pitfalls", "env", "quota", "trash", "archive", "overview", "new-chat"];
const BOARD_VIEWS: View[] = ["list", "board", "table"];
const TASK_VIEWS: View[] = ["list", "board", "table", "trash", "archive"];  // share the 列表/看板/表格/回收站/已归档 switch
// 全部任务 opens in the layout used last: 列表 (the default), 看板 or 表格.
const TASK_VIEW_KEY = "dispatch-task-view";
const lastTaskView = (): View => { try { const v = localStorage.getItem(TASK_VIEW_KEY); return v === "board" || v === "table" ? v : "list"; } catch { return "list"; } };

// ---- Where you are lives in the URL hash: `#/board`, `#/sessions/<id>`, `#/discuss/<task>`, `#/projects/<name>`, `#/board/task/<id>`.
// Reload restores it; the browser's back/forward (and the phone's back gesture) walk it instead of leaving the app.
type Place = { view: View; selected: string | null; project: string | null; session: string | null; discussion?: string | null };
function placeToHash(p: Place): string {
  const parts: string[] = [p.view];
  if (p.view === "projects" && p.project) parts.push(p.project);
  if (p.view === "sessions" && p.session) parts.push(p.session);
  if (p.view === "discuss" && p.discussion) parts.push(p.discussion);
  if (p.selected) parts.push("task", p.selected);
  return "#/" + parts.map(encodeURIComponent).join("/");
}
function parseHash(h: string): Place | null {
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (!parts.length || !(VIEWS as string[]).includes(parts[0])) return null;
  const view = parts[0] as View;
  const ti = parts.indexOf("task", 1);
  const selected = ti > 0 && parts[ti + 1] ? parts[ti + 1] : null;
  const arg = parts[1] && parts[1] !== "task" ? parts[1] : null;
  return { view, selected, project: view === "projects" ? arg : null, session: view === "sessions" ? arg : null, discussion: view === "discuss" ? arg : null };
}
const EMPTY_FILTERS: Filters = { project: null, mine: false, urgent: false, agent: null, blocked: false, review: false };

// The browser demo builds its sample data once per page load in the current language
// (fixtures.ts): after a language switch it needs a reload to speak that language.
if (!isServed) subscribeLocale(() => { window.location.reload(); });

export default function App() {
  const t = useT();
  const locale = useLocale();
  // 新建会话 v3 (a page, not a dialog): what it was opened for, when it came from a project or a conversation.
  const [newChatCtx, setNewChatCtx] = useState<{ project?: string | null; cwd?: string; host?: string } | null>(null);
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
    } catch { setToast({text: t("标记已读失败，请重试"), err: true}); }
  }, [api]);
  const markUnread = useCallback(async (a: Activity) => {
    if (!api) return;
    try {
      await api.sessionSeen(a.host ?? 'local', a.key, "unread");
      acknowledged.current.delete(activityKey(a));
      setActivity(old => ({ ...old, sessions: old.sessions.map(x => activityKey(x) === activityKey(a) && x.reply_id ? { ...x, unread: true } : x) }));
    } catch { setToast({text: t("标为未读失败，请重试"), err: true}); }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let stopped = false; let timer = 0; let failures = 0; let loadedOnce = false;
    const tick = async () => {
      // Hidden windows skip the poll, but the first load always runs: an app started behind a
      // locked screen would otherwise show no conversations until someone looks at it.
      if (document.visibilityState === 'visible' || !loadedOnce) {
        try {
          const snapshot = await api.sessionActivity();
          failures = 0; loadedOnce = true;
          if (!stopped) { setActivity({ ...snapshot, sessions: snapshot.sessions.map(a => acknowledged.current.get(activityKey(a)) === a.reply_id ? { ...a, unread: false } : a) }); setActivityError(false); }
        } catch (e) { failures++; if (!stopped) { setActivityError(true); console.warn("activity poll failed:", e); } }
      }
      // Back off while the Mac does not answer (3 s → 6 → 12 → 24 → 30): a phone on a bad link
      // should not hammer it, and the first success returns to the normal pace.
      if (!stopped) timer = window.setTimeout(tick, Math.min(30_000, 3000 * 2 ** Math.min(failures, 4)));
    };
    tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [api]);
  const progressCache = useRef(new Map<string, { stamp: string; text: string }>());
  const presenceOnce = useRef(false);  // a hidden window keeps the first presence read and then stops polling
  // Agents installed on this Mac: dialogs default to one of them (see installedAgents.ts).
  useEffect(() => { if (!api) return; void api.on("local", ["agents-installed", "--json"]).then((s) => { const rows = JSON.parse(s.slice(Math.max(0, s.indexOf("[")))) as { id: string; found: boolean }[]; setInstalledAgents(rows.filter((r) => r.found).map((r) => r.id)); }).catch(() => setInstalledAgents(null)); }, [api]);
  // The first session-index read finished (even if it failed): the sessions page stops saying 「索引中…」.
  const [refsTried, setRefsTried] = useState(false);
  // New releases: checked when the settings page opens; the bottom bar shows a chip when one exists.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const checkUpdate = useCallback(async () => { if (!api) return; try { const r = JSON.parse((await api.on("local", ["update", "check", "--json"])).replace(/^[^{]*/, "")) as UpdateInfo; setUpdate(r); } catch (e) { setUpdate({ current: "?", latest: "", url: "", error: String(e) }); } }, [api]);
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [presence, setPresence] = useState<Presence>({ sessions: [], apps: [] });
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err?: boolean; undo?: () => void } | null>(null);
  // Task ids in any rendered text are links (Markdown.tsx); they arrive here as one event.
  useEffect(() => {
    const h = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) setSelected(id); };
    window.addEventListener("dispatch:open-task", h);
    return () => window.removeEventListener("dispatch:open-task", h);
  }, []);
  // Web mode only: the Mac updated underneath this page (served version changed) → offer a refresh.
  const [webUpdate, setWebUpdate] = useState("");
  useEffect(() => {
    if (!isServed) return;
    let first = "";
    const tick = async () => {
      try {
        const h = await (await fetch("/api/health", { cache: "no-store" })).json() as { version?: string; moved?: boolean };
        // The phone's entry moved to another Mac: reload, the server takes this phone there.
        // At most once in ten minutes: when that Mac is down this one keeps serving, and must not reload forever.
        if (h.moved && !window.location.search.includes("stay")) {
          let last = 0; try { last = Number(sessionStorage.getItem("dispatch-moved-try") || 0); } catch { /* private mode */ }
          if (Date.now() - last > 600_000) { try { sessionStorage.setItem("dispatch-moved-try", String(Date.now())); } catch { /* private mode */ } window.location.reload(); return; }
        }
        if (!h.version) return;
        if (!first) first = h.version; else if (h.version !== first) setWebUpdate(h.version);
      } catch { /* offline; try again later */ }
    };
    void tick();
    const tm = window.setInterval(tick, 60_000);
    const vis = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", vis);
    return () => { window.clearInterval(tm); document.removeEventListener("visibilitychange", vis); };
  }, []);
  const initialPlace = useRef<Place | null>(parseHash(window.location.hash));
  const [view, changeView] = useState<View>(initialPlace.current?.view ?? "home");
  const [inboxTab, setInboxTab] = useState<keyof InboxItems | null>(null);
  const [selected, setSelected] = useState<string | null>(initialPlace.current?.selected ?? null);
  const [projectSelection, setProjectSelection] = useState<string | null>(()=>initialPlace.current?.project ?? new URLSearchParams(location.search).get("project"));
  const [backStack, setBackStack] = useState<{ view: View; selected: string | null }[]>([]);
  const navigateContext = (next: View) => { setBackStack((stack) => [...stack, { view, selected }]); changeView(next); setSelected(null); };
  const goBack = () => { const previous = backStack[backStack.length - 1]; if (previous) { changeView(previous.view); setSelected(previous.selected); setBackStack((stack) => stack.slice(0, -1)); } };
  const setView = useCallback((next: View) => { changeView(next); setSelected(null); setInboxTab(null); setBackStack([]); if (next === "projects") setProjectSelection(null); }, []);
  const openProject = (name: string) => { setProjectSelection(name); navigateContext("projects"); };
  // 工作台卡片标题 → 项目页对应分区：先切到项目页，再让 ProjectHub 落到 review / sessions 标签。
  const [hubSection, setHubSection] = useState<{ section: "review" | "sessions"; token: number } | null>(null);
  const locateProject = (name: string, section: "review" | "sessions") => { setProjectSelection(name); navigateContext("projects"); setHubSection({ section, token: Date.now() }); };
  const [filters, setFilters] = useState<Filters>({ project: null, mine: false, urgent: false, agent: null, blocked: false, review: false });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [boardSort, setBoardSort] = useState<BoardSort>(() => { try { return (localStorage.getItem("dispatch-board-sort") as BoardSort) || "priority"; } catch { return "priority"; } });
  const changeBoardSort = (s: BoardSort) => { setBoardSort(s); try { localStorage.setItem("dispatch-board-sort", s); } catch { /* ignore */ } };
  // ⌘K action panel (search lives inside it), and what the current page published for the frame.
  const [panel, setPanel] = useState(false);
  const [shellHeader, setShellHeader] = useState<ShellHeader | null>(null);
  const [shellTarget, setShellTarget] = useState<ActionTarget | null>(null);
  const [errDetail, setErrDetail] = useState(false);
  const [migrationCheck, setMigrationCheck] = useState<MigrationCheck | null>(null);
  const [delegate, setDelegate] = useState<{ cwd?: string; host?: string; task?: string; prompt?: string; label?: string; kind?: string; model?: string } | null>(null);
  // 讨论一个念头: a topic (optionally under a project) put to several agents at once.
  const [discuss, setDiscuss] = useState<{ project?: string; task?: string } | null>(null);
  const [detailWf, setDetailWf] = useState<"split" | undefined>(undefined);
  const [sessionFocus, setSessionFocus] = useState<string | null>(initialPlace.current?.session ?? null);
  // The session the list currently shows (reported by SessionsView); only for the URL, so selecting one does not remount the view.
  const [sessionShown, setSessionShown] = useState<string | null>(initialPlace.current?.session ?? null);
  // The discussion the 讨论 page shows (for the URL) and the one it was asked to open.
  const [discussShown, setDiscussShown] = useState<string | null>(initialPlace.current?.discussion ?? null);
  const [discussFocus, setDiscussFocus] = useState<string | null>(initialPlace.current?.discussion ?? null);
  // Keep the hash in step with the place. After popstate the hash already equals the new place, so nothing is pushed twice.
  useEffect(() => {
    const here = placeToHash({ view, selected, project: projectSelection, session: view === "sessions" ? sessionShown : null, discussion: view === "discuss" ? discussShown : null });
    if (window.location.hash === here) return;
    if (window.location.hash && parseHash(window.location.hash)) window.history.pushState(null, "", here); else window.history.replaceState(null, "", here);
  }, [view, selected, projectSelection, sessionShown, discussShown]);
  useEffect(() => {
    const onPop = () => {
      const p = parseHash(window.location.hash); if (!p) return;
      changeView(p.view); setSelected(p.selected); setBackStack([]);
      if (p.view === "projects") setProjectSelection(p.project);
      if (p.view === "sessions") { setSessionFocus(p.session); setSessionShown(p.session); }
      if (p.view === "discuss") { setDiscussFocus(p.discussion ?? null); setDiscussShown(p.discussion ?? null); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Where you have been: every change of place (view, project, conversation, task) leaves the previous
  // one on a trail, so 「‹ 返回」 in the top bar always goes back one step — a conversation → 额度 → back
  // lands on the same conversation. Independent of the browser history.
  const placeNow = useMemo<Place>(() => ({ view, selected, project: projectSelection, session: view === "sessions" ? sessionShown : null, discussion: view === "discuss" ? discussShown : null }), [view, selected, projectSelection, sessionShown, discussShown]);
  const [trail, setTrail] = useState<Place[]>([]);
  const lastPlace = useRef<Place | null>(null);
  const restoredAt = useRef(0);
  useEffect(() => {
    const prev = lastPlace.current; lastPlace.current = placeNow;
    if (!prev || placeToHash(prev) === placeToHash(placeNow)) return;
    // The states of a restored place settle over a couple of renders; none of those is a new step.
    if (Date.now() - restoredAt.current < 400) return;
    setTrail((tr) => [...tr.slice(-29), prev]);
  }, [placeNow]);
  const goBackPlace = () => {
    const p = trail[trail.length - 1]; if (!p) return;
    restoredAt.current = Date.now();
    setTrail((tr) => tr.slice(0, -1)); setBackStack([]);
    changeView(p.view); setSelected(p.selected); setProjectSelection(p.project);
    if (p.view === "sessions") { setSessionFocus(p.session); setSessionShown(p.session); }
    if (p.view === "discuss") { setDiscussFocus(p.discussion ?? null); setDiscussShown(p.discussion ?? null); }
  };
  const backTarget = trail[trail.length - 1];
  // Platform classes for the few styles that differ between macOS and Windows.
  useEffect(() => { const c = document.documentElement.classList; c.toggle("mac", isMac); c.toggle("win", isWindows); }, []);
  // The phone is for talking to Agents, like Codex's app: IDE mode stays on the Mac.
  const PHONE = "(max-width: 760px), (pointer: coarse)";
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => { const mq = window.matchMedia(PHONE); const on = () => setPhone(mq.matches); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, []);
  // ?solo=1: this window shows one conversation and nothing else: the panes of 分屏 load the app this way.
  const solo = useMemo(() => new URLSearchParams(window.location.search).has("solo"), []);
  // ⌘+click (Ctrl+click on Windows) on anything that stands for a project, a conversation or a task opens it in a new window.
  useEffect(() => {
    if (!api) return;
    const handler = (e: MouseEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.button !== 0) return;
      const el0 = e.target as HTMLElement | null;
      if (!el0 || typeof el0.closest !== "function" || el0.closest("input,textarea,select,a[href]")) return;
      const el = el0.closest<HTMLElement>("[data-project],[data-session],[data-task]");
      if (!el) return;
      let hash = "";
      if (el.dataset.project !== undefined && el.dataset.project) hash = `#/projects/${encodeURIComponent(el.dataset.project)}`;
      else if (el.dataset.session) { const parts = el.dataset.session.split(":"); hash = `#/sessions/${encodeURIComponent(parts[parts.length - 1])}`; }
      else if (el.dataset.task) hash = `#/board/task/${encodeURIComponent(el.dataset.task)}`;
      if (!hash) return;
      e.preventDefault(); e.stopPropagation();
      void api.openWindow(hash);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [api]);
  const backLabel = (p: Place) => p.view === "sessions" && p.session ? t("会话") : p.view === "projects" && p.project ? t("项目 {name}", { name: p.project }) : t(VIEW_LABEL[p.view]);
  // The tour never opens on its own; the design should carry itself. `?` still has it.
  const [tour, setTour] = useState(false);
  const closeTour = () => setTour(false);
  const openSession = (id: string) => { setSessionFocus(id); setSessionShown(id); navigateContext("sessions"); };
  // ⌘N, 页头「＋ 会话」, ⌘K「新建会话」 and a project's 新建会话 open the new-chat page (newChatHere picks the project you are in); the old dialog stays behind ⌘O.
  const openNewChat = (ctx?: { project?: string | null; cwd?: string; host?: string } | null) => { setNewChatCtx(ctx ?? null); if (view !== "new-chat") navigateContext("new-chat"); };
  const newChatHereRef = useRef<() => void>(() => openNewChat());
  const leaveNewChat = () => { if (trail.length) goBackPlace(); else if (backStack.length) goBack(); else setView("home"); };
  // Where the person had scrolled each view to, so coming back (工作台 → a reply → back) lands on the same rows.
  const viewEl = useRef<HTMLElement>(null);
  const scrollMemo = useRef<Record<string, number>>({});
  const scrollKey = `${view}:${view === "projects" ? projectSelection ?? "" : ""}`;
  const scrollKeyRef = useRef(scrollKey); scrollKeyRef.current = scrollKey;
  useLayoutEffect(() => {
    const want = scrollMemo.current[scrollKey] ?? 0;
    let tries = 0, raf = 0;
    const tick = () => { const el = viewEl.current; if (!el) return; el.scrollTop = want; if (Math.abs(el.scrollTop - want) > 2 && tries++ < 30) raf = requestAnimationFrame(tick); };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [scrollKey]);
  const previousView = backStack[backStack.length - 1]?.view;
  const openDiscussion = (id?: string) => { setDiscussFocus(id ?? null); setDiscussShown(id ?? null); navigateContext("discuss"); };
  const [version, setVersion] = useState(0);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  // Which Mac to look at: "" = all, else a host *name* (matches session.host_name and the host:<name> task label).
  const [hostFilter, setHostFilter] = useState<string>(() => { try { return localStorage.getItem("dispatch-host") ?? ""; } catch { return ""; } });
  useEffect(() => { try { localStorage.setItem("dispatch-host", hostFilter); } catch { /* ignore */ } }, [hostFilter]);
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem("dispatch-theme") as Theme) ?? ""; } catch { return ""; } });
  const searchRef = useRef<HTMLInputElement>(null);
  const allTasks = () => { setFilters(EMPTY_FILTERS); setQuery(""); setView(lastTaskView()); };
  const setTaskView = (v: View) => { if (BOARD_VIEWS.includes(v)) { try { localStorage.setItem(TASK_VIEW_KEY, v); } catch { /* per-device */ } } setView(v); };
  const toastTimer = useRef<number | undefined>(undefined);

  const me = info?.actor ?? "user";

  const say = useCallback((text: string, isErr = false, undo?: () => void) => {
    // "Not on Windows yet" is a note, not a red error.
    const note = isErr ? unsupportedMessage(text) : null;
    if (note) { text = note; isErr = false; }
    setToast({ text, err: isErr, undo });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), isErr ? 6000 : note ? 4000 : undo ? 5000 : 1800);
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
        if (!initialPlace.current && (VIEWS as string[]).includes(requestedView ?? "")) changeView(requestedView as View);
        if (!initialPlace.current && inf.initial_task && !inf.initial_task.startsWith("session:")) setSelected(inf.initial_task);
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
    const tm = window.setInterval(() => { if (document.visibilityState === "visible") void reload(); }, 10_000);
    return () => window.clearInterval(tm);
  }, [api, reload]);

  // Presence is cheap (a ps call + a few JSON files), so poll it often.
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { if (document.visibilityState !== "visible" && presenceOnce.current) return; presenceOnce.current = true; try { const p = await api.presence(); if (alive) { setPresence(p); setPresenceLoaded(true); } } catch { /* keep last */ } };
    tick();
    const tm = window.setInterval(tick, 5_000);
    return () => { alive = false; window.clearInterval(tm); };
  }, [api]);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("dispatch-theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    // On a Mac the shortcut key is ⌘ only: Ctrl+K / Ctrl+N / Ctrl+T are text-editing keys in every
    // macOS text field (kill line, next line, transpose) and must keep working while typing a reply.
    const mac = isMac;
    const onKey = (e: KeyboardEvent) => {
      const mod = mac ? e.metaKey : (e.metaKey || e.ctrlKey);
      if (mod && e.key.toLowerCase() === "k" && !e.defaultPrevented) { e.preventDefault(); setPanel((p) => !p); }
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newChatHereRef.current(); }
      if (mod && e.key.toLowerCase() === "t") { e.preventDefault(); setCreating(true); }
      if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); void reload(); }
      if (e.key === "Escape" && document.activeElement === searchRef.current) { setQuery(""); searchRef.current?.blur(); }
      // esc dismisses the bottom bar's message when nothing else is open to take it.
      else if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".overlay,.task-menu-shade,.ap-shade,.dialog") && !(e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=\"true\"]")) { setToast((x) => { if (x) return null; setErr(null); setErrDetail(false); return x; }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  // Lineage roots (which thread each task belongs to), refreshed with the issue list.
  const [roots, setRoots] = useState<Map<string, string>>(new Map());
  // Only a task's detail panel (and the board/table it opens from) reads them: the workbench,
  // sessions and settings do not pay for two whole-board `bd list` calls on every change.
  const needRoots = !!selected || BOARD_VIEWS.includes(view);
  useEffect(() => {
    if (!api || !needRoots) return;
    let alive = true;
    api.graph().then((g) => { if (alive) setRoots(rootsOf(g.edges)); }).catch(() => {});
    return () => { alive = false; };
  }, [api, version, needRoots]);
  const rootIssue = useCallback((id: string): Issue | undefined => { const r = roots.get(id); return r ? issues.find((i) => i.id === r) : undefined; }, [roots, issues]);

  const [hosts, setHosts] = useState<Host[]>([]);
  // Counts for the overview page, fetched lazily when it opens.
  const [skillCount, setSkillCount] = useState(0);
  const [wikiCount, setWikiCount] = useState(0);
  useEffect(() => { if (!api || view !== "overview") return; api.on("local", ["skills", "list", "--json"]).then((s) => setSkillCount((JSON.parse(s.replace(/^[^[]*/, "")) as unknown[]).length)).catch(() => {}); api.memories().then((m) => setWikiCount(m.filter((x) => !x.key.startsWith("dispatch-")).length)).catch(() => {}); }, [api, view]);


  // Project moves running in the background (dispatch project-moves): polled while any is running,
  // so the bar on the project survives page changes and reloads; each ending is announced once.
  const [moveJobs, setMoveJobs] = useState<MoveJob[]>([]);
  // This Mac's home is not known to a web page: the project right-click menu, like the project page, takes recorded folders as they are.
  const homeHere = "";
  const moveHost = useRef<string>("local");
  const announced = useRef(new Set<string>());
  const pollMoves = useCallback(async () => {
    if (!api) return;
    try {
      const out = await api.on(moveHost.current, ["project-moves", "--json"]);
      const parsed: unknown = JSON.parse(out.slice(Math.max(0, out.indexOf("["))));
      // Anything but a list (a host that answers "unsupported", an error object) means no moves:
      // moveJobs.some() runs during render, and a non-array there unmounts the whole app.
      const jobs = Array.isArray(parsed) ? (parsed as MoveJob[]) : [];
      setMoveJobs(jobs);
      for (const j of jobs) {
        if (j.state === "running" || announced.current.has(j.id) || Date.now() / 1000 - j.updated > 600) continue;
        announced.current.add(j.id);
        if (j.state === "failed") { say(t("迁移 {project} → {host} 失败：{error}", { project: j.project, host: j.to, error: j.error ?? "" }), true); continue; }
        const x = j.result;
        say([t("已把 {project} 交给 {host}", { project: j.project, host: j.to }), x?.git_checked ? (x.git_ok ? t("Git 两边一致") : t("Git 没对上，去 {host} 看 git status", { host: j.to })) : "",
          x?.sessions ? t("{n} 个会话已在那边接着跑", { n: x.sessions - x.sessions_failed }) : "", x?.sessions_failed ? t("{n} 个会话没迁过去", { n: x.sessions_failed }) : "",
          x?.opened ? t("已在 {host} 新开一个 {kind} 会话", { host: j.to, kind: x.opened }) : "", x?.open_error ? t("在 {host} 新开会话失败：{error}", { host: j.to, error: x.open_error }) : "", x?.history ? t("{n} 段历史会话已搬过去", { n: x.history }) : "", x?.history_failed ? t("{n} 段历史没搬成", { n: x.history_failed }) : "", x?.owner_error ? t("项目归属更新失败：{error}", { error: x.owner_error }) : ""].filter(Boolean).join(t("；")),
          !!x?.owner_error || !!x?.sessions_failed || !!x?.open_error || !!(x?.git_checked && !x.git_ok));
        api.memories().then((m) => setProjectOwners(parseProjectOwners(m))).catch(() => {});
        void reload();
      }
    } catch { /* next poll */ }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let timer = 0, stopped = false;
    const tick = async () => { await pollMoves(); if (!stopped) timer = window.setTimeout(tick, moveJobs.some((j) => j.state === "running") ? 2000 : 30000); };
    void tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [api, pollMoves, moveJobs.some((j) => j.state === "running")]);
  // One snapshot drives the header, overview, and menu bar, including manual refresh.
  const [quota, setQuota] = useState<Quota[]>([]);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const quotaRequest = useRef(0);
  const refreshQuota = useCallback(async () => {
    if (!api) return;
    const request = ++quotaRequest.current;
    setQuotaBusy(true);
    try {
      const rows = await api.quota();
      if (request === quotaRequest.current) { setQuota(rows); setQuotaError(''); }
    } catch (error) {
      if (request === quotaRequest.current) setQuotaError(String(error));
    } finally {
      if (request === quotaRequest.current) setQuotaBusy(false);
    }
  }, [api]);
  useEffect(() => {
    void refreshQuota();
    const timer = window.setInterval(() => void refreshQuota(), 60_000);
    return () => { ++quotaRequest.current; window.clearInterval(timer); };
  }, [refreshQuota]);
  const localHostName = hosts.find(h => h.local)?.name ?? '';
  const selectedQuotas = useMemo(() => selectQuotas(quota, hostFilter, localHostName), [quota, hostFilter, localHostName]);

  // Insights live on 统计; the workbench no longer shows them.
  // The proactive half: every few minutes ask for per-session alerts nobody has acknowledged;
  // a brand-new one gets a system notification once (the CLI keeps the seen-set, so the
  // reminder is shared across machines' apps of the same board).
  const notifiedAlerts = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const alerts = async () => {
      try {
        const xs = await api.insightAlerts(14);  // the same window as the card on 统计
        if (!alive) return;
        const unseen = xs.filter((x) => !notifiedAlerts.current.has(x.id));
        if (unseen.length && notifiedAlerts.current.size > 0) void api.notify(t("洞察"), unseen.length === 1 ? unseen[0].text : t("{n} 条新的会话洞察，统计页可看", { n: unseen.length })).catch(() => {});
        xs.forEach((x) => notifiedAlerts.current.add(x.id));
        if (notifiedAlerts.current.size === 0) notifiedAlerts.current.add("primed");
      } catch { /* optional */ }
    };
    // The scheduled report: the CLI decides whether the cadence is due; we just ask hourly.
    const due = () => api.insightDue().catch(() => {});
    const profileDue = () => api.profileDue().catch(() => {});
    const first = window.setTimeout(() => { void alerts(); void due(); void profileDue(); }, 4_000);
    const t2 = window.setInterval(() => void alerts(), 10 * 60_000);
    const t3 = window.setInterval(() => void due(), 60 * 60_000);
    const t4 = window.setInterval(() => void profileDue(), 60 * 60_000);
    return () => { alive = false; window.clearTimeout(first); window.clearInterval(t2); window.clearInterval(t3); window.clearInterval(t4); };
  }, [api]);

  // The Macs on the tailnet (this one + hosts.json), for the 机器 strip on the Agents view.
  const refreshHosts = useCallback(async () => { if (!api) return; try { setHosts(await api.hosts()); } catch { /* keep last */ } }, [api]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const h = await api.hosts(); if (alive) setHosts(h); } catch { /* keep last */ } };
    tick();
    const tm = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(tm); };
  }, [api]);
  // Settings 页「机器」：rename pushes to every known peer so their hosts.json agrees;
  // delete just drops the local entry (host_rows()/remote_dispatch() re-read the file each
  // call, so the next poll stops ssh'ing it); redetect clears that host's cached probe.
  const renameHost = async (h: Host, name: string) => {
    if (!api) return;
    try {
      const r = JSON.parse((await api.on(h.local ? "local" : h.id, ["init", "rename-self", name, "--json"])).replace(/^[^{]*/, ""));
      if (r.error) { say(String(r.error), true); return; }
      say(t("已改名为 {name}", { name: r.name ?? name }));
      await refreshHosts();
    } catch (e) { say(String(e), true); }
  };
  const deleteHost = async (h: Host) => {
    if (!api) return;
    try {
      const r = JSON.parse((await api.on("local", ["init", "remove-host", h.id, "--json"])).replace(/^[^{]*/, ""));
      if (r.error) { say(String(r.error), true); return; }
      say(t("已删除 {name}，不再尝试连接它", { name: h.name }));
      await refreshHosts();
    } catch (e) { say(String(e), true); }
  };
  const redetectHost = async (h: Host) => {
    if (!api) return;
    try {
      await api.on("local", ["hosts", "--refresh", h.id, "--json"]);
      await refreshHosts();
      say(t("已重新检测 {name}", { name: h.name }));
    } catch (e) { say(String(e), true); }
  };

  // Transcript index (titles, last claimed task) keyed by session id, for the Agents view.
  // Every Mac's copy as listed; `refs` below folds a moved conversation into one row.
  const [refsAll, setRefs] = useState<Map<string, SessionRef>>(new Map());
  // Which copies run right now (host|id), from the live process list (a bare pid-<pid> process counts for
  // its probable transcript): a running copy wins the fold,
  // and two running copies of one conversation both stay, with a warning.
  const liveCopies = useMemo(() => new Set(presence.sessions.filter((x) => x.alive).flatMap((x) => [x.session_id, x.probable_session_id].filter((id): id is string => !!id && !id.startsWith("pid-")).map((id) => `${x.host ?? "local"}|${id}`))), [presence]);
  const isLiveCopy = useCallback((r: { host?: string; session_id: string; runner?: string; stale?: boolean }) => liveCopies.has(`${r.host ?? "local"}|${r.session_id}`) || (!!r.runner && !r.stale), [liveCopies]);
  const refs = useMemo(() => refMap(foldHostCopies([...refsAll.values()], isLiveCopy)), [refsAll, isLiveCopy]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const tick = async () => { try { const l = await api.sessionList(); if (alive) { setRefs(refMap(l)); } } catch { /* index not ready */ } finally { if (alive) setRefsTried(true); } };
    tick();
    const tm = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(tm); };
  }, [api]);
  const hostId = useMemo(() => { if (!hostFilter) return ""; const h = hosts.find((x) => x.name === hostFilter); return h ? (h.local ? "local" : h.id) : ""; }, [hostFilter, hosts]);
  const localName = hosts.find((h) => h.local)?.name ?? "";
  const [settings, setSettings] = useState<DispatchSettings>(DEFAULT_SETTINGS);
  // Which signatures on the board are the person: the list from settings; re-render once it is known.
  const [, bumpAliases] = useState(0);
  useEffect(() => { setHumanAliases(settings.human_aliases.replace(/，/g, ",").split(",")); bumpAliases((n) => n + 1); }, [settings.human_aliases]);
  const archiveDays = settings.session_archive_days;
  // Through the CLI, not straight into the board memory: it merges only what changed (keys other builds added
  // survive) and signs the checking pair, which only the person may change.
  const saveSettings = async (next: DispatchSettings) => { if (!api) return; try { const changed = settingsPatch(settings, next); if (Object.keys(changed).length) await api.on("local", ["settings", "--save", "--json"], JSON.stringify(changed)); setSettings(next); say(t("设置已保存")); } catch (e) { say(String(e), true); } };
  // 新建 Agent's 新工作树 switch: saved at once and quietly (no toast for a checkbox)
  const setWorktree = (on: boolean) => { setSettings((s) => ({ ...s, new_worktree: on })); void api?.on("local", ["settings", "--save", "--json"], JSON.stringify({ new_worktree: on ? 1 : 0 })).catch((e) => say(String(e), true)); };
  // A real push through the CLI, so the button tests the same path the events use.
  const testNotify = async () => { if (!api) return; try { const r = JSON.parse((await api.on("local", ["notify", t("Dispatch 测试通知"), t("看到这条就说明推送通了"), "--json"])).replace(/^[^{]*/, "")) as { ok?: boolean; channel?: string; error?: string; fallback?: string }; if (r.channel === "macos") say(t("已发本机通知。在「环境」页配 NTFY_URL 或 BARK_KEY 就能推到手机")); else if (r.ok) say(t("已推到手机（{channel}）", { channel: r.channel ?? "" })); else { const m = r.error ?? t("没发出去"); say(r.fallback ? t("{msg}，已退回本机通知", { msg: m }) : m, true); } } catch (e) { say(String(e), true); } };
  const [projectFlags, setProjectFlags] = useState<ProjectFlags>({});
  const flagDirs = useMemo(() => projectDirs(projectFlags), [projectFlags]);
  const known = useMemo(() => knownProjects(issues, activity.sessions), [issues, activity]);
  const normalise = useCallback(<T extends { cwd: string; project: string; project_override?: string; scheduled?: boolean; path?: string; entrypoint?: string; title?: string }>(x: T): T => ({ ...x, project: resolveProject(x, known, settings.workspace_roots, flagDirs), scheduled: x.scheduled ?? (settings.sdk_sessions_scheduled && isScriptSession(x) ? true : undefined) }), [known, settings.sdk_sessions_scheduled, settings.workspace_roots, flagDirs]);
  // This Mac's rows arrive without a machine name (only peers' are tagged); name them too, so every
  // conversation says which Mac it is on — after `dispatch move` the same id exists on both.
  const activityRows = useMemo(() => foldHostCopies(activity.sessions, isLiveCopy).filter((a) => !isSubagentSession(a)).map(normalise).map((a) => a.host_name || !localName ? a : { ...a, host_name: localName }), [activity, normalise, localName, isLiveCopy]);
  const observedPresence = useMemo(() => mergeActivity({ ...presence, sessions: foldHostCopies(presence.sessions, (x) => !!x.alive) }, activityRows), [presence, activityRows]);
  const presenceF = useMemo(() => hostFilter ? { ...observedPresence, sessions: observedPresence.sessions.filter((x) => (x.host_name ?? localName) === hostFilter) } : observedPresence, [observedPresence, hostFilter, localName]);
  // Every conversation carries its resolved project from here on, so each view agrees on it.
  const refsF = useMemo(() => new Map([...refs].filter(([, r]) => !isSubagentSession(r) && (!hostFilter || (r.host_name ?? localName) === hostFilter)).map(([id, r]) => [id, normalise(r)])), [refs, hostFilter, localName, normalise]);
  const activityF = useMemo(() => activityRows.filter(a => !hostFilter || (a.host_name ?? localName) === hostFilter), [activityRows, hostFilter, localName]);
  const scriptCount = useMemo(() => [...refsF.values()].filter(isScriptSession).length, [refsF]);
  const projectRows = useMemo(()=>projectConversations(activityF,[...refsF.values()]),[activityF,refsF]);
  // 收藏 / 归档 per project: one shared bd memory, re-read whenever the board changes.
  const [projectOwners, setProjectOwners] = useState<Record<string, ProjectOwner>>({});
  // Per-project commands that read the project's own folder go to the Mac that holds it.
  useEffect(() => { const map: Record<string, string> = {}; for (const [name, o] of Object.entries(projectOwners)) { const id = ownerHostId(o, hosts); const h = hosts.find((x) => x.id === id); if (id && h && !h.local) map[name] = id; } setProjectHosts(map); }, [projectOwners, hosts]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.memories().then(async (m) => {
      if (!alive) return;
      setProjectFlags(parseProjectFlags(m)); setProjectOwners(parseProjectOwners(m));
      const parsed = parseSettings(m);
      setSettings(parsed);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, version]);
  const setProjectFlag = async (name: string, change: ProjectFlagChange) => {
    if (!api) return;
    const next = withProjectFlag(projectFlags, name, change);
    try { await api.remember(PROJECT_FLAGS_KEY, serializeProjectFlags(next)); setProjectFlags(next); say(change.dir !== undefined ? t("{name} 的目录记为 {dir}", { name, dir: change.dir }) : change.alias !== undefined ? (change.alias.trim() && change.alias.trim() !== name ? t("{name} 现在显示为「{alias}」", { name, alias: change.alias.trim() }) : t("{name} 恢复原名", { name })) : change.starred === true ? t("已收藏 {name}", { name }) : change.starred === false ? t("已取消收藏 {name}", { name }) : change.archived === true ? t("已归档 {name}，工作台不再显示", { name }) : t("已取消归档 {name}", { name })); }
    catch (e) { say(String(e), true); }
  };
  // One name per Mac: labels and saved filters written under an old name (rename, system name) map to the current one.
  const canonHost = useCallback((n: string) => hosts.find((h) => h.name === n || h.aliases?.includes(n))?.name ?? n, [hosts]);
  useEffect(() => { if (hostFilter && canonHost(hostFilter) !== hostFilter) setHostFilter(canonHost(hostFilter)); }, [hostFilter, canonHost]);
  const hostIssues = useMemo(() => hostFilter ? issues.filter((i) => canonHost(hostOfIssue(i, refs)) === hostFilter) : issues, [issues, refs, hostFilter, canonHost]);
  const issuesF = useMemo(() => hostIssues.filter(i=>!isTrashed(i)&&!isArchivedTask(i)&&!isOutcome(i)), [hostIssues]);
  // Closed more than 30 days ago and not yet archived: what the 归档 button would put away.
  const archivable = useMemo(() => hostIssues.filter((i) => i.status === "closed" && !isTrashed(i) && !isArchivedTask(i) && !isOutcome(i) && Date.now() - Date.parse(i.closed_at ?? i.updated_at) > 30 * 86_400_000), [hostIssues]);
  const archiveOld = async () => { if (!api || !archivable.length) return; say(t("正在归档 {n} 项…", { n: archivable.length })); try { for (const i of archivable) await api.labels(i.id, ["dispatch:archived"], []); say(t("已归档 {n} 项完成超过 30 天的任务，「已归档」里能找到", { n: archivable.length })); await reload(); } catch (e) { say(String(e), true); } };
  const outcomesF = useMemo(() => issues.filter(i=>!isTrashed(i)&&isOutcome(i)&&(!hostFilter || linkedSessions(i).some(id=>!!refs.get(id)&&(refs.get(id)?.host_name||localName)===hostFilter) || sourceTasks(i).some(id=>hostIssues.some(t=>t.id===id)))), [issues, hostIssues, hostFilter, refs, localName]);
  const liveSessions = useMemo(() => presenceF.sessions.filter((s) => !s.scheduled), [presenceF]);
  const scheduledSessions = useMemo(() => presenceF.sessions.filter((s) => s.scheduled), [presenceF]);
  const agents = useMemo(() => agentsFrom(issuesF, me, liveSessions), [issuesF, me, liveSessions, locale]);
  const runningSessions = liveSessions.filter((s) => s.alive && s.state === "working").length;
  // The same project list the workbench and project hub show: resolved from conversations,
  // task labels and outcomes together, archived ones set aside.
  const projectList = useMemo(() => rankProjects(projectGroups(projectRows, issuesF, outcomesF, projectFlags).filter((p) => p.name !== UNGROUPED_PROJECT), projectFlags), [projectRows, issuesF, outcomesF, projectFlags]);
  const projects = useMemo(() => projectList.active.map((p) => ({ name: p.name, count: p.items.length })), [projectList]);
  // The same rule the projects page uses: a directory becomes a project once it has tasks, outcomes, or a manual link.
  const projectOptions = useMemo(() => {
    const formal = new Set<string>(), other = new Set<string>();
    for (const p of projectList.active) (p.items.length > 0 || p.results.length > 0 || p.sessions.some((a) => !!a.project_override) ? formal : other).add(p.name);
    for (const n of formal) other.delete(n);
    return { formal: [...formal].filter(Boolean), other: [...other].filter(Boolean) };
  }, [projectList]);
  // Starred projects lead everywhere: workbench, board groups, table.
  const starredProjects = useMemo(() => new Set(projectList.active.filter((p) => isStarred(projectFlags, p.name)).map((p) => p.name)), [projectList, projectFlags]);

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
    if (!api || (view !== "list" && view !== "board" && view !== "home")) return;
    let alive = true;
    // Only the visible active tasks need recent progress; avoid fetching the whole archive. The list
    // is a new array on every 10-second reload, so each task's latest note is remembered under
    // `id + updated_at`: a task is asked for its comments again only when it actually changed.
    const active = (view === "home" ? issuesF : visible).filter((i) => i.status === "in_progress");
    Promise.all(active.map(async (i) => {
      const stamp = `${i.id}@${i.updated_at}@${i.comment_count ?? ""}`;
      const hit = progressCache.current.get(i.id);
      if (hit && hit.stamp === stamp) return [i.id, hit.text] as const;
      try { const notes = await api.comments(i.id); // 【验收】【待验收】… are the board's own records (they go to the Detail): the row shows the latest note a person reads.
      const latest = notes.sort((a, b) => b.created_at.localeCompare(a.created_at)).find((n) => !/^\s*【/.test(n.text)); const text = latest?.text ?? ""; progressCache.current.set(i.id, { stamp, text }); return [i.id, text] as const; }
      catch { return [i.id, hit?.text ?? ""] as const; }
    })).then((entries) => {
      if (!alive) return;
      const next = Object.fromEntries(entries);
      setProgress((old) => (Object.keys(old).length === Object.keys(next).length && Object.entries(next).every(([k, v]) => old[k] === v) ? old : next));
    });
    return () => { alive = false; };
  }, [api, view, visible, issuesF]);

  const inArchivedProject = useCallback((x: { cwd: string; project: string; project_override?: string }) => isArchived(projectFlags, resolveProject(x, known, settings.workspace_roots, flagDirs)), [projectFlags, known, settings.workspace_roots]);
  const inbox = useMemo<InboxItems>(() => { const unread = activityF.filter(a => a.unread && !a.scheduled && !a.archived && !inArchivedProject(a) && !(a.state === "working" && !a.stale)); return {
    unread,
    // Conversations working right now (transcript still moving), most recent first.
    running: activityF.filter(a => a.state === "working" && !a.stale && !a.scheduled && !a.archived && !inArchivedProject(a)).sort((a, b) => b.last_at - a.last_at),
    // Read replies of the last week, newest first: what was in 未读回复 and has been looked at.
    read: activityF.filter(a => a.reply_id && !a.unread && !a.scheduled && !a.archived && !inArchivedProject(a) && (a.reply_at ?? 0) > Date.now() / 1000 - 7 * 86400).sort((a, b) => b.last_at - a.last_at).slice(0, 60),
    waiting: presenceF.sessions.filter((s) => !s.daemon && needsAttention(s) && !s.scheduled && !inArchivedProject(s)).sort((a, b) => b.last_at - a.last_at),
    // A session already listed under 未读回复 is not also "idle": one row per session.
    idle: presenceF.sessions.filter((s) => !s.daemon && s.alive && s.state === "idle" && !needsAttention(s) && !s.scheduled && !unread.some((a) => a.session_id === s.session_id)),
    review: issuesF.filter((i) => needsReview(i)).sort((a, b) => (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at)),
    blocked: issuesF.filter((i) => i.status === "blocked"),
  }; }, [issuesF, presenceF, activityF, inArchivedProject]);

  const counts = useMemo(() => ({
    total: issuesF.length,
    open: issuesF.filter((i) => i.status !== "closed" && !isTrashed(i)).length,
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
        api.notify(t("{agent} 等待确认", { agent: x.agent === 'codex' ? 'Codex' : x.agent === 'zcode' ? 'ZCode' : x.agent === 'opencode' ? 'OpenCode' : x.agent === 'hermes' ? 'Hermes' : x.agent === 'gemini' ? 'Gemini CLI' : 'Claude Code' }), t("{title} · {host} · 请打开会话查看确认请求", { title: x.title || x.project || x.cwd, host: x.host_name || t('本机') })).catch(() => {});
      }
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [requestSignature, api, issuesLoaded, presenceLoaded, activityReady]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); say(label); await reload(); } catch (e) { say(String(e), true); }
  };

  const move = (id: string, to: Column) => {
    if (!api) return;
    const i = issues.find((x) => x.id === id);
    if (!i || columnOf(i) === to) return;
    const closed = i.status === "closed";
    if (to === "todo") return run(t("移到待办"), async () => { if (closed) await api.reopen(id); else await api.setStatus(id, "open"); });
    // Moving to 进行中 only changes status; the person viewing never becomes the assignee.
    if (to === "prog") return run(t("移到进行中"), async () => { if (closed) await api.reopen(id); await api.setStatus(id, "in_progress"); });
    if (to === "done") return run(t("标记完成"), async () => { if (!closed) await api.close(id, "在 Dispatch 里拖到已完成"); });
  };

  const create = async (input: NewIssue) => {
    if (!api) return;
    try { const i = await api.create(input); setCreating(false); say(t("已创建 {id}", { id: i?.id ?? "" })); await reload(); if (i?.id) setSelected(i.id); } catch (e) { say(String(e), true); }
  };

  const nextTheme = () => setTheme(theme === "" ? "dark" : theme === "dark" ? "light" : "");


  // The most recent conversation folder of a project: where a delegated agent should start.
  const dirOfProject = useCallback((name: string) => { if (projectFlags[name]?.dir) return projectFlags[name].dir!; const p = projectGroups(projectRows, issuesF, outcomesF).find((g) => g.name === name); const a = p?.sessions.find((x) => x.cwd && !isHome(x.cwd)); return a?.cwd ?? ""; }, [projectRows, issuesF, outcomesF, projectFlags]);
  // Where a project's new session starts: on its owner Mac, in its usual folder there.
  const projectTarget = (n: string, sessions = projectRows.filter((a) => conversationProject(a) === n)) => newSessionTarget(ownerHostId(projectOwners[n], hosts), projectHome(sessions), hostId);
  const newChatInProject = (n: string) => { const tg = projectTarget(n); openNewChat({ project: n, cwd: tg.initialCwd, host: tg.initialHost }); };
  // ⌘N, 页头「＋ 会话」 and ⌘K: on a project's page, or one of its sessions, the new session starts in that project.
  const shownSession = view === "sessions" && sessionShown ? projectRows.find((a) => a.session_id === sessionShown) : undefined;
  const hereProject = view === "projects" ? projectSelection : shownSession ? conversationProject(shownSession) : null;
  const newChatHere = () => { if (hereProject && hereProject !== UNGROUPED_PROJECT) newChatInProject(hereProject); else openNewChat(); };
  newChatHereRef.current = newChatHere;
  // 新建会话 v3's pickers: every active project with the Mac and folder it starts in, and a folder's project.
  const newChatProjects = useMemo(() => view !== "new-chat" ? [] : projectList.active.map((p) => { const tg = projectTarget(p.name, p.sessions); const o = projectOwners[p.name]; return { name: p.name, dir: tg.initialCwd || projectFlags[p.name]?.dir, host: tg.initialHost || undefined, owner: o ? { id: ownerHostId(o, hosts), name: o.host } : undefined }; }), [view, projectList, projectFlags, projectOwners, hosts, hostId]);  // eslint-disable-line react-hooks/exhaustive-deps
  const projectOfDir = useCallback((cwd: string) => resolveProject({ cwd, project: "" }, known, settings.workspace_roots, flagDirs), [known, settings.workspace_roots, flagDirs]);
  const recentForMention = useMemo(() => view !== "new-chat" ? [] : [...refs.values()].sort((a, b) => b.last_at - a.last_at).slice(0, 30).map((r) => ({ key: `${r.agent}:${r.session_id}`, title: r.title || r.session_id.slice(0, 8), summary: r.summary, resume: r.resume_cmd })), [view, refs]);
  const startAgent = async (i: AgentStartInput) => { const r = await api!.agentStart(i); say(r ? t("已在 {host} 起了 {kind}", { host: r.host, kind: r.kind }) : t("起 Agent 失败")); return r; };

  // Every conversation a row can stand for, by activity key, for the global right-click.
  const sessionByKey = useMemo(() => {
    const m = new Map<string, Activity>();
    const put = (a: Activity) => { if (!m.has(activityKey(a))) m.set(activityKey(a), a); };
    activityRows.forEach(put); projectRows.forEach(put);
    for (const r of refs.values()) put({ ...r, key: `${r.agent}:${r.session_id}`, tasks: Object.keys(r.tasks || {}), state: "unknown", stale: true, unread: false, activity: "", version: "", events: [], tracking_since: 0, source: "catalog" } as Activity);
    for (const x of observedPresence.sessions) put({ key: `${x.agent}:${x.session_id}`, agent: x.agent, session_id: x.session_id, cwd: x.cwd, project: x.project, title: x.title || x.cwd, last_at: x.last_at, state: x.state, activity: "", version: "", events: [], tasks: [], unread: false, stale: !x.alive, tracking_since: 0, source: "presence", scheduled: x.scheduled, host: x.host, host_name: x.host_name, remote: x.remote });
    return m;
  }, [activityRows, projectRows, refs, observedPresence]);
  // This Mac's usage windows per agent, shown in the title bar.
  // The header shows what this machine is spending (a shared subscription read on the other Mac
  // still counts); the other Macs' own quotas live on 统计与额度. A host filter shows that host's.
  const mine = (q: SharedQuota) => !!hostFilter || !localHostName || q.host_name === localHostName || !!q.also?.includes(localHostName);
  const quotaByAgent = useMemo(() => agents.filter(a => a.actor.kind !== "human").flatMap(a =>
    selectedQuotas.filter(q => q.agent === a.actor.id && q.windows.length && mine(q)).map(q => ({ agent: a, q }))), [agents, selectedQuotas, hostFilter, localHostName]);
  // What this page can do (right-click on empty space, and ⌘K's page section), then what every page can do.
  const pageItems: ViewMenuItem[] = [
    ...(BOARD_VIEWS.includes(view) ? [
      ...(["list", "board", "table"] as View[]).filter((v) => v !== view).map((v) => ({ label: v === "list" ? t("切到列表") : v === "board" ? t("切到看板") : t("切到表格"), icon: "tasks", onClick: () => setTaskView(v) })),
      { label: t("清除筛选"), icon: "filter", onClick: () => { setFilters(EMPTY_FILTERS); setQuery(""); }, disabled: !Object.values(filters).some(Boolean) && filters.project === null && !query },
      { label: t("回收站"), icon: "trash", onClick: () => setView("trash") },
      { label: t("已归档任务"), icon: "archive", onClick: () => setView("archive") },
      ...(archivable.length ? [{ label: t("归档 30 天前完成的（{n}）", { n: archivable.length }), icon: "archive", onClick: () => void archiveOld() }] : []),
    ] : []),
    ...(view === "trash" || view === "archive" ? [{ label: t("返回全部任务"), icon: "tasks", onClick: () => setView(lastTaskView()) }] : []),
    ...(view === "inbox" && inbox.unread.length > 0 ? [{ label: t("全部标记已读（{n}）", { n: inbox.unread.length }), icon: "check", onClick: async () => { for (const a of inbox.unread) if (a.reply_id) await markRead(a, a.reply_id); } }] : []),
    ...(view === "settings" ? [{ label: t("检查更新"), icon: "refresh", onClick: () => void checkUpdate() }] : []),
  ];
  const generalItems: ViewMenuItem[] = [
    { label: t("新建会话"), icon: "plus", hint: `${modKey()}N`, onClick: newChatHere },
    { label: t("新建任务"), icon: "tasks", hint: `${modKey()}T`, onClick: () => setCreating(true) },
    { label: t("刷新"), icon: "refresh", hint: `${modKey()}R`, onClick: () => void reload() },
    { label: t("搜索"), icon: "search", hint: `${modKey()}K`, onClick: () => setPanel(true) },
    { label: theme === "dark" ? t("切换为浅色主题") : theme === "light" ? t("跟随系统主题") : t("切换为深色主题"), icon: theme === "dark" ? "sun" : "moon", onClick: () => nextTheme() },
  ];
  const viewMenuItems: ViewMenuItem[] = [...pageItems, ...generalItems];

  // The noVNC page asks for a login: it is this Mac's account, which is the part new users miss.
  const screenLink = async () => { const h = hosts.find((x) => x.local); if (!h?.novnc || !api) { say(t("还没配置屏幕访问，设置页有说明"), true); return; } if (window.matchMedia("(max-width: 760px)").matches) { window.open(h.novnc, "_blank"); return; } try { await api.copy(h.novnc); say(t("屏幕链接已复制。手机先连上 Tailscale 再打开；页面要登录时，输入这台 Mac 的用户名（{user}）和开机密码", { user: h.ssh?.includes("@") ? h.ssh.split("@")[0] : t("登录这台电脑用的那个") })); } catch (e) { say(String(e), true); } };

  // A model-written summary, stored with the session's preferences; the row updates in place.
  // Unread cards ask for their "this turn" digest as soon as they render; one request per reply.
  const digestAsked = useRef(new Set<string>());
  const digestUnread = async (a: Activity) => {
    if (!api || !a.reply_id) return;
    const tag = `${activityKey(a)}|${a.reply_id}`;
    if (digestAsked.current.has(tag)) return;
    digestAsked.current.add(tag);
    try {
      const r = JSON.parse((await api.on(a.host || "local", ["session-summary", "unread", a.key, "--json"])).replace(/^[^{]*/, "")) as { unread_summary?: string; error?: string };
      if (r.error || !r.unread_summary) return;
      const patch = { unread_summary: r.unread_summary, unread_summary_reply: a.reply_id };
      setActivity((old) => ({ ...old, sessions: old.sessions.map((x) => activityKey(x) === activityKey(a) ? { ...x, ...patch } : x) }));
    } catch { /* the auto pass will fill it in later */ }
  };
  const summarizeSession = async (a: Activity) => {
    if (!api) return;
    try {
      const r = JSON.parse((await api.on(a.host || "local", ["session-summary", "run", a.key, "--json"])).replace(/^[^{]*/, "")) as { summary?: string; error?: string; cached?: boolean; provider?: string };
      if (r.error) { say(r.error, true); return; }
      const patch = { summary: r.summary };
      setActivity((old) => ({ ...old, sessions: old.sessions.map((x) => activityKey(x) === activityKey(a) ? { ...x, ...patch } : x) }));
      setRefs((old) => new Map([...old].map(([id, ref]) => [id, ref.session_id === a.session_id ? { ...ref, ...patch } : ref])));
      say(r.cached ? t("总结没变（会话没有新内容）") : t("已总结（{provider}）", { provider: r.provider ?? "" }));
    } catch (e) { say(String(e), true); }
  };



  const copyResume = async (agent: string, sessionId: string, cwd: string) => {
    if (!api) return;
    try { const cmd = await api.resumeCmd(agent, sessionId, cwd); await api.copy(cmd); say(t("恢复命令已复制，去终端粘贴回车")); } catch (e) { say(String(e), true); }
  };

  // ---- The window frame: header title and summary, the bottom bar, the ⌘K panel ----
  // ---- 在 VS Code / Cursor 里打开, shared by ⌘K and the right-click menus (a session's or project's folder on this Mac)
  const appInstalled = useExternalApps(api);
  const projectEditorRoot = (name: string): string | null => {
    if (!name || name === UNGROUPED_PROJECT) return null;
    const home = projectHome(projectRows.filter((a) => conversationProject(a) === name && !a.remote));
    return projectFolder(home?.cwd || projectFlags[name]?.dir);
  };
  const editorItems = (root: string | null): ViewMenuItem[] => {
    if (!root || !api || phone) return [];
    const ext = (app: "code" | "cursor", label: string): ViewMenuItem => {
      const installed = appInstalled(root, app);
      return { label, icon: "external", sub: installed === false ? t("没装") : tildePath(root), disabled: installed === false,
        onClick: () => void openInApp(api, root, app).catch((e) => say(String(e instanceof Error ? e.message : e), true)) };
    };
    return [ext("code", t("在 VS Code 里打开")), ext("cursor", t("在 Cursor 里打开"))];
  };
  const headTitle = view === "projects" && projectSelection ? projectLabel(projectFlags, projectSelection) : t(VIEW_LABEL[view]);
  // The page header holds three things at most (DESIGN.md 页头): back, the title with its project chip, the page's main button.
  // Counts and states live in the page itself; a page's one-line note is the content's first line (.page-note).
  const headSubtitle = shellHeader?.subtitle;
  const headChips = shellHeader?.title ? (shellHeader.chips ?? []) : [BOARD_VIEWS.includes(view) && filters.project !== null ? (filters.project || t("未分项目")) : "", hostFilter].filter(Boolean);
  // Sidebar 额度 line: per agent the most used window on this Mac (or the chosen host).
  const quotaBrief = useMemo<QuotaBrief[]>(() => quotaByAgent.map(({ agent: a, q }) => ({ key: `${a.actor.id}:${q.host_name}`, glyph: a.actor.glyph, used: Math.max(0, ...q.windows.map((w) => w.used_percent ?? 0)),
    title: `${a.actor.name} · ${[q.host_name, ...(q.also ?? [])].join(" + ")} · ${q.windows.map((w) => `${w.label} ${w.used_percent === null ? "?" : Math.round(w.used_percent) + "%"}`).join(" · ")}` })), [quotaByAgent]);
  // The selected thing the bottom bar and ⌘K act on: what the page published, else the open task,
  // conversation or project.
  const resolvedTarget = useMemo<ResolvedTarget | null>(() => {
    const tg = shellTarget;
    if (tg?.kind === "task") { const i = issues.find((x) => x.id === tg.id); return i ? { kind: "task", issue: i, primary: tg.primary ?? { label: t("打开任务"), run: () => setSelected(i.id) } } : null; }
    if (tg?.kind === "session") { const a = sessionByKey.get(tg.key); return a ? { kind: "session", a, primary: tg.primary ?? { label: t("查看并回复"), run: () => openSession(a.session_id) } } : null; }
    if (tg?.kind === "project") return { kind: "project", name: tg.name, primary: tg.primary ?? { label: t("进入项目"), run: () => openProject(tg.name) } };
    if (selected) { const i = issues.find((x) => x.id === selected); if (i) return { kind: "task", issue: i }; }
    if (view === "sessions" && sessionShown) { const a = [...sessionByKey.values()].find((x) => x.session_id === sessionShown); if (a) return { kind: "session", a }; }
    if (view === "projects" && projectSelection) return { kind: "project", name: projectSelection };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellTarget, issues, sessionByKey, selected, view, sessionShown, projectSelection, locale]);
  const primary = resolvedTarget?.primary;
  const pages: [View, string, string][] = [["home", "home", "工作台"], ["projects", "folder", "项目"], ["inbox", "inbox", "等我"], ["sessions", "chat", "会话"], ["discuss", "discuss", "讨论"], ["board", "tasks", "全部任务"], ["graph", "graph", "脉络"], ["agents", "agent", "Agent 状态"], ["stats", "chart", "统计与额度"], ["skills", "star", "技能"], ["rules", "doc", "规则与资料"], ["pitfalls", "book", "知识库"], ["settings", "gear", "设置"], ["overview", "grid", "总览"]];
  const targetProject = resolvedTarget?.kind === "task" ? projectOf(resolvedTarget.issue) : resolvedTarget?.kind === "session" ? conversationProject(resolvedTarget.a) : "";
  const panelSections: PanelSection[] = [
    { title: t(VIEW_LABEL[view]), items: pageItems },
    { title: t("导航"), items: [
      ...(targetProject && targetProject !== UNGROUPED_PROJECT ? [{ label: t("转到项目"), icon: "folder", sub: targetProject, onClick: () => openProject(targetProject) }] : []),
      generalItems[0], generalItems[1],
      { label: t("讨论一个念头"), icon: "discuss", onClick: () => setDiscuss({}) },
      ...(hosts.find((x) => x.local)?.novnc ? [{ label: t("看这台电脑的屏幕"), icon: "eye", onClick: () => void screenLink() }] : []),
    ] },
    { title: "Dispatch", items: [
      generalItems[generalItems.length - 1],
      { label: t("刷新任务板"), icon: "refresh", hint: `${modKey()}R`, onClick: () => void reload() },
      { label: t("导览：这个软件怎么用"), icon: "help", onClick: () => setTour(true) },
      ...(update?.newer && !update.error ? [{ label: t("有新版本 v{v}，点开设置更新", { v: update.latest }), icon: "up", onClick: () => setView("settings") }] : []),
    ] },
    // Only while typing: every page by name, so "设置" + ↵ goes there.
    { title: t("页面"), searchOnly: true, items: pages.map(([v, icon, label]) => ({ label: t("转到{page}", { page: t(label) }), icon, onClick: () => (v === "board" ? allTasks() : setView(v)) })) },
  ];
  // The bottom bar's left side: the last message (say), else the board read failure, else the status line.
  const noBoard = !!err && /no beads database|没找到命令 bd|无法启动 bd|Cannot start bd|bd kann nicht|任务板还没建/i.test(err);
  const errFirst = err ? (err.split("\n").find((l) => l.trim()) ?? err).replace(/^Error:\s*/, "") : "";
  const barMessage = toast ? (
    <div className={`bar-toast${toast.err ? " is-err" : " is-ok"}`} role={toast.err ? "alert" : "status"}>
      <i /><span className="msg" title={toast.text}>{toast.text}</span>
      {toast.undo && <button className="lk" onClick={() => { const u = toast.undo; setToast(null); u?.(); }}>{t("撤销")}</button>}
      {toast.err && <><button className="lk" onClick={() => setToast(null)}>{t("关闭")}</button><Kbd>esc</Kbd></>}
    </div>
  ) : err ? (
    <div className={`bar-toast${noBoard ? " is-soft" : " is-err"}`} role="alert">
      <i /><span className="msg sel-text" title={err.slice(0, 1000)}>{noBoard ? t("任务板还没建好，任务相关的页面是空的；会话、技能、规则照常可用。") : errFirst.slice(0, 300)}</span>
      {!noBoard && <><button className="lk" onClick={() => void reload()}>{t("重试")}</button><Shortcut k="R" /></>}
      {!noBoard && err.length > errFirst.length + 1 && <button className="lk" onClick={() => setErrDetail((d) => !d)}>{t("原始错误")}</button>}
      <button className="lk" onClick={() => { setErr(null); setErrDetail(false); }}>{t("关闭")}</button><Kbd>esc</Kbd>
    </div>
  ) : null;

  // 迁到另一台 (project page ⋯ menu and the project right-click menu): preview on the Mac the folder is
  // on, confirm, then run it there in the background; the project shows the bar until it ends.
  const moveProject = async (name: string, cwd: string, fromHost: string, to: Host) => {
    if (!api) return;
    const run = async (extra: string[]) => { const out = await api.on(fromHost, ["project", cwd, "--move-to", to.name, "--json", ...extra]); return JSON.parse(out.slice(Math.max(0, out.indexOf("{")))); };
    setMigrationCheck(null);
    say(t("正在预检：把 {name} 交给 {host} 会改什么…", { name, host: to.name }));
    try {
      const p = await run(["--dry-run"]);
      if (p.error) { say(String(p.error), true); return; }
      const conflicts: string[] = p.git?.conflicts ?? [];
      if (conflicts.length) { setToast(null); setMigrationCheck({ project: name, host: fromHost, cwd: p.cwd || cwd, target: to.name, remoteCwd: p.remote_cwd || "", conflicts }); return; }
      const f = p.files ?? {}; const sessions: { title: string; state: string }[] = p.sessions ?? [];
      const lines = [t("把项目 {name} 整个交给 {host}：{cwd}", { name, host: to.name, cwd: p.remote_cwd }),
        t("文件：同步 {n} 个", { n: f.send ?? 0 }) + (f.delete ? t("、删除 {n} 个（这边已删）", { n: f.delete }) : "") + (f.skipped?.length ? t("；构建产物不搬：{list}", { list: f.skipped.join(t("、")) }) : ""),
        p.git?.history ? t("Git 历史用 git push 过去，那边的 stash 保留") : "",
        sessions.length ? t("这边开着的 {n} 个会话会直接关掉（正在跑的也关），在 {host} 上接着跑：{list}", { n: sessions.length, host: to.name, list: sessions.map((x) => `${x.title || t("未命名")}·${x.state === "working" ? t("正在跑") : t("空闲")}`).join(t("、")) }) : t("这边没有开着的会话"),
        p.new_session ? t("迁完在 {host} 的项目目录里新开一个 {kind} 会话", { host: to.name, kind: p.new_session }) : "",
        p.history?.count ? t("其余 {n} 段历史会话（{mb} MB）的记录也搬过去，Dispatch 里都显示在 {host}", { n: p.history.count, mb: p.history.mb, host: to.name }) : "",
        t("以后这个项目归那台，新建会话默认开在那边。")].filter(Boolean);
      if (!await confirmAction(lines.join("\n"))) { say(t("已取消迁移")); return; }
      // The move runs as a background worker on the source Mac: this window can go anywhere
      // (or be closed) meanwhile; the project shows the bar until it ends.
      const r = await run(["--background"]);
      if (r.error) { say(String(r.error), true); return; }
      say(t("已开始把 {name} 交给 {host}，进度在项目上显示；切到别的页面也会继续", { name, host: to.name }));
      setMoveJobs((jobs) => [r as MoveJob, ...jobs.filter((j) => j.id !== r.id)]);
      moveHost.current = fromHost;
      void pollMoves();
    } catch (e) { say(String(e), true); }
  };
  // The right-click menu's targets: the same rule as the project page (projectPlace).
  const projectMove = (name: string) => {
    const term = projectPlace({ project: { name, sessions: projectRows.filter((a) => conversationProject(a) === name) }, flags: projectFlags, owners: projectOwners, hosts, home: homeHere, canMove: true });
    return { term, targets: term.moveTargets.map((h) => ({ id: h.id, name: h.name, online: h.local || !!h.online })), busy: moveJobs.some((j) => j.project === name && j.state === "running") };
  };

  return (
    <ShellProvider setHeader={setShellHeader} setTarget={setShellTarget}><SessionActions api={api} notify={say}><AssignProjectProvider value={{
      projects: Array.from(new Set([...projects.map(p=>p.name),...activity.sessions.map(a=>a.project_override||a.project)])).filter(n=>n&&n!==UNGROUPED_PROJECT),
      task: async (i, name) => { if (!api) return; await api.labels(i.id, [`project:${name}`], (i.labels??[]).filter(l=>l.startsWith("project:"))); await reload(); say(t("已分配到 {name}", { name })); },
      conversation: async (a, name) => { if (!api) return; await api.on(a.host||"local", ["session-preferences", a.key, JSON.stringify({ project_override: name }), "--json"]); setActivity(old=>({...old,sessions:old.sessions.map(x=>activityKey(x)===activityKey(a)?{...x,project_override:name,project:name}:x)})); say(t("已分配到 {name}", { name })); },
    }}><ConversationActions api={api} projects={Array.from(new Set([...projects.map(p=>p.name),...activity.sessions.map(a=>a.project_override||a.project)])).filter(Boolean)} onSaved={(a,c)=>{const patch=<T extends {title:string}>(r:T):T=>({...r,...c,...(c.title_override?{title:c.title_override}:{})});setRefs(old=>new Map([...old].map(([id,r])=>[id,r.session_id===a.session_id?patch(r):r])));setActivity(old=>({...old,sessions:old.sessions.map(x=>activityKey(x)===activityKey(a)?patch(x):x)}));say(c.title_override!==undefined?(c.title_override?t('已改名为「{title}」',{title:c.title_override}):t('已恢复自动标题')):c.scheduled===true?t('已归入定时会话，默认隐藏'):c.scheduled===false?t('已恢复普通会话'):c.starred===true?t('已收藏：追踪中，不会自动归档'):c.starred===false?t('已取消收藏'):c.archived===true?t('已归档，会话页「已归档」可找回'):c.archived===false?t('已取消归档'):t('项目关联已保存'));}} archiveDays={archiveDays} actions={{ editorItems: (a) => editorItems(sessionFolder(a)), onOpen: openSession, onRead: (a) => markRead(a, a.reply_id!), onUnread: markUnread, onResume: (a) => void copyResume(a.agent, a.session_id, a.cwd), onSummarize: summarizeSession, hosts, onDeleted: (a) => { setActivity(old=>({...old,sessions:old.sessions.filter(x=>activityKey(x)!==activityKey(a))})); if (!a.remote) setRefs(old=>new Map([...old].filter(([,r])=>r.session_id!==a.session_id))); say(t("已删除会话，记录在废纸篓里")); }, onCloseChat: async (a, quiet) => {
      // 关掉后台会话: chatd ends the process and drops it from chatd.json; the row stops saying 后台 now, not at the next poll.
      if (!api?.chatAvailable) return;
      try {
        await closeChat(api, `${a.agent}:${a.session_id}`);
        setActivity(old=>({...old,sessions:old.sessions.map(x=>activityKey(x)===activityKey(a)?{...x,runner:"",chat_lifecycle:undefined,state:x.state==="working"?"idle":x.state}:x)}));
        if (!quiet) say(t("已关掉，后台不再留着这个会话"));
      } catch (e) { const m = e instanceof Error ? e.message : String(e); say(t("没关掉：{err}", { err: m }), true); if (quiet) throw e; }
    }, onMove: async (a, hostId, hostName) => {
        const run = async (extra: string[]) => JSON.parse((await api!.on("local", ["move", a.session_id, "--to", hostId, "--json", ...extra])).replace(/^[^{]*/, ""));
        setMigrationCheck(null);
        say(t("正在预检：{host} 上的 Git 状态、要改哪些文件…", { host: hostName }));
        try {
          // Preflight first: what the hand-over would change or refuse, before anything moves.
          const p = await run(["--dry-run"]);
          if (p.error) { say(String(p.error), true); return; }
          const conflicts: string[] = p.git?.conflicts ?? [];
          if (conflicts.length) { setToast(null); setMigrationCheck({ project: p.project || conversationProject(a), host: "local", cwd: p.cwd || a.cwd, target: hostName, remoteCwd: p.remote_cwd || "", conflicts }); return; }
          const f = p.files;
          const others: { title: string; state: string }[] = p.others_here ?? [];
          const lines = [t("把会话和项目 {project} 交给 {host}：{cwd}", { project: p.project, host: hostName, cwd: p.remote_cwd }),
            f ? t("文件：同步 {n} 个", { n: f.send }) + (f.delete ? t("、删除 {n} 个（这边已删）", { n: f.delete }) : "") + (f.skipped?.length ? t("；构建产物不搬：{list}", { list: f.skipped.join(t("、")) }) : "") : t("不同步文件"),
            p.git?.history ? t("Git 历史用 git push 过去，那边的 stash 保留") : "",
            p.already_there ? t("{host} 上已经在跑这个会话，不会再开一份", { host: hostName }) : "",
            others.length ? t("⚠ 这边还有 {n} 个会话在这个项目里（{list}），它们会继续改这边的文件", { n: others.length, list: others.map((o) => `${o.title || t("未命名")}·${o.state}`).join(t("、")) }) : "",
            t("这边的原会话会直接关掉（正在跑的也关），在那边接着跑；项目以后归那台，新建会话默认开在那边。")].filter(Boolean);
          if (!await confirmAction(lines.join("\n"))) { say(t("已取消迁移")); return; }
          say(t("正在把项目交给 {host}…", { host: hostName }));
          const r = await run([]);
          if (r.error) { say(String(r.error), true); return; }
          const v = r.git?.verify;
          const original: Record<string, string> = { stopped: t("这边的原会话已停掉"), working: t("这边的原会话还在跑，跑完关掉它"), self: t("这边的原会话就是发起迁移的，说完这轮关掉"), failed: t("这边的原会话没停下，手动关掉"), "not-running": "", kept: "" };
          say([t("已交给 {host}：{cwd}", { host: hostName, cwd: r.remote_cwd }), v?.checked ? (v.head_match && v.dirty_match ? t("Git 两边一致") : t("Git 没对上，去 {host} 看 git status", { host: hostName })) : "", original[r.original?.state] ?? "",
            others.length ? t("这边还有 {n} 个会话在改这个项目", { n: others.length }) : "", r.owner?.error ? t("项目归属更新失败：{error}", { error: r.owner.error }) : ""].filter(Boolean).join(t("；")), !!r.owner?.error || !!(v?.checked && !(v.head_match && v.dirty_match)));
          api!.memories().then((m) => setProjectOwners(parseProjectOwners(m))).catch(() => {});
        } catch (e) { say(String(e), true); }
      } }}><ProjectActions starred={(n) => isStarred(projectFlags, n)} archived={(n) => isArchived(projectFlags, n)} onFlag={setProjectFlag} onProject={openProject} onNew={newChatInProject} onTasks={(n) => { setFilters({ ...EMPTY_FILTERS, project: n === UNGROUPED_PROJECT ? "" : n }); setQuery(""); setView(lastTaskView()); }} editorItems={(n) => editorItems(projectEditorRoot(n))} moveTargets={api ? projectMove : undefined} onMove={(n, to) => { const m = projectMove(n); const h = hosts.find((x) => x.id === to.id); if (m.term.cwd && h) void moveProject(n, m.term.cwd, m.term.host, h); }}><ViewMenu items={viewMenuItems}><ItemMenus><TaskActions api={api} onOpen={setSelected} onDelegate={(id) => setDelegate({ task: id })} onDone={(m,id)=>{say(m);if(id===selected)setSelected(null);void reload();}} onError={m=>say(m,true)}><div className={`app${solo ? " solo" : ""}`}>
      <Sidebar info={info} view={view} setView={setView} inbox={counts.inbox} agents={agents} filters={filters} setFilters={setFilters} hosts={hosts} hostFilter={hostFilter} setHostFilter={(h) => { setHostFilter(h); setSelected(null); }} onAllTasks={allTasks} quota={quotaBrief} onQuota={() => setView("quota")} />
      <div className="shell">
      <header className="hd">
        <button className="back" disabled={!backTarget && !backStack.length} onClick={backTarget ? goBackPlace : goBack} title={backTarget ? t("返回{label}", { label: backLabel(backTarget) }) : backStack.length ? t("返回{label}", { label: t(VIEW_LABEL[backStack[backStack.length - 1].view]) }) : t("返回上一页（按你刚才的路径倒退一步）")} aria-label={t("返回")}><Icon name="left" /></button>
        <div className={`ttl${shellHeader?.title || (view === "projects" && projectSelection) ? " own" : ""}`}><b>{shellHeader?.title ?? headTitle}</b>{headChips.map((c) => <span key={c} className="hd-chip">{c}</span>)}</div>
        <span className="sp" />
        {shellHeader?.actions}
      </header>

      <div className={`body${selected ? " with-detail" : ""}`}>
        <main className="main">
          {headSubtitle && <p className="page-note">{headSubtitle}</p>}
          <div className={`toolbar${TASK_VIEWS.includes(view) ? " tasks" : " bare"}`}>
            {backStack.length > 0 && previousView && <button className="btn sm mobile-context-back" onClick={goBack}>‹ {t(VIEW_LABEL[previousView])}</button>}
            <h2>{t(VIEW_LABEL[view])}{BOARD_VIEWS.includes(view) && filters.project !== null && <span className="muted"> · {filters.project || t("未分项目")}</span>}</h2>
            {hosts.length > 1 && <select className="mobile-host-filter" aria-label={t("选择机器")} value={hostFilter} onChange={e => { setHostFilter(e.target.value); setSelected(null); }}><option value="">{t("全部机器")}</option>{hosts.map(h => <option key={h.id} value={h.name}>{h.name}</option>)}</select>}
            {TASK_VIEWS.includes(view) && <TaskTabs view={view} onView={setTaskView} query={query} onQuery={setQuery} searchRef={searchRef} sort={boardSort} onSort={changeBoardSort} filters={filters} onFilters={setFilters} onClear={() => { setFilters(EMPTY_FILTERS); setQuery(""); }} counts={{ review: counts.review, blocked: counts.blocked, trash: hostIssues.filter(isTrashed).length, archive: hostIssues.filter(isArchivedTask).length, shown: visible.length }} />}
          </div>
          <section className="view" ref={viewEl} onScroll={(e) => { scrollMemo.current[scrollKeyRef.current] = e.currentTarget.scrollTop; }}>
            {view === "home" && api && <HomeView onDiscuss={() => setDiscuss({})} me={me} loaded={activity.updated_at>0} connectionError={activityError} unavailable={activity.unavailable_hosts} rows={projectRows} issues={issuesF} outcomes={outcomesF} inbox={inbox} progress={progress} flags={projectFlags} onFlag={setProjectFlag} archiveDays={archiveDays} expandedDefault={settings.home_expanded} onOpen={openSession} onFocus={openSession} onTask={setSelected} onProject={openProject} onView={(v)=>{ if (v==="board") allTasks(); else setView(v); }} onNew={a=>{const p=a?conversationProject(a):null;const tg=newSessionTarget(ownerHostId(p?projectOwners[p]:undefined,hosts),a,hostId);openNewChat({project:p,cwd:tg.initialCwd,host:tg.initialHost});}} onLocate={locateProject} onScreen={screenLink} screenReady={!!hosts.find((x) => x.local)?.novnc_up} selectedTask={selected} onDigest={digestUnread} />}
            {view === "projects" && api && <ProjectHub onSay={say} moveJobs={moveJobs} onDiscuss={(name) => setDiscuss({ project: name })} focusSection={hubSection} onSectionDone={() => setHubSection(null)} archiveDays={archiveDays} flags={projectFlags} onFlag={setProjectFlag} connectionError={activityError} unavailable={activity.unavailable_hosts} rows={projectRows} tasks={issuesF} outcomes={outcomesF} api={api} me={me} selected={projectSelection} onProject={setProjectSelection} onOpen={openSession} onTask={setSelected} onRead={a=>markRead(a,a.reply_id!)} onSummarize={summarizeSession} onReload={reload} onNew={a=>{const tg=newSessionTarget(ownerHostId(projectSelection?projectOwners[projectSelection]:undefined,hosts),a,hostId);openNewChat({project:projectSelection,cwd:tg.initialCwd,host:tg.initialHost});}} workspaceRoots={settings.workspace_roots} onCreated={(name, dir, start) => { void reload(); openProject(name); if (start) openNewChat({ project: name, cwd: dir, host: "local" }); }} loaded={activity.updated_at>0} hosts={hosts} owners={projectOwners}
              onMoveProject={moveProject} />}
            {view === "graph" && api && <ThreadView api={api} me={me} version={version} selected={selected} onSelect={setSelected} onOpenSession={openSession} currentProject={filters.project} />}
            {view === "inbox" && <InboxView onSummarize={summarizeSession} onDigest={digestUnread} onRead={a => markRead(a, a.reply_id!)} onOpen={openSession} initialTab={inboxTab} items={inbox} me={me} taskTitle={(id) => issues.find((i) => i.id === id)?.title} onSelect={setSelected} onFocus={openSession} selectedTask={selected} />}
            {view === "list" && <ListView sort={boardSort} starred={starredProjects} issues={visible} selected={selected} onSelect={setSelected} me={me} />}
            {view === "board" && <Board sort={boardSort} starred={starredProjects} progress={progress} issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} onMove={move} onAdd={() => setCreating(true)} />}
            {view === "table" && <TableView starred={starredProjects} issues={visible} selected={selected} onSelect={setSelected} me={me} rootOf={rootIssue} />}
            {view === "agents" && <AgentsView agents={agents} scheduled={scheduledSessions} apps={presenceF.apps} issues={issuesF} me={me} onSelect={(id) => { setSelected(id); }} onFocus={openSession} refs={refsF} hosts={hosts} onOpenUrl={(u) => api?.openPath(u).catch((e) => say(String(e), true))} onCopyText={(text, what) => api?.copy(text).then(() => say(what.endsWith("。") ? what : t("{what}已复制", { what }))).catch((e) => say(String(e), true))} onDelegate={(h) => setDelegate({ host: h.id })} />}
            {view === "discuss" && api && <DiscussView api={api} me={me} issues={issuesF} initialTask={discussFocus} onShown={setDiscussShown} onNew={() => setDiscuss({})} onOpened={(id, intent) => { setDetailWf(intent); setSelected(id); }} onDelegate={(tid, prompt, leader) => setDelegate({ task: tid, prompt, kind: leader?.kind, model: leader?.model })} onDone={say} onError={(m) => say(m, true)} />}
            {view === "sessions" && api && <SessionsView archivedProjects={new Set(projectList.archived.map((p) => p.name))} refs={[...refsF.values()]} scriptCount={scriptCount} refsLoaded={refs.size > 0 || activity.updated_at > 0 || refsTried} archiveDays={archiveDays} outcomes={outcomesF} activities={activityF} issues={issuesF} onSeen={markRead} activityError={activityError} key={(sessionFocus ?? "all") + hostId} api={api} me={me} live={presenceF.sessions} hostId={hostId} onSelectTask={setSelected} onSelected={setSessionShown} onDone={say} onError={(m) => say(m, true)} initialId={sessionFocus ?? (info?.initial_task?.startsWith("session:") ? info.initial_task.slice(8) : null)} onBack={previousView ? { label: t(VIEW_LABEL[previousView]), go: goBack } : undefined} localHostName={hosts.find(h => h.local)?.name} onProject={openProject} solo={solo} hosts={hosts} offlineHosts={hosts.filter(h => !h.local && !h.online).map(h => ({ id: h.id, name: h.name }))} />}
            {view === "new-chat" && api && <NewChat key={JSON.stringify(newChatCtx)} api={api} worktree={settings.new_worktree} onWorktree={setWorktree} hosts={hosts} issues={issuesF} projects={newChatProjects} projectOfDir={projectOfDir} sessions={recentForMention} initial={newChatCtx ?? undefined}
              onBack={leaveNewChat}
              onStarted={async (sid, host, agent, project) => { if (project && project !== UNGROUPED_PROJECT) { try { await api.on(host, ["session-preferences", `${agent}:${sid}`, JSON.stringify({ project_override: project }), "--json"]); } catch (e) { say(t("会话已创建，项目关联失败：{error}", { error: String(e) }), true); } } setHostFilter(hosts.find(h => host === (h.local ? "local" : h.id))?.name || ""); openSession(sid); }}
              onOtherFolder={(ctx) => setDelegate({ host: ctx.host === "local" ? undefined : ctx.host, cwd: ctx.cwd })}
              onComputer={(host) => { setHostFilter(hosts.find(h => host === (h.local ? "local" : h.id))?.name || ""); setView("agents"); }} />}
            {view === "archive" && <><p className="trash-note">{t("归档的已完成任务：不进已完成列、不计入数量，记录和依赖都在。右键或点击 ⋯ 可取消归档。")}</p><TableView issues={hostIssues.filter(isArchivedTask)} selected={selected} onSelect={setSelected} me={me}/></>}
            {view === "trash" && <><p className="trash-note">{t("移除的任务保留记录与依赖，不会进入待办队列。右键或点击 ⋯ 可恢复。")}</p><TableView issues={hostIssues.filter(isTrashed)} selected={selected} onSelect={setSelected} me={me}/></>}
            {(view === "stats" || view === "quota") && api && <UsageView quota={{ rows: quota, busy: quotaBusy, error: quotaError, refresh: refreshQuota }} key={view} initialTab={view === "quota" ? "quota" : undefined} onDone={say} onStart={startAgent} onDelegate={(prompt, label) => setDelegate({ host: hostId && hostId !== "local" ? hostId : undefined, prompt, label })} onOpenSession={openSession} api={api} me={me} host={hostId} hostName={hostFilter} onError={(m) => say(m, true)} />}
            {view === "skills" && api && <SkillsView hostId={hostId} api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "rules" && api && <RulesView hostId={hostId} api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "settings" && <SettingsView onDone={say} onError={(m) => say(m, true)} hostId={hostId} onTestNotify={testNotify} onScreen={screenLink} screenReady={!!hosts.find((x) => x.local)?.novnc_up} screen={(() => { const h = hosts.find((x) => x.local); return { url: h?.novnc ?? "", up: !!h?.novnc_up, sharing: !!h?.screen_sharing, issue: h?.novnc_issue ?? "" }; })()} update={update} onCheckUpdate={checkUpdate} settings={settings} onSave={saveSettings} theme={theme} onTheme={setTheme} api={api ?? undefined} hosts={hosts} onRenameHost={api ? renameHost : undefined} onDeleteHost={api ? deleteHost : undefined} onRedetectHost={api ? redetectHost : undefined} />}
            {view === "overview" && <OverviewView stats={{ projects: projects.filter((p) => p.name).length, inbox: counts.inbox, sessions: projectRows.length, running: runningSessions, tasks: issuesF.length, open: issuesF.filter((i) => i.status !== "closed").length, agentsOnline: agents.filter((a) => a.online).length, agentsTotal: agents.length, skills: skillCount, wiki: wikiCount, hosts: Math.max(1, hosts.length), rulesSynced: null, version: update?.current ?? "" }} onGo={(v) => (v === "board" ? allTasks() : setView(v))} onTour={() => setTour(true)} />}
            {view === "env" && api && <EnvView hostId={hostId} api={api} hosts={hosts} onDone={say} onError={(m) => say(m, true)} />}
            {view === "pitfalls" && api && <PitfallsView api={api} projects={projects.map((p) => p.name).filter(Boolean)} version={version} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
          </section>
        </main>
        {selected && api && (
          <Detail rows={projectRows} onOpenSession={openSession} onDiscuss={(tid) => setDiscuss({ task: tid })} initialWf={detailWf} key={selected} id={selected} api={api} me={me} root={rootIssue(selected) ?? null} initial={issues.find((i) => i.id === selected) ?? null} stamp={issues.find((i) => i.id === selected)?.updated_at ?? String(version)} live={presence.sessions} onClose={() => setSelected(null)} onSelect={setSelected} onError={(m) => say(m, true)} onDone={(m) => { say(m); reload(); }} />
        )}
      </div>

      <footer className={`bar${barMessage ? " has-toast" : ""}`}>
        {barMessage ?? (
          <button className="status" onClick={() => setView("agents")} title={info ? `${info.bd_bin} · ${info.version}` : t("查看 Agent 状态")}>
            <span className={`dotc${activityError ? " wait" : lastSync ? "" : " off"}`} />
            <span>{lastSync ? t("同步 {time}", { time: lastSync.toLocaleTimeString(intlLocale(), { hour12: false }) }) : t("连接中…")}{isServed ? t(" · 网页连接") : t(" · 示例数据")}</span>
            {activityError && <><span className="sepd">·</span><span className="warn">{t("会话同步失败，稍后重试")}</span></>}
          </button>
        )}
        {update?.newer && !update.error && !barMessage && <button className="act quiet" onClick={() => setView("settings")} title={t("有新版本 v{v}，点开设置更新", { v: update.latest })}><Icon name="up" size={14} />v{update.latest}</button>}
        <span className="sp" />
        {primary && <><button className="act" onClick={primary.run}>{primary.label}<Kbd>↵</Kbd></button><span className="vsep" /></>}
        <button className="act" onClick={() => setPanel((p) => !p)} aria-expanded={panel}>{t("操作")}<Shortcut k="K" /></button>
      </footer>
      {errDetail && err && <div className="bar-pop" role="dialog" aria-label={t("原始错误")}><pre className="sel-text">{err.slice(0, 4000)}</pre><button className="btn sm" onClick={() => setErrDetail(false)}>{t("关闭")}</button></div>}
      </div>

      <MobileNav view={view} setView={(v) => { if (BOARD_VIEWS.includes(v)) allTasks(); else setView(v); }} badge={counts.inbox} />
      {tour && <Tour onClose={closeTour} onGo={(v) => setView(v)} />}
      {discuss && api && <DiscussDialog api={api} me={me} issues={issuesF} projects={projects.map((p) => p.name).filter(Boolean)} initialProject={discuss.project} initialTask={discuss.task} onClose={() => { setDiscuss(null); void reload(); }} onOpened={(id, intent) => { setDetailWf(intent); setSelected(id); }} onDelegate={(tid, prompt, leader) => setDelegate({ task: tid, prompt, kind: leader?.kind, model: leader?.model })} onAll={openDiscussion} onDone={say} onError={(m) => say(m, true)} />}
      {delegate && api && <Delegate api={api} hosts={hosts} initialHost={delegate.host} initialCwd={delegate.cwd} initialTask={delegate.task} initialPrompt={delegate.prompt} initialLabel={delegate.label} initialKind={delegate.kind} initialModel={delegate.model} issues={issuesF} me={me} dirOfProject={dirOfProject} onClose={() => { setDelegate(null); void reload(); }} onStart={startAgent} onShowSessions={(name) => { setDelegate(null); setHostFilter(name); setSessionFocus(null); navigateContext("sessions"); void reload(); }} />}
      {panel && <PanelHost target={resolvedTarget} sections={panelSections} projects={projects.map((p) => p.name)} rows={projectRows} issues={issuesF} me={me} archiveDays={archiveDays} onProject={openProject} onSession={openSession} onTask={(id) => setSelected(id)} onClose={() => setPanel(false)} />}
      {creating && <NewTask projects={projectOptions.formal} otherProjects={projectOptions.other} defaultProject={filters.project} onCancel={() => setCreating(false)} onCreate={create} />}
      {migrationCheck && <div className="toast err" role="alert" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        <div>{t("没有迁移，{host} 那边会丢东西：{list}", { host: migrationCheck.target, list: migrationCheck.conflicts.join(t("；")) })}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="btn" style={{ color: 'var(--text)' }} onClick={() => {
          setDelegate({ host: hosts.find(h => (h.local ? 'local' : h.id) === migrationCheck.host)?.id || migrationCheck.host, cwd: migrationCheck.cwd, prompt: migrationCheckPrompt(migrationCheck), label: t("迁移检查 · {project}", { project: migrationCheck.project }), ...(() => { const kind = firstInstalled(['pi', 'claude', 'codex']); return { kind, model: kind === 'pi' ? 'glm-5.3-flash' : '' }; })() });
          setMigrationCheck(null);
        }}>{t("启动 Agent 检查")}</button><button className="btn" style={{ color: 'var(--text)' }} onClick={() => setMigrationCheck(null)}>{t("关闭")}</button></div>
      </div>}
      {webUpdate && <button className="toast web-update" onClick={() => window.location.reload()}>{t("网页版已更新到 v{v} · 点这里刷新", { v: webUpdate })}</button>}
      <GlobalContextMenu issues={issues} sessions={sessionByKey} />
    </div></TaskActions></ItemMenus></ViewMenu></ProjectActions></ConversationActions></AssignProjectProvider></SessionActions></ShellProvider>
  );
}

type ResolvedTarget = ({ kind: "task"; issue: Issue } | { kind: "session"; a: Activity } | { kind: "project"; name: string }) & { primary?: PrimaryAction };

// Lives inside the action providers (TaskActions, ConversationActions, ProjectActions): the ⌘K panel's
// first section is the right-click menu of the selected thing.
function PanelHost({ target, sections, ...rest }: { target: ResolvedTarget | null; sections: PanelSection[] } & Omit<Parameters<typeof ActionPanel>[0], "sections">) {
  const taskItems = useTaskActionItems();
  const sessionItems = useConversationActionItems();
  const projectItems = useProjectActionItems();
  const items = !target ? [] : target.kind === "task" ? taskItems(target.issue) : target.kind === "session" ? sessionItems(target.a) : projectItems(target.name);
  const title = !target ? "" : target.kind === "task" ? target.issue.title : target.kind === "session" ? target.a.title : target.name;
  const first: PanelSection[] = target ? [{ title, items: items.filter((x): x is ViewMenuItem => x !== "-") }] : [];
  return <ActionPanel sections={[...first, ...sections]} {...rest} />;
}
