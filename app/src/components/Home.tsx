import { useMemo, useState } from "react";
import { ago, actorOf, parseAcceptance, projectColor, relTime, sessionStatus } from "../derive";
import { UNGROUPED_PROJECT, activityKey, conversationProject, conversationSummary, sessionLifecycle } from "../activity";
import { projectGroups, projectHome } from "../projectModel";
import { isStarred, rankProjects, type ProjectFlags } from "../projectFlags";
import type { Activity, Issue, Session, View } from "../types";
import type { InboxItems } from "./Inbox";
import { Avatar, Pri } from "./ui";
import { useViewMenuExtras } from "./ContextMenu";
import { t as tr, useLocale, useT } from "../i18n";

const sessionKey = (s: { host?: string; agent: string; session_id: string }) => `${s.host ?? "local"}:${s.agent}:${s.session_id}`;

function untilText(epoch: number | null): string {
  if (!epoch) return "";
  if (epoch * 1000 < Date.now()) return tr("已过重置时间");
  const m = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  if (m < 60) return tr("{m}m 后重置", { m });
  const h = Math.floor(m / 60);
  return h < 48 ? tr("{h}h{m} 后重置", { h, m: String(m % 60).padStart(2, "0") }) : tr("{d}d 后重置", { d: Math.round(h / 24) });
}

export function QuotaBar({ w }: { w: { label: string; used_percent: number | null; resets_at: number | null } }) {
  useLocale();  // untilText() is module-level t(); subscribe so the bar re-renders on a language change
  const p = w.used_percent ?? 0;
  const cls = p >= 90 ? "crit" : p >= 70 ? "warn" : "";
  return (
    <div className={`quota ${cls}`} title={untilText(w.resets_at)}>
      <span className="ql">{w.label}</span>
      <span className="qbar"><i style={{ width: `${Math.min(100, p)}%` }} /></span>
      <span className="qv mono">{w.used_percent === null ? "—" : `${Math.round(p)}%`}</span>
      <span className="qr muted small">{untilText(w.resets_at)}</span>
    </div>
  );
}

interface Props {
  insight?: string;
  alertCount?: number;
  me: string;
  loaded: boolean;
  connectionError: boolean;
  unavailable: string[];
  rows: Activity[];
  issues: Issue[];
  outcomes: Issue[];
  inbox: InboxItems;
  progress: Record<string, string>;
  flags: ProjectFlags;
  archiveDays: number;
  expandedDefault: number;
  onFlag: (name: string, change: { starred?: boolean; archived?: boolean }) => void;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onTask: (id: string) => void;
  onProject: (name: string) => void;
  onView: (v: View) => void;
  onNew: (a?: Activity) => void;
  onLocate?: (projectName: string, section: "review" | "sessions") => void;
  onDiscuss?: () => void;
  onPhone?: () => void;
  onScreen?: () => void;
  screenReady?: boolean;
}

