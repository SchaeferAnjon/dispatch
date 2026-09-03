import type { AgentPresence } from "../derive";
import { projectColor } from "../derive";
import type { Info, View } from "../types";
import { Avatar } from "./ui";

export interface Filters { project: string | null; mine: boolean; urgent: boolean; agent: string | null; blocked: boolean; review: boolean }

interface Props {
  info: Info | null;
  view: View;
  setView: (v: View) => void;
  counts: { total: number; blocked: number; review: number; agents: number; inbox: number };
  projects: { name: string; count: number }[];
  agents: AgentPresence[];
  filters: Filters;
  setFilters: (f: Filters) => void;
}

// Three groups, one job each: 任务 (what to do), Agent (who is doing it), 知识 (what everyone should know).
export function Sidebar({ info, view, setView, counts, projects, agents, filters, setFilters }: Props) {
  const go = (v: View) => { setView(v); setFilters({ ...filters, blocked: false, review: false }); };
  const item = (v: View, icon: string, label: string, right?: React.ReactNode) => (
    <a className={view === v ? "on" : ""} onClick={() => go(v)}>
      <span className="ic">{icon}</span>{label}{right}
    </a>
  );
  const taskView = view === "board" || view === "table";
  return (
    <aside className="side">
      <div className={`ws link${view === "home" ? " on" : ""}`} onClick={() => go("home")} role="button" tabIndex={0} title="总览">
        <div className="glyph">bd</div>
        <div style={{ minWidth: 0 }}>
          <div className="name">全局板</div>
          <div className="path" title={info?.beads_dir}>{info?.beads_dir?.replace(/^\/Users\/[^/]+/, "~") ?? "…"}</div>
        </div>
      </div>

      <nav className="nav">
        <div className="h">任务</div>
        {item("home", "⌂", "总览")}
        {item("inbox", "◎", "等你", counts.inbox > 0 ? <span className="badge">{counts.inbox}</span> : <span className="n">0</span>)}
        <a className={taskView ? "on" : ""} onClick={() => go(view === "table" ? "table" : "board")}>
          <span className="ic">▦</span>全部任务<span className="n">{counts.total}</span>
        </a>
        <div className="sub">
          <div className="h">项目{filters.project !== null && <button className="n" onClick={() => setFilters({ ...filters, project: null })}>清除</button>}</div>
          {projects.length === 0 && <a className="muted" style={{ cursor: "default" }}>用 label <span className="mono">project:名字</span> 归类</a>}
          {projects.map((p) => (
            <a key={p.name || "_"} className={filters.project === p.name ? "on" : ""} onClick={() => { if (!taskView) setView("board"); setFilters({ ...filters, project: filters.project === p.name ? null : p.name, blocked: false, review: false }); }}>
              <span className="proj" style={{ background: projectColor(p.name) }} />{p.name || "未分项目"}<span className="n">{p.count}</span>
            </a>
          ))}
        </div>
      </nav>

      <nav className="nav">
        <div className="h">Agent<span className="n">{agents.filter((a) => a.online).length}/{agents.length} 在线</span></div>
        {item("agents", "◉", "Agents")}
        {item("sessions", "◷", "会话")}
        <div className="agents sub">
          {agents.map((a) => (
            <button key={a.actor.id} className={`agent${a.online ? "" : " off"}`} onClick={() => { setView("table"); setFilters({ ...filters, agent: filters.agent === a.actor.id ? null : a.actor.id }); }} title={`按 ${a.actor.name} 筛选任务`}>
              <Avatar actor={a.actor} online={a.online} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{a.actor.name}{a.sessions.length > 0 && <small>{a.sessions.length} 会话{a.sessions.some((s) => s.state === "working") ? ` · ${a.sessions.filter((s) => s.state === "working").length} 在跑` : ""}</small>}</div>
                <div className="cur">
                  {a.current[0] ? <><span className="id">{a.current[0].id}</span> {a.current[0].title}</> : a.sessions.length ? a.bySource.map((b) => `${b.label} ${b.count}`).join(" · ") : a.actor.kind === "human" ? "" : a.online ? "空闲" : a.lastActive ? "离线" : "还没来过"}
                </div>
              </div>
            </button>
          ))}
        </div>
      </nav>

      <nav className="nav">
        <div className="h">知识</div>
        {item("skills", "✦", "技能")}
        {item("rules", "§", "规则")}
        {item("pitfalls", "⚠", "踩坑")}
      </nav>
    </aside>
  );
}
