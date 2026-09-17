import type { AgentPresence } from "../derive";
import { projectColor } from "../derive";
import type { Info, View } from "../types";
import { Avatar } from "./ui";
import { Icon } from "./icons";
import appIcon from "../assets/icon.png";
import { useT } from "../i18n";


export interface Filters { project: string | null; mine: boolean; urgent: boolean; agent: string | null; blocked: boolean; review: boolean }

interface Props {
  info: Info | null;
  view: View;
  setView: (v: View) => void;
  counts: { total: number; open: number; blocked: number; review: number; agents: number; inbox: number };
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
  const t = useT();
  const go = (v: View) => { setView(v); setFilters({ ...filters, blocked: false, review: false }); };
  const item = (v: View, icon: string, label: string, right?: React.ReactNode, active?: boolean, title?: string) => (
    <a role="button" tabIndex={0} title={title} className={(active ?? view === v) ? "on" : ""} onClick={() => v === "board" ? onAllTasks() : go(v)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); v === "board" ? onAllTasks() : go(v); } }}>
      <span className="ic"><Icon name={icon} /></span>{label}{right}
    </a>
  );
  const taskView = view === "board" || view === "table";
  return (
    <aside className="side">
      <button className="ws" title={t("Dispatch 有哪些页面、各自干什么")} onClick={onOverview}>
        <img className="glyph app" src={appIcon} alt="" />
        <div style={{ minWidth: 0 }}>
          <div className="name">Dispatch <span className="muted">{t("调度台")}</span></div>
          <div className="path" title={info?.beads_dir}>{t("任务板 {path}", { path: info?.beads_dir?.replace(/^\/Users\/[^/]+/, "~") ?? "…" })}</div>
        </div>
      </button>
      {hosts.length > 1 && setHostFilter && (
        <div className="hostsw side-hosts" title={t("看哪台机器：任务、会话、额度、统计都只看它；「全部」合并两台")} onClick={(e) => e.stopPropagation()}>
          <button className={hostFilter === "" ? "on" : ""} onClick={() => setHostFilter("")}>{t("全部")}</button>
          {hosts.map((h) => <button key={h.id} className={hostFilter === h.name ? "on" : ""} onClick={() => setHostFilter(h.name)} title={`${h.name} · ${h.online ? (h.local ? t("这台电脑") : t("在线")) : t("离线")}`}><span className={`dot${h.online ? " on" : ""}`} /><span className="host-short">{h.name}</span></button>)}
        </div>
      )}

      <nav className="nav">
        {item("home", "home", t("工作台"))}
        {item("projects", "project", t("项目"), <span className="n">{projects.filter((p) => p.name).length}</span>, undefined, t("{n} 个项目和目录（有会话或任务的）", { n: projects.filter((p) => p.name).length }))}
        {item("inbox", "inbox", t("等我"), counts.inbox > 0 ? <span className="badge">{counts.inbox}</span> : <span className="n">0</span>)}
        {item("sessions", "chat", t("会话"))}
        {item("discuss", "discuss", t("讨论"))}
      </nav>

      <nav className="nav">
        <div className="h">{t("任务")}</div>
        {item("board", "board", t("全部任务"), <span className="n">{counts.open}</span>, taskView, t("{open} 项未完成，共 {total} 条任务", { open: counts.open, total: counts.total }))}
        {item("graph", "graph", t("脉络"))}
        {filters.project !== null && taskView && (
          <a className="filter-row" onClick={() => setFilters({ ...filters, project: null })} title={t("点击清除筛选")}>
            <span className="proj" style={{ background: projectColor(filters.project) }} />{t("只看 {name}", { name: filters.project || t("未分项目") })}<span className="n">✕</span>
          </a>
        )}
      </nav>

      <nav className="nav">
        <div className="h">Agent<span className="n">{t("{on}/{all} 在线", { on: agents.filter((a) => a.online).length, all: agents.length })}</span></div>
        {item("agents", "agent", t("Agent 状态"))}
        {item("stats", "chart", t("统计与额度"), undefined, view === "stats" || view === "quota")}
        <div className="agents sub">
          {agents.filter((a) => a.online).map((a) => (
            <button key={a.actor.id} className="agent" onClick={() => { onAllTasks(); setView("table"); setFilters({ project: null, mine: false, urgent: false, blocked: false, review: false, agent: a.actor.id }); }} title={t("只看 {name} 的任务", { name: a.actor.name })}>
              <Avatar actor={a.actor} online={a.online} />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{a.actor.name}{a.sessions.length > 0 && <small>{a.sessions.some((s) => s.state === "working") ? t("{n} 进行中", { n: a.sessions.filter((s) => s.state === "working").length }) : a.current[0] ? t("认领了任务，会话空闲") : t("会话空闲")}</small>}{a.sessions.length === 0 && a.current[0] && <small>{t("认领了任务，没在跑")}</small>}</div>
                <div className="cur" title={a.current[0] ? t("它名下进行中的任务") : undefined}>
                  {a.current[0] ? <><span className="id">{a.current[0].id}</span> {a.current[0].title}</> : a.sessions.length ? a.bySource.map((b) => `${b.label} ${b.count}`).join(" · ") : a.online ? t("空闲") : a.lastActive ? t("离线") : t("还没来过")}
                </div>
              </div>
            </button>
          ))}
        </div>
      </nav>

      <nav className="nav">
        <div className="h">{t("知识")}</div>
        {item("skills", "skill", t("技能"))}
        {item("rules", "rule", t("规则与资料"))}
        {item("pitfalls", "pit", t("知识库"))}
        {item("settings", "gear", t("设置"))}
        {item("overview", "home", t("总览"), undefined, undefined, t("每个页面是干什么的、怎么用；点左上角 Logo 也能到"))}
      </nav>
    </aside>
  );
}
