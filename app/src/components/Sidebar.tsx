import type { AgentPresence } from "../derive";
import { projectColor } from "../derive";
import type { Info, View } from "../types";
import { Avatar } from "./ui";
import { Icon } from "./icons";

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

// The sidebar is the map. Three groups, each answering one question; the
// current place is marked by a colour bar, counts stay quiet unless they are
// asking for you (等你 turns red).
export function Sidebar({ info, view, setView, counts, projects, agents, filters, setFilters }: Props) {
  const go = (v: View) => { setView(v); setFilters({ ...filters, blocked: false, review: false }); };
  const item = (v: View, icon: string, label: string, right?: React.ReactNode, active?: boolean) => (
    <a className={(active ?? view === v) ? "on" : ""} onClick={() => go(v)}>
      <span className="ic"><Icon name={icon} /></span>{label}{right}
    </a>
  );
  const taskView = view === "board" || view === "table";
  return (
    <aside className="side">
      <div className={`ws link${view === "home" ? " on" : ""}`} onClick={() => go("home")} role="button" tabIndex={0}>
        <div className="glyph">bd</div>
        <div style={{ minWidth: 0 }}>
          <div className="name">全局板</div>
          <div className="path" title={info?.beads_dir}>{info?.beads_dir?.replace(/^\/Users\/[^/]+/, "~") ?? "…"}</div>
        </div>
      </div>

      <nav className="nav">
        {item("home", "home", "总览")}
        {item("inbox", "inbox", "等你", counts.inbox > 0 ? <span className="badge">{counts.inbox}</span> : <span className="n">0</span>)}
      </nav>

      <nav className="nav">
        <div className="h">任务</div>
        {item("board", "board", "全部任务", <span className="n">{counts.total}</span>, taskView)}
        {item("graph", "graph", "脉络")}
        {item("projects", "project", "项目", <span className="n">{projects.filter((p) => p.name).length}</span>)}
        {item("folders", "folder", "文件夹")}
        {filters.project !== null && taskView && (
          <a className="filter-row" onClick={() => setFilters({ ...filters, project: null })} title="点击清除筛选">
            <span className="proj" style={{ background: projectColor(filters.project) }} />只看 {filters.project || "未分项目"}<span className="n">✕</span>
          </a>
        )}
      </nav>

      <nav className="nav">
        <div className="h">Agent<span className="n">{agents.filter((a) => a.online).length}/{agents.length} 在线</span></div>
        {item("sessions", "chat", "聊天记录")}
        {item("agents", "agent", "Agent 状态")}
        {item("stats", "chart", "统计")}
        <div className="agents sub">
          {agents.map((a) => (
            <button key={a.actor.id} className={`agent${a.online ? "" : " off"}`} onClick={() => { setView("table"); setFilters({ ...filters, agent: filters.agent === a.actor.id ? null : a.actor.id }); }} title={`只看 ${a.actor.name} 的任务`}>
              <Avatar actor={a.actor} online={a.online} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{a.actor.name}{a.sessions.length > 0 && <small>{a.sessions.length} 窗口{a.sessions.some((s) => s.state === "working") ? ` · ${a.sessions.filter((s) => s.state === "working").length} 在跑` : ""}</small>}</div>
                <div className="cur">
                  {a.current[0] ? <><span className="id">{a.current[0].id}</span> {a.current[0].title}</> : a.sessions.length ? a.bySource.map((b) => `${b.label} ${b.count}`).join(" · ") : a.online ? "空闲" : a.lastActive ? "离线" : "还没来过"}
                </div>
              </div>
            </button>
          ))}
        </div>
      </nav>

      <nav className="nav">
        <div className="h">知识</div>
        {item("skills", "skill", "技能")}
        {item("rules", "rule", "规则")}
        {item("pitfalls", "pit", "踩坑")}
      </nav>
    </aside>
  );
}
