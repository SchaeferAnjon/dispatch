import { useEffect, useState } from "react";
import type { AgentPresence } from "../derive";
import type { Info, View } from "../types";
import { Avatar } from "./ui";
import { Icon } from "./icons";
import appIcon from "../assets/icon.png";
import { useT } from "../i18n";
import { tildePath } from "../activity";
import "../rail.css";


export interface Filters { project: string | null; mine: boolean; urgent: boolean; agent: string | null; blocked: boolean; review: boolean }

/** One agent's quota for the rail's 额度 line: a letter and the most used window, in percent. */
export type QuotaBrief = { key: string; glyph: string; used: number; title: string };

type Page = { v: View; icon: string; label: string; also?: View[] };
// The rail, like ChatGPT's and Codex's: the pages used every day as icons, the rest behind ⋯.
export const PRIMARY: Page[] = [
  { v: "home", icon: "home", label: "工作台" },
  { v: "projects", icon: "folder", label: "项目" },
  { v: "inbox", icon: "inbox", label: "等我" },
  { v: "sessions", icon: "chat", label: "会话" },
  { v: "board", icon: "tasks", label: "全部任务", also: ["list", "table", "archive", "trash"] },
];
export const MORE: Page[] = [
  { v: "discuss", icon: "discuss", label: "讨论" },
  { v: "graph", icon: "graph", label: "脉络" },
  { v: "agents", icon: "screen", label: "Agent 状态" },
  { v: "stats", icon: "chart", label: "统计与额度", also: ["quota"] },
  { v: "skills", icon: "star", label: "技能" },
  { v: "rules", icon: "doc", label: "规则与资料" },
  { v: "pitfalls", icon: "book", label: "知识库" },
  { v: "overview", icon: "grid", label: "总览" },
];
const isOn = (p: Page, view: View) => p.v === view || !!p.also?.includes(view);

interface Props {
  info: Info | null;
  view: View;
  setView: (v: View) => void;
  inbox: number;
  agents: AgentPresence[];
  filters: Filters;
  setFilters: (f: Filters) => void;
  onAllTasks: () => void;
  hosts?: { id: string; name: string; online: boolean; local: boolean }[];
  hostFilter?: string;
  setHostFilter?: (name: string) => void;
  quota?: QuotaBrief[];
  onQuota?: () => void;
}