const UNGROUPED = UNGROUPED_PROJECT;
const sessionProject = (s: Session) => conversationProject({ cwd: s.cwd, project: s.project } as Activity);
const plain = (md: string) => md.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/[#*`>\[\]()!_]/g, " ").replace(/\s+/g, " ").trim();

interface Card {
  name: string;
  last: number;
  live: boolean;
  waiting: Session[];
  unread: Activity[];
  running: Activity[];
  tracked: Activity[];
  tasks: Issue[];
  blockedTasks: Issue[];
  blocked: number;
  lastActive: number;
  open: number;
  sessions: number;
  results: Issue[];
  latest?: Activity;
  home?: Activity;
}

// The work is organised by project: a project has conversations, and each
// conversation spins off tasks. This page shows every project's present state
// at once — what waits for me, what is running, which tasks are mid-way, what
// got delivered — and points into the 项目 view for the full history.
export function HomeView({ onDiscuss, insight, alertCount, me, loaded, connectionError, unavailable, rows, issues, outcomes, inbox, progress, flags, archiveDays, expandedDefault, onFlag, onOpen, onFocus, onTask, onProject, onView, onNew, onLocate, onPhone, onScreen, screenReady }: Props) {
  const t = useT();
  // The count chips narrow this page instead of leaving it.
  const [focus, setFocus] = useState<"" | "unread" | "waiting" | "blocked" | "running">("");
  // How the project cards are ordered; starred ones stay on top either way.
  type Sort = "active" | "sessions" | "open" | "name";
  const [sort, setSort] = useState<Sort>(() => { try { return (localStorage.getItem("dispatch-home-sort") as Sort) || "active"; } catch { return "active"; } });
  const changeSort = (s: Sort) => { setSort(s); try { localStorage.setItem("dispatch-home-sort", s); } catch { /* ignore */ } };
  const toggleFocus = (f: typeof focus) => setFocus((cur) => (cur === f ? "" : f));

  const cards = useMemo<Card[]>(() => {
    const unreadKeys = new Set(inbox.unread.map(activityKey));
    return projectGroups(rows, issues, outcomes, flags).map((p) => {
      const ordinary = p.sessions.filter((a) => !a.scheduled && sessionLifecycle(a, archiveDays) !== "archived");
      const waiting = inbox.waiting.filter((s) => sessionProject(s) === p.name);
      const waitingIds = new Set(waiting.map((s) => s.session_id));
      const running = ordinary.filter((a) => a.state === "working" && !a.stale && !waitingIds.has(a.session_id));
      // A session still working will supersede its last reply; list it under 在跑 only.
      const unread = ordinary.filter((a) => unreadKeys.has(activityKey(a)) && !waitingIds.has(a.session_id) && !running.includes(a));
      const busy = new Set([...waiting.map((s) => s.session_id), ...unread.map((a) => a.session_id), ...running.map((a) => a.session_id)]);
      const tracked = ordinary.filter((a) => a.starred && !busy.has(a.session_id));
      const tasks = p.items.filter((i) => i.status === "in_progress");
      const blockedTasks = p.items.filter((i) => i.status === "blocked");
      const open = p.items.filter((i) => i.status !== "closed").length;
      // Recency is conversation activity: a running session counts as now.
      const lastActive = Math.max(running.length ? Date.now() / 1000 : 0, ...ordinary.map((a) => a.last_at), ...waiting.map((s) => s.last_at), 0);
      return { name: p.name, last: p.last, lastActive, live: waiting.length + unread.length + running.length + tasks.length + blockedTasks.length + tracked.length > 0, waiting, unread, running, tracked, tasks, blockedTasks, blocked: blockedTasks.length, open, sessions: ordinary.length, results: p.results, latest: ordinary[0], home: projectHome(ordinary) };
    }).sort((a, b) => b.lastActive - a.lastActive || b.last - a.last);
  }, [rows, issues, outcomes, flags, inbox.unread, inbox.waiting, archiveDays]);

  // Every tracked conversation, across projects, newest first.
  const trackedAll = useMemo(() => rows.filter((a) => !a.scheduled && sessionLifecycle(a, archiveDays) === "starred").sort((x, y) => y.last_at - x.last_at), [rows, archiveDays]);

  // Projects with something happening get a full card; the rest stay one line each.
  const DAY = 86_400;
  const now = Date.now() / 1000;
  // 收藏 pins a project to the top; 归档 hides it until asked for.
  const ranked = rankProjects(cards.filter((c) => c.name !== UNGROUPED), flags);
  const matches = (c: Card) => focus === "" || (focus === "unread" ? c.unread.length > 0 : focus === "waiting" ? c.waiting.length > 0 : focus === "blocked" ? c.blockedTasks.length > 0 : c.running.length > 0);
  const orderBy = (a: Card, b: Card) => {
    const s = Number(isStarred(flags, b.name)) - Number(isStarred(flags, a.name));
    if (s) return s;
    if (sort === "sessions") return b.sessions - a.sessions || b.lastActive - a.lastActive;
    if (sort === "open") return b.open - a.open || b.lastActive - a.lastActive;
    if (sort === "name") return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });  // a–z first, then 中文
    return b.lastActive - a.lastActive || b.last - a.last;
  };
  const featured = ranked.active.filter((c) => (isStarred(flags, c.name) || c.live || now - c.last < 3 * DAY) && matches(c)).sort(orderBy);
  const rest = focus ? [] : ranked.active.filter((c) => !featured.includes(c));
  const archived = ranked.archived;
  const ungrouped = cards.find((c) => c.name === UNGROUPED);
  const [showRest, setShowRest] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Cards fold to one line so the page is a list of projects, not a wall. The first few and
  // anything waiting on the user start open; the user's own toggles win afterwards.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const isOpen = (c: Card, index: number) => focus !== "" || (toggled[c.name] ?? allOpen ?? (index < expandedDefault || c.waiting.length + c.unread.length > 0));
  const toggle = (name: string, open: boolean) => setToggled((t) => ({ ...t, [name]: !open }));

  const toggleAll = () => { setAllOpen(allOpen === false ? true : allOpen === true ? false : featured.every((c, i) => isOpen(c, i)) ? false : true); setToggled({}); };
  const everyOpen = allOpen ?? featured.every((c, i) => isOpen(c, i));
  useViewMenuExtras(featured.length > 1 && !focus ? [{ label: everyOpen ? t("全部收起") : t("全部展开"), onClick: toggleAll }] : [], [everyOpen, featured.length, focus]);

  const running = cards.reduce((n, c) => n + c.running.length, 0);
  const openTasks = issues.filter((i) => i.status !== "closed").length;
  const summary = t("{n} 项未完成", { n: openTasks });

  const openSession = (id: string) => (id.startsWith("pid-") ? onFocus(id) : onOpen(id));


  const renderCard = (c: Card, index = 0) => {
    const open = isOpen(c, index);
    const digest: { key: string; label: string; hot?: boolean; locate?: "review" | "sessions" }[] = [];
    if (c.waiting.length + c.unread.length) digest.push({ key: "wait", label: `${t("等你")} ${c.waiting.length + c.unread.length}`, hot: true, locate: "sessions" });
    if (c.running.length) digest.push({ key: "run", label: `${t("在跑")} ${c.running.length}` });
    if (c.tracked.length) digest.push({ key: "track", label: `${t("追踪")} ${c.tracked.length}` });
    if (c.tasks.length) digest.push({ key: "task", label: `${t("任务")} ${c.tasks.length}`, locate: "review" });
    if (c.blockedTasks.length) digest.push({ key: "block", label: `${t("卡住")} ${c.blockedTasks.length}` });
    const more = Math.max(0, c.waiting.length + c.unread.length - 3) + Math.max(0, c.running.length - 3) + Math.max(0, c.tasks.length - 3);
    return (
      <article key={c.name} data-project={c.name} className={`home-project${c.live ? "" : " quiet"}${open ? "" : " folded"}`}>
        <header>
          <button className={`fold${open ? " open" : ""}`} onClick={() => toggle(c.name, open)} aria-expanded={open} aria-label={open ? t("收起 {name}", { name: c.name }) : t("展开 {name}", { name: c.name })}>›</button>
          <span className="proj" style={{ background: projectColor(c.name) }} />
          <button className="name" onClick={() => onProject(c.name)}>{c.name}</button>
          {c.name !== UNGROUPED && <button className={`star${isStarred(flags, c.name) ? " on" : ""}`} onClick={() => onFlag(c.name, { starred: !isStarred(flags, c.name) })} title={isStarred(flags, c.name) ? t("取消收藏") : t("收藏：置顶，近期重点关注")} aria-label={isStarred(flags, c.name) ? t("取消收藏 {name}", { name: c.name }) : t("收藏 {name}", { name: c.name })}>{isStarred(flags, c.name) ? "★" : "☆"}</button>}
          {open ? <span className="counts muted small">{t("{n} 个会话", { n: c.sessions })} · {t("{n} 项未完成", { n: c.open })}{c.blocked ? ` · ${t("{n} 项被卡住", { n: c.blocked })}` : ""}{c.results.length ? ` · ${t("{n} 项成果", { n: c.results.length })}` : ""}</span> : digest.length > 0 ? <span className="digest-chips">
            {digest.map((p) => <button key={p.key} type="button" className={`digest-chip${p.hot ? " hot" : ""}`} onClick={(e) => { if (p.locate && onLocate) { e.stopPropagation(); onLocate(c.name, p.locate); } else toggle(c.name, open); }}>{p.label}</button>)}
            <span className="muted small">{c.lastActive ? ago(c.lastActive) : ""}</span>
          </span> : <button className="digest" onClick={() => toggle(c.name, open)}><span className="muted">{c.latest ? t("最近：{title}", { title: c.latest.title }) : t("没有会话")}</span><span className="muted small"> · {c.lastActive ? `${ago(c.lastActive)}` : ""}</span></button>}
          <span className="spacer" />
          <button className="btn sm" onClick={() => onNew(c.home)}>{t("新建会话")}</button>
          <button className="link" onClick={() => onProject(c.name)}>{t("进入项目 ›")}</button>
        </header>

        {open && <>
        {(!focus || focus === "waiting" || focus === "unread") && (c.waiting.length > 0 || c.unread.length > 0) && (
          <div className="home-group">
            {onLocate
              ? <button type="button" className="home-group-h hot home-group-link" onClick={() => onLocate(c.name, "sessions")} title={t("去项目页的会话看看")}>{t("等你")} <b>{c.waiting.length + c.unread.length}</b></button>
              : <div className="home-group-h hot">{t("等你")} <b>{c.waiting.length + c.unread.length}</b></div>}
            {c.waiting.slice(0, 3).map((s) => {
              const who = actorOf(s.agent, me);
              return (
                <div key={s.session_id} data-session={sessionKey(s)} className="home-row opens" role="button" tabIndex={0} onClick={() => openSession(s.session_id)} onKeyDown={(e) => e.key === "Enter" && openSession(s.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="st sm block">{sessionStatus(s)}</span>
                  <span className="t">{s.herdr?.title || s.title || s.cwd}</span>
                  <span className="meta muted small">{who?.name}{s.host_name ? ` · ${s.host_name}` : ""} · {ago(s.last_at)}</span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); openSession(s.session_id); }}>{t("查看并回复")}</button>
                </div>
              );
            })}
            {c.unread.slice(0, Math.max(0, 3 - c.waiting.length)).map((a) => {
              const who = actorOf(a.agent, me);
              return (
                <div key={activityKey(a)} data-session={activityKey(a)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(a.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="st sm rev">{t("未读回复")}</span>
                  <span className="t">{a.title}<span className="sub">{conversationSummary(a)}</span></span>
                  <span className="meta muted small">{who?.name}{a.host_name ? ` · ${a.host_name}` : ""} · {ago(a.last_at)}</span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); onOpen(a.session_id); }}>{t("查看并回复")}</button>
                </div>
              );
            })}
          </div>
        )}

        {(!focus || focus === "running") && c.running.length > 0 && (
          <div className="home-group">
            <div className="home-group-h">{t("在跑")} <b>{c.running.length}</b></div>
            {c.running.slice(0, 3).map((a) => {
              const who = actorOf(a.agent, me);
              return (
                <div key={activityKey(a)} data-session={activityKey(a)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(a.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="st sm prog">{t("进行中")}</span>
                  <span className="t">{a.title}{a.activity && <span className="sub">{t("正在做：{what}", { what: a.activity })}</span>}</span>
                  <span className="meta muted small">{who?.name}{a.host_name ? ` · ${a.host_name}` : ""} · {ago(a.last_at)}</span>
                </div>
              );
            })}
          </div>
        )}

        {!focus && c.tracked.length > 0 && (
          <div className="home-group">
            <div className="home-group-h">{t("追踪中")} <b>{c.tracked.length}</b></div>
            {c.tracked.slice(0, 3).map((a) => {
              const who = actorOf(a.agent, me);
              return (
                <div key={activityKey(a)} data-session={activityKey(a)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(a.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="star on" title={t("追踪中")}>★</span>
                  <span className="t">{a.title}<span className="sub">{conversationSummary(a)}</span></span>
                  <span className="meta muted small">{who?.name}{a.host_name ? ` · ${a.host_name}` : ""} · {ago(a.last_at)}</span>
                </div>
              );
            })}
          </div>
        )}

        {(!focus || focus === "blocked") && c.blockedTasks.length > 0 && (
          <div className="home-group">
            <div className="home-group-h hot">{t("被卡住")} <b>{c.blockedTasks.length}</b><span className="muted">{t("依赖没完成，等依赖完成会自动解开")}</span></div>
            {c.blockedTasks.slice(0, 3).map((i) => (
              <div key={i.id} data-task={i.id} className="home-row task opens" role="button" tabIndex={0} onClick={() => onTask(i.id)} onKeyDown={(e) => e.key === "Enter" && onTask(i.id)}>
                <span className="st sm block">⊘</span>
                <Pri p={i.priority} />
                <span className="t">{i.title}<span className="sub">{t("依赖 {n} 项未完成", { n: i.dependency_count ?? "" })}</span></span>
                <span className="meta muted small mono">{i.id}</span>
              </div>
            ))}
          </div>
        )}

        {!focus && c.tasks.length > 0 && (
          <div className="home-group">
            {onLocate
              ? <button type="button" className="home-group-h home-group-link" onClick={() => onLocate(c.name, "review")} title={t("去项目页的回顾看看")}>{t("进行中的任务")} <b>{c.tasks.length}</b></button>
              : <div className="home-group-h">{t("进行中的任务")} <b>{c.tasks.length}</b></div>}
            {c.tasks.slice(0, 3).map((i) => {
              const ac = parseAcceptance(i.acceptance_criteria);
              const done = ac.filter((x) => x.done).length;
              const next = ac.find((x) => !x.done);
              const who = actorOf(i.assignee, me);
              const note = progress[i.id] || i.notes;
              return (
                <div key={i.id} data-task={i.id} className="home-row task opens" role="button" tabIndex={0} onClick={() => onTask(i.id)} onKeyDown={(e) => e.key === "Enter" && onTask(i.id)}>
                  <Avatar actor={who} size={22} />
                  <Pri p={i.priority} />
                  <span className="t">{i.title}<span className="sub">{note ? t("最新：{note}", { note }) : next ? t("下一项：{text}", { text: next.text }) : t("还没留过进度")}</span></span>
                  {ac.length > 0 && <span className="prog"><span className="bar"><i style={{ width: `${(done / ac.length) * 100}%` }} /></span><span className="mono small muted">{done}/{ac.length}</span></span>}
                  <span className="meta muted small mono">{i.id}</span>
                </div>
              );
            })}
          </div>
        )}

        {!focus && !c.live && c.latest && (
          <div className="home-group">
            <div className="home-group-h">{t("最近一次会话")}</div>
            <div data-session={activityKey(c.latest)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(c.latest!.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(c.latest!.session_id)}>
              <Avatar actor={actorOf(c.latest.agent, me)} size={22} />
              <span className="t">{c.latest.title}<span className="sub">{conversationSummary(c.latest)}</span></span>
              <span className="meta muted small">{ago(c.latest.last_at)}</span>
            </div>
          </div>
        )}

        {!focus && <footer>
          {c.results[0] ? <button className="link outcome" onClick={() => onTask(c.results[0].id)} title={plain(c.results[0].description ?? "")}>{t("最新成果 · {title} ›", { title: c.results[0].title })}</button> : <span className="muted small">{t("还没登记成果")}</span>}
          {more > 0 && <button className="link" onClick={() => onProject(c.name)}>{t("还有 {n} 项，进入项目 ›", { n: more })}</button>}
        </footer>}
        </>}
      </article>
    );
  };

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h2>{t("工作台")}</h2>
          <p>{summary}</p>
          <span className={`live-indicator${connectionError ? " interrupted" : ""}`}>{connectionError ? t("更新中断 · 正在重连") : loaded ? t("每 3 秒同步会话活动") : t("正在连接会话…")}{unavailable.length > 0 && ` · ${t("{hosts} 暂时连不上", { hosts: unavailable.join(t("、")) })}`}</span>
        </div>
        <div className="home-head-actions">
          {onDiscuss && <button className="btn" onClick={onDiscuss} title={t("把一个想法交给几个 Agent 各说一次，最后出一段结论")}>{t("讨论一个念头")}</button>}
          <button className="btn primary" onClick={() => onNew()}>{t("新建会话")}</button>
        </div>
      </header>

      <div className="home-strip">
        <button className={`home-count${inbox.unread.length ? " hot" : " zero"}${focus === "unread" ? " on" : ""}`} aria-pressed={focus === "unread"} onClick={() => toggleFocus("unread")} title={t("只看有未读回复的项目")}>{t("未读回复")} <b>{inbox.unread.length}</b></button>
        <button className={`home-count${inbox.waiting.length ? " hot" : " zero"}${focus === "waiting" ? " on" : ""}`} aria-pressed={focus === "waiting"} onClick={() => toggleFocus("waiting")} title={t("只看在等你确认的会话")}>{t("等待确认")} <b>{inbox.waiting.length}</b></button>
        <button className={`home-count${inbox.blocked.length ? " hot" : " zero"}${focus === "blocked" ? " on" : ""}`} aria-pressed={focus === "blocked"} onClick={() => toggleFocus("blocked")} title={t("只看被卡住的任务")}>{t("被卡住")} <b>{inbox.blocked.length}</b></button>
        <button className={`home-count${running ? "" : " zero"}${focus === "running" ? " on" : ""}`} aria-pressed={focus === "running"} onClick={() => toggleFocus("running")} title={t("只看正在跑的会话")}>{t("在跑")} <b>{running}</b></button>
        {focus && <button className="link" onClick={() => setFocus("")}>{t("显示全部")} ✕</button>}
        {!focus && featured.length > 1 && <button className="link" onClick={toggleAll}>{everyOpen ? t("全部收起") : t("全部展开")}</button>}
        <select className="sess-agent home-sort" value={sort} onChange={(e) => changeSort(e.target.value as Sort)} aria-label={t("项目排序")} title={t("项目卡片怎么排；收藏的总在最前")}><option value="active">{t("按最近活动")}</option><option value="sessions">{t("按会话数")}</option><option value="open">{t("按未完成任务")}</option><option value="name">{t("按名称")}</option></select>
        {onPhone && <button className="link" onClick={onPhone} title={t("复制手机访问链接：在手机浏览器里打开（用 Tailscale 的话手机先连上；没用就要和电脑在同一个 Wi‑Fi）")}>{t("手机访问")} ⧉</button>}
        {onScreen && <button className="link" disabled={!screenReady} onClick={onScreen} title={screenReady ? t("复制屏幕链接：手机上看并操作这台电脑，登录用这台 Mac 的用户名和密码") : t("还没配置屏幕访问：设置页有说明")}>{t("看屏幕")} ⧉</button>}
      </div>

      {!focus && insight === undefined && <div className="home-insight placeholder" aria-hidden="true" />}
      {!focus && insight && <button className="home-insight" onClick={() => { try { localStorage.setItem("dispatch-usage-tab", "stats"); localStorage.setItem("dispatch-insights-focus", "alerts"); } catch { /* per-device hint */ } onView("stats"); }} title={t("最近 14 天跨 Agent 的复盘洞察 · 点开看全部")}><span className="home-insight-tag">{t("洞察")}</span><span className="t">{insight}</span>{alertCount ? <span className="n" title={t("按会话盯着的新告警，统计页里看")}>{t("{n} 条新", { n: alertCount })}</span> : null}<span className="muted small">{t("统计页 ›")}</span></button>}
      {focus && featured.length === 0 && (!ungrouped || !matches(ungrouped)) && <div className="home-quiet">{focus === "unread" ? t("没有未读回复") : focus === "waiting" ? t("没有会话在等你确认") : focus === "blocked" ? t("没有被卡住的任务") : t("没有会话在跑")}<button className="link" onClick={() => setFocus("")}>{t("显示全部")}</button></div>}
      {!focus && trackedAll.length > 0 && (
        <section className="home-tracked">
          <h4>★ {t("追踪中")} <span className="muted">{t("你收藏的会话，跨项目集中在这里，不会自动归档")}</span><button className="link right" onClick={() => onView("sessions")}>{t("会话页 ›")}</button></h4>
          <div className="home-rows">
            {trackedAll.slice(0, 6).map((a) => {
              const who = actorOf(a.agent, me);
              const live = a.state === "working" && !a.stale;
              return (
                <div key={activityKey(a)} data-session={activityKey(a)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(a.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className={`st sm ${live ? "prog" : a.unread ? "rev" : "open"}`}>{live ? t("进行中") : a.unread ? t("未读回复") : t("追踪中")}</span>
                  <span className="t">{a.title}<span className="sub">{live && a.activity ? t("正在做：{what}", { what: a.activity }) : conversationSummary(a)}</span></span>
                  <span className="meta muted small">{conversationProject(a)} · {who?.name} · {ago(a.last_at)}</span>
                </div>
              );
            })}
            {trackedAll.length > 6 && <button className="link" onClick={() => onView("sessions")}>{t("还有 {n} 条，去会话页看 ›", { n: trackedAll.length - 6 })}</button>}
          </div>
        </section>
      )}

      {loaded && featured.length === 0 && rest.length === 0 && archived.length === 0 && <div className="home-quiet">{t("还没有项目。会话按工作目录归入项目，任务用")} <span className="mono">project:{t("名字")}</span> {t("标签归类。")}<button className="link" onClick={() => onNew()}>{t("新建会话 ›")}</button></div>}
      {!loaded && <div className="home-quiet">{t("正在读取项目与会话…")}</div>}
      <div className="home-projects">
        {featured.map((c, i) => renderCard(c, i))}
        {ungrouped && ungrouped.live && matches(ungrouped) && renderCard(ungrouped, featured.length)}
      </div>

      {!focus && rest.length > 0 && (
        <section className="home-rest">
          <h4>{t("其他项目")} <span className="muted">{t("最近没有动静")}</span><button className="link right" onClick={() => setShowRest(!showRest)}>{showRest ? t("收起") : t("展开 {n} 个", { n: rest.length })}</button><button className="link" onClick={() => onView("projects")}>{t("全部项目 ›")}</button></h4>
          {showRest && (
            <div className="home-rest-list">
              {rest.map((c) => (
                <div key={c.name} data-project={c.name} className="home-rest-item opens" role="button" tabIndex={0} onClick={() => onProject(c.name)} onKeyDown={(e) => e.key === "Enter" && onProject(c.name)} title={t("右键：收藏、归档、新建会话")}>
                  <span className="proj" style={{ background: projectColor(c.name) }} /><b>{c.name}</b>
                  <span className="muted small">{t("{n} 个会话", { n: c.sessions })} · {t("{n} 项未完成", { n: c.open })}{c.results.length ? ` · ${t("{n} 项成果", { n: c.results.length })}` : ""}</span>
                  <span className="muted small right">{c.last ? `${relTime(new Date(c.last * 1000).toISOString())}` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {!focus && archived.length > 0 && (
        <section className="home-rest">
          <h4>{t("已归档")} <span className="muted">{t("做完了、暂时不用的项目")}</span><button className="link right" onClick={() => setShowArchived(!showArchived)}>{showArchived ? t("收起") : t("展开 {n} 个", { n: archived.length })}</button></h4>
          {showArchived && (
            <div className="home-rest-list">
              {archived.map((c) => (
                <div key={c.name} data-project={c.name} className="home-rest-item opens" role="button" tabIndex={0} onClick={() => onProject(c.name)} onKeyDown={(e) => e.key === "Enter" && onProject(c.name)}>
                  <span className="proj" style={{ background: projectColor(c.name) }} /><b>{c.name}</b>
                  <span className="muted small">{t("{n} 个会话", { n: c.sessions })} · {t("{n} 项未完成", { n: c.open })}{c.results.length ? ` · ${t("{n} 项成果", { n: c.results.length })}` : ""}</span>
                  <span className="muted small right">{c.last ? `${relTime(new Date(c.last * 1000).toISOString())}` : ""}</span>
                  <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); onFlag(c.name, { archived: false }); }}>{t("取消归档")}</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
