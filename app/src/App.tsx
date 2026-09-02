import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi, isTauri, type Api } from "./api";
import { Detail } from "./components/Detail";
import { NewTask } from "./components/NewTask";
import { Sidebar, type Filters } from "./components/Sidebar";
import { AgentsView, Board, TableView } from "./components/views";
import { PitfallsView } from "./components/Pitfalls";
import { agentsFrom, columnOf, isReviewed, projectOf } from "./derive";
import type { Column, Info, Issue, NewIssue, Presence, View } from "./types";

type Theme = "light" | "dark" | "";
const VIEW_LABEL: Record<View, string> = { board: "看板", table: "表格", agents: "Agents", pitfalls: "踩坑记录" };
const VIEWS: View[] = ["board", "table", "agents", "pitfalls"];

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [presence, setPresence] = useState<Presence>({ sessions: [], apps: [] });
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [view, setView] = useState<View>("board");
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ project: null, mine: false, urgent: false, agent: null, blocked: false, review: false });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
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
        if (inf.initial_task) setSelected(inf.initial_task);
      } catch (e) { setErr(String(e)); }
      await reload(a);
      off = await a.onChange(() => reload(a));
    })();
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!api) return;
    const t = window.setInterval(() => reload(), 20_000);
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

  const agents = useMemo(() => agentsFrom(issues, me, presence.sessions), [issues, me, presence]);
  const liveSessions = presence.sessions.filter((s) => s.alive).length;
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

  const counts = useMemo(() => ({
    total: issues.filter((i) => i.status !== "closed").length,
    blocked: issues.filter((i) => i.status === "blocked").length,
    review: issues.filter((i) => i.status === "closed" && !isReviewed(i)).length,
    agents: agents.filter((a) => a.online).length,
  }), [issues, agents]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); say(label); await reload(); } catch (e) { say(String(e), true); }
  };

  const move = (id: string, to: Column) => {
    if (!api) return;
    const i = issues.find((x) => x.id === id);
    if (!i || columnOf(i) === to) return;
    const closed = i.status === "closed";
    if (to === "todo") return run("移到待办", async () => { if (closed) await api.reopen(id); else await api.setStatus(id, "open"); });
    if (to === "prog") return run("认领并开始", async () => { if (closed) await api.reopen(id); await api.claim(id); });
    if (to === "done") return run("标记完成", async () => { if (closed) await api.labels(id, [], ["reviewed"]); else await api.close(id, "在 Dispatch 里拖到已完成"); });
    if (to === "reviewed") return run("审核通过", async () => { if (!closed) await api.close(id, "在 Dispatch 里拖到已审核"); await api.labels(id, ["reviewed"], []); });
  };

  const create = async (input: NewIssue) => {
    if (!api) return;
    try { const i = await api.create(input); setCreating(false); say(`已创建 ${i?.id ?? ""}`); await reload(); if (i?.id) setSelected(i.id); } catch (e) { say(String(e), true); }
  };

  const nextTheme = () => setTheme(theme === "" ? "dark" : theme === "dark" ? "light" : "");

  const copyResume = async (agent: string, sessionId: string, cwd: string) => {
    if (!api) return;
    try { const cmd = await api.resumeCmd(agent, sessionId, cwd); await api.copy(cmd); say("恢复命令已复制，去终端粘贴回车"); } catch (e) { say(String(e), true); }
  };

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="lead" data-tauri-drag-region><b>Dispatch</b><span className="muted">调度台</span></div>
        <div className="crumb" data-tauri-drag-region>
          <b>全局板</b><span className="sep">›</span><span>{VIEW_LABEL[view]}</span>
          {filters.project !== null && <><span className="sep">›</span><span>{filters.project || "未分项目"}</span></>}
          <span className="sync" title={info ? `${info.bd_bin} · ${info.version}` : ""}>{lastSync ? `同步 ${lastSync.toLocaleTimeString("zh-CN", { hour12: false })}` : "连接中…"}{!isTauri && " · 浏览器预览"}</span>
        </div>
        <div className="tb-right">
          <label className="search">🔍<input ref={searchRef} placeholder="搜任务、ID、Agent…" value={query} onChange={(e) => setQuery(e.target.value)} /><kbd>⌘K</kbd></label>
          <button className="btn ghost" onClick={nextTheme} title="切换主题">{theme === "dark" ? "☾" : theme === "light" ? "☼" : "◐"}</button>
          <button className="btn ghost" onClick={() => setView("agents")} title="在线 Agent / 会话数"><span className="pulse" />{counts.agents} 在线 · {liveSessions} 会话</button>
          <button className="btn primary" onClick={() => setCreating(true)}>＋ 新任务</button>
        </div>
      </div>

      <div className={`body${selected ? " with-detail" : ""}`}>
        <Sidebar info={info} view={view} setView={setView} counts={counts} projects={projects} agents={agents} filters={filters} setFilters={setFilters} />
        <main className="main">
          <div className="toolbar">
            <h2>{VIEW_LABEL[view]}</h2>
            <div className="views">
              {VIEWS.map((v) => <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{VIEW_LABEL[v]}</button>)}
            </div>
            <span className="spacer" />
            {view !== "agents" && view !== "pitfalls" && (<>
              <button className={`chip${filters.project === null && !filters.agent && !filters.blocked && !filters.review ? " on" : ""}`} onClick={() => setFilters({ ...filters, project: null, agent: null, blocked: false, review: false })}>全部</button>
              <button className={`chip${filters.mine ? " on" : ""}`} onClick={() => setFilters({ ...filters, mine: !filters.mine })}>只看我的</button>
              <button className={`chip${filters.urgent ? " on" : ""}`} onClick={() => setFilters({ ...filters, urgent: !filters.urgent })}>P0–P1</button>
              {filters.agent && <button className="chip on" onClick={() => setFilters({ ...filters, agent: null })}>{filters.agent} ✕</button>}
              <span className="muted mono" style={{ fontSize: 11 }}>{visible.length} 项</span>
            </>)}
          </div>
          {err && <div className="err">{err}</div>}
          <section className="view">
            {view === "board" && <Board issues={visible} selected={selected} onSelect={setSelected} me={me} onMove={move} onAdd={() => setCreating(true)} />}
            {view === "table" && <TableView issues={visible} selected={selected} onSelect={setSelected} me={me} />}
            {view === "agents" && <AgentsView agents={agents} apps={presence.apps} onSelect={(id) => { setSelected(id); }} onCopyResume={copyResume} />}
            {view === "pitfalls" && api && <PitfallsView api={api} projects={projects.map((p) => p.name).filter(Boolean)} version={version} onSelectTask={setSelected} onDone={say} onError={(m) => say(m, true)} />}
          </section>
        </main>
        {selected && api && (
          <Detail id={selected} api={api} me={me} initial={issues.find((i) => i.id === selected) ?? null} stamp={issues.find((i) => i.id === selected)?.updated_at ?? String(version)} live={presence.sessions} onClose={() => setSelected(null)} onSelect={setSelected} onError={(m) => say(m, true)} onDone={(m) => { say(m); reload(); }} />
        )}
      </div>

      {creating && <NewTask projects={projects.map((p) => p.name).filter(Boolean)} defaultProject={filters.project} onCancel={() => setCreating(false)} onCreate={create} />}
      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.text}</div>}
    </div>
  );
}