// A 52px column of icons at the far left of every window. Each icon names its page on hover; the
// page's own list sits to the right. Settings and the status button (which Mac, who is online,
// quota) are pinned at the bottom.
export function Sidebar({ info, view, setView, inbox, agents, filters, setFilters, onAllTasks, hosts = [], hostFilter = "", setHostFilter, quota = [], onQuota }: Props) {
  const t = useT();
  const [open, setOpen] = useState<"more" | "status" | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  const go = (v: View) => { setOpen(null); if (v === "board") { onAllTasks(); return; } setView(v); setFilters({ ...filters, blocked: false, review: false }); };
  const btn = (p: Page, badge?: number) => {
    const on = isOn(p, view);
    // Something waiting is an 8px dot with a ping; the count is in the name on hover.
    const name = badge ? `${t(p.label)} · ${badge > 99 ? "99+" : badge}` : t(p.label);
    return <button key={p.v} type="button" className={`rail-btn${on ? " on" : ""}`} data-tip={name} aria-label={name} aria-current={on ? "page" : undefined} onClick={() => go(p.v)}>
      <Icon name={p.icon} size={16} />{badge ? <span className="rail-badge" /> : null}
    </button>;
  };
  const online = agents.filter((a) => a.online);
  const top = quota.length ? Math.max(...quota.map((q) => q.used)) : 0;
  const heat = top >= 90 ? "crit" : top >= 70 ? "hot" : "";
  const moreOn = MORE.some((p) => isOn(p, view));
  return (
    <aside className="rail">
      <div className="rail-drag" />
      <button type="button" className="rail-logo" data-tip={t("总览")} aria-label={t("总览")} onClick={() => go("overview")}><img src={appIcon} alt="" /></button>
      {open && <div className="rail-shade" onClick={() => setOpen(null)} />}
      <nav className="rail-nav">
        {PRIMARY.map((p) => btn(p, p.v === "inbox" ? inbox : undefined))}
        <div className="rail-anchor">
          <button type="button" className={`rail-btn${moreOn ? " on" : ""}${open === "more" ? " open" : ""}`} data-tip={t("更多页面")} aria-label={t("更多页面")} aria-expanded={open === "more"} onClick={() => setOpen(open === "more" ? null : "more")}><Icon name="more" size={16} /></button>
          {open === "more" && <div className="rail-pop rail-more" role="menu">
            {MORE.map((p) => <button key={p.v} type="button" role="menuitem" className={isOn(p, view) ? "on" : ""} onClick={() => go(p.v)}><Icon name={p.icon} size={15} /><span>{t(p.label)}</span></button>)}
          </div>}
        </div>
      </nav>
      <span className="rail-sp" />
      <div className="rail-nav">
        {btn({ v: "settings", icon: "gear", label: "设置" })}
        <div className="rail-anchor">
          <button type="button" className={`rail-btn rail-status${open === "status" ? " open" : ""}`} data-tip={t("机器、在线 Agent、额度")} aria-label={t("机器、在线 Agent、额度")} aria-expanded={open === "status"} onClick={() => setOpen(open === "status" ? null : "status")}>
            {hostFilter ? <span className="rail-host">{hostFilter.slice(0, 1).toUpperCase()}</span> : <Icon name="screen" size={16} />}
            <i className={online.length ? "" : "off"} />
            {quota.length > 0 && <span className="rail-meter"><b className={heat} style={{ width: `${Math.min(100, top)}%` }} /></span>}
          </button>
          {open === "status" && <div className="rail-pop rail-stat" role="dialog" aria-label={t("机器、在线 Agent、额度")}>
            <div className="rs-ws"><b>Dispatch</b><span className="mono" title={info?.beads_dir}>{info?.beads_dir ? tildePath(info.beads_dir) : "…"}</span></div>
            {hosts.length > 1 && setHostFilter && <>
              <div className="rs-h" title={t("看哪台机器：任务、会话、额度、统计都只看它；「全部」合并两台")}>{t("看哪台机器")}</div>
              <div className="hosts">
                <button className={hostFilter === "" ? "on" : ""} onClick={() => setHostFilter("")}>{t("全部")}</button>
                {hosts.map((h) => <button key={h.id} className={hostFilter === h.name ? "on" : ""} onClick={() => setHostFilter(h.name)} title={`${h.name} · ${h.online ? (h.local ? t("这台电脑") : t("在线")) : t("离线")}`}><i className={h.online ? "" : "off"} /><span className="host-short">{h.name}</span></button>)}
              </div>
            </>}
            <div className="rs-h">{t("在线")}<span className="n">{online.length} / {agents.length}</span></div>
            {online.slice(0, 6).map((a) => {
              const working = a.sessions.filter((s) => s.state === "working").length;
              const cur = a.current[0]?.id;
              return (
                <button key={a.actor.id} className="ag" onClick={() => { setOpen(null); onAllTasks(); setView("table"); setFilters({ project: null, mine: false, urgent: false, blocked: false, review: false, agent: a.actor.id }); }} title={t("只看 {name} 的任务", { name: a.actor.name }) + (a.current[0] ? ` · ${a.current[0].title}` : "")}>
                  <Avatar actor={a.actor} size={16} />
                  <span className="nm">{a.actor.name}</span>
                  <span className="cur">{[working ? t("{n} 在跑", { n: working }) : t("空闲"), cur].filter(Boolean).join(" · ")}</span>
                  <span className={`dot${working ? "" : " idle"}`} />
                </button>
              );
            })}
            {quota.length > 0 && (
              <button className="side-quota" onClick={() => { setOpen(null); onQuota?.(); }} title={quota.map((q) => q.title).join("\n")}>
                <span>{t("额度")}</span>
                <span className="m"><i className={heat} style={{ width: `${Math.min(100, top)}%` }} /></span>
                <span className="num">{quota.map((q) => `${q.glyph} ${Math.round(q.used)}%`).join(" · ")}</span>
              </button>
            )}
          </div>}
        </div>
      </div>
    </aside>
  );
}
