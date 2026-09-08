import type { AgentPresence } from "../derive";
import { projectColor } from "../derive";
import type { Info, View } from "../types";
import { Avatar } from "./ui";
import { Icon } from "./icons";
import appIcon from "../assets/icon.png";

// "Apple的Mac mini" → "Apple": the first word is enough on a narrow switch; the title carries the rest.
const shortHost = (name: string) => (name.length > 6 ? (name.split(/的|\s+|'s/)[0] || name).slice(0, 8) : name);

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
  onAllTasks: () => void;
  onOverview?: () => void;
  hosts?: { id: string; name: string; online: boolean; local: boolean }[];
  hostFilter?: string;
  setHostFilter?: (name: string) => void;
}

// The sidebar is the map. Three groups, each answering one question; the
// current place is marked by a colour bar, counts stay quiet unless they are
// asking for you (等你 turns red).
export function Sidebar({ info, view, setView, counts, projects, agents, filters, setFilters, onAllTasks, onOverview, hosts = [], hostFilter = "", setHostFilter }: Props) {
  const go = (v: View) => { setView(v); setFilters({ ...filters, blocked: false, review: false }); };
  const item = (v: View, icon: string, label: string, right?: React.ReactNode, active?: boolean) => (
    <a role="button" tabIndex={0} className={(active ?? view === v) ? "on" : ""} onClick={() => v === "board" ? onAllTasks() : go(v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); v === "board" ? onAllTasks() : go(v); } }}>
      <span className="ic"><Icon name={icon} /></span>{label}{right}
    </a>
  );
  const taskView = view === "board" || view === "table";
  return (
    <aside className="side">
      <button className="ws" title="Dispatch 有哪些页面、各自干什么" onClick={onOverview}>
        <img className="glyph app" src={appIcon} alt="" />
        <div style={{ minWidth: 0 }}>
          <div className="name">Dispatch <span className="muted">调度台</span></div>
          <div className="path" title={info?.beads_dir}>任务板 {info?.beads_dir?.replace(/^\/Users\/[^/]+/, "~") ?? "…"}</div>
        </div>
      </button>
      {hosts.length > 1 && setHostFilter && (
        <div className="hostsw side-hosts" title="看哪台机器：任务、会话、额度、统计都只看它；「全部」合并两台" onClick={(e) => e.stopPropagation()}>
          <button className={hostFilter === "" ? "on" : ""} onClick={() => setHostFilter("")}>全部</button>
          {hosts.map((h) => <button key={h.id} className={hostFilter === h.name ? "on" : ""} onClick={() => setHostFilter(h.name)} title={`${h.name} · ${h.online ? (h.local ? "这台电脑" : "在线") : "离线"}`}><span className={`dot${h.online ? " on" : ""}`} /><span className="host-short">{shortHost(h.name)}</span></button>)}
        </div>
      )}

      <nav className="nav">
        {item("home", "home", "工作台")}
        {item("projects", "project", "项目", <span className="n">{projects.filter((p) => p.name).length}</span>)}
        {item("inbox", "inbox", "等我", counts.inbox > 0 ? <span className="badge">{counts.inbox}</span> : <span className="n">0</span>)}
        {item("sessions", "chat", "会话")}
      </nav>

      <nav className="nav">
        <div className="h">任务</div>
        {item("board", "board", "全部任务", <span className="n">{counts.total}</span>, taskView)}
        {item("graph", "graph", "脉络")}
        {filters.project !== null && taskView && (
          <a className="filter-row" onClick={() => setFilters({ ...filters, project: null })} title="点击清除筛选">
            <span className="proj" style={{ background: projectColor(filters.project) }} />只看 {filters.project || "未分项目"}<span className="n">✕</span>
          </a>
        )}
      </nav>

      <nav className="nav">
        <div className="h">Agent<span className="n">{agents.filter((a) => a.online).length}/{agents.length} 在线</span></div>
        {item("agents", "agent", "Agent 状态")}
        {item("stats", "chart", "统计与额度", undefined, view === "stats" || view === "quota")}
        <div className="agents sub">
          {agents.filter((a) => a.online).map((a) => (
            <button key={a.actor.id} className="agent" onClick={() => { onAllTasks(); setView("table"); setFilters({ project: null, mine: false, urgent: false, blocked: false, review: false, agent: a.actor.id }); }} title={`只看 ${a.actor.name} 的任务`}>
              <Avatar actor={a.actor} online={a.online} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{a.actor.name}{a.sessions.length > 0 && <small>{a.sessions.some((s) => s.state === "working") ? `${a.sessions.filter((s) => s.state === "working").length} 进行中` : "暂无执行"}</small>}</div>
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
        {item("rules", "rule", "规则与资料")}
        {item("pitfalls", "pit", "知识库")}
        {item("settings", "gear", "设置")}
      </nav>
    </aside>
  );
}
