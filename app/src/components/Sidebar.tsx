import type { AgentPresence } from "../derive";
import { projectColor } from "../derive";
import type { Info, View } from "../types";
import { Avatar } from "./ui";

export interface Filters { project: string | null; mine: boolean; urgent: boolean; agent: string | null; blocked: boolean; review: boolean }

interface Props {
  info: Info | null;
  view: View;
  setView: (v: View) => void;
  counts: { total: number; blocked: number; review: number; agents: number };
  projects: { name: string; count: number }[];
  agents: AgentPresence[];
  filters: Filters;
  setFilters: (f: Filters) => void;
}

export function Sidebar({ info, view, setView, counts, projects, agents, filters, setFilters }: Props) {
  const nav = (v: View, icon: string, label: string, n?: number, extra?: Partial<Filters>) => (
    <a className={view === v && !filters.blocked && !filters.review && !extra ? "on" : ""} onClick={() => { setView(v); setFilters({ ...filters, blocked: false, review: false, ...(extra ?? {}) }); }}>
      <span className="ic">{icon}</span>{label}{n !== undefined && <span className="n">{n}</span>}
    </a>
  );
  return (
    <aside className="side">
      <div className="ws">
        <div className="glyph">bd</div>
        <div style={{ minWidth: 0 }}>
          <div className="name">全局板</div>
          <div className="path" title={info?.beads_dir}>{info?.beads_dir?.replace(/^\/Users\/[^/]+/, "~") ?? "…"}</div>
        </div>
      </div>
      <nav className="nav">
        <div className="h">视图</div>
        {nav("board", "▦", "看板", counts.total)}
        {nav("table", "☰", "表格")}
        {nav("agents", "◉", "Agents", counts.agents)}
        {nav("sessions", "◷", "会话记录")}
        {nav("skills", "✦", "技能")}
        {nav("pitfalls", "⚠", "踩坑记录")}
        <a className={filters.blocked ? "on" : ""} onClick={() => { setView("table"); setFilters({ ...filters, blocked: !filters.blocked, review: false }); }}>
          <span className="ic">⊘</span>阻塞中<span className="n">{counts.blocked}</span>
        </a>
        <a className={filters.review ? "on" : ""} onClick={() => { setView("table"); setFilters({ ...filters, review: !filters.review, blocked: false }); }}>
          <span className="ic">✓</span>待审核<span className="n">{counts.review}</span>
        </a>
      </nav>
      <nav className="nav">
        <div className="h">项目{filters.project && <button className="n" onClick={() => setFilters({ ...filters, project: null })}>清除</button>}</div>
        {projects.length === 0 && <a className="muted" style={{ cursor: "default" }}>用 label <span className="mono">project:名字</span> 归类</a>}
        {projects.map((p) => (
          <a key={p.name || "_"} className={filters.project === p.name ? "on" : ""} onClick={() => setFilters({ ...filters, project: filters.project === p.name ? null : p.name })}>
            <span className="proj" style={{ background: projectColor(p.name) }} />{p.name || "未分项目"}<span className="n">{p.count}</span>
          </a>
        ))}
      </nav>
      <div className="nav">
        <div className="h">Agent 在线<span className="n">{agents.filter((a) => a.online).length}/{agents.length}</span></div>
        <div className="agents">
          {agents.map((a) => (
            <button key={a.actor.id} className={`agent${a.online ? "" : " off"}`} onClick={() => { setView("table"); setFilters({ ...filters, agent: filters.agent === a.actor.id ? null : a.actor.id }); }} title={`按 ${a.actor.name} 筛选`}>
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
      </div>
    </aside>
  );
}
