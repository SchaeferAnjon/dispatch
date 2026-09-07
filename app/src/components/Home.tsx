import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { AgentPresence } from "../derive";
import { actorOf, durSince, parseAcceptance, projectColor, relTime, sessionStatus } from "../derive";
import { activityKey, conversationProject, conversationSummary } from "../activity";
import { projectGroups } from "../projectModel";
import type { Activity, Issue, Quota, Session, View } from "../types";
import type { InboxItems } from "./Inbox";
import { Avatar, Pri } from "./ui";

function untilText(epoch: number | null): string {
  if (!epoch) return "";
  if (epoch * 1000 < Date.now()) return "已过重置时间";
  const m = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  if (m < 60) return `${m}m 后重置`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")} 后重置` : `${Math.round(h / 24)}d 后重置`;
}

export function QuotaBar({ w }: { w: { label: string; used_percent: number | null; resets_at: number | null } }) {
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
  api: Api;
  hostFilter: string;
  me: string;
  loaded: boolean;
  connectionError: boolean;
  unavailable: string[];
  rows: Activity[];
  agents: AgentPresence[];
  issues: Issue[];
  outcomes: Issue[];
  inbox: InboxItems;
  progress: Record<string, string>;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onTask: (id: string) => void;
  onProject: (name: string) => void;
  onView: (v: View) => void;
  onInbox: (tab: keyof InboxItems) => void;
  onNew: (a?: Activity) => void;
  onPhone?: () => void;
}

const UNGROUPED = "未关联项目";
const sessionProject = (s: Session) => conversationProject({ cwd: s.cwd, project: s.project } as Activity);
const plain = (md: string) => md.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/[#*`>\[\]()!_]/g, " ").replace(/\s+/g, " ").trim();

interface Card {
  name: string;
  last: number;
  live: boolean;
  waiting: Session[];
  unread: Activity[];
  running: Activity[];
  tasks: Issue[];
  blocked: number;
  open: number;
  sessions: number;
  results: Issue[];
  latest?: Activity;
}

// The work is organised by project: a project has conversations, and each
// conversation spins off tasks. This page shows every project's present state
// at once — what waits for me, what is running, which tasks are mid-way, what
// got delivered — and points into the 项目 view for the full history.
export function HomeView({ api, hostFilter, me, loaded, connectionError, unavailable, rows, agents, issues, outcomes, inbox, progress, onOpen, onFocus, onTask, onProject, onView, onInbox, onNew, onPhone }: Props) {
  const [quota, setQuota] = useState<Quota[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const q = await api.quota(); if (alive) setQuota(q); } catch { /* keep last */ } };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [api]);

  const cards = useMemo<Card[]>(() => {
    const unreadKeys = new Set(inbox.unread.map(activityKey));
    return projectGroups(rows, issues, outcomes).map((p) => {
      const ordinary = p.sessions.filter((a) => !a.scheduled);
      const waiting = inbox.waiting.filter((s) => sessionProject(s) === p.name);
      const waitingIds = new Set(waiting.map((s) => s.session_id));
      const running = ordinary.filter((a) => a.state === "working" && !a.stale && !waitingIds.has(a.session_id));
      // A session still working will supersede its last reply; list it under 在跑 only.
      const unread = ordinary.filter((a) => unreadKeys.has(activityKey(a)) && !waitingIds.has(a.session_id) && !running.includes(a));
      const tasks = p.items.filter((i) => i.status === "in_progress");
      const blocked = p.items.filter((i) => i.status === "blocked").length;
      const open = p.items.filter((i) => i.status !== "closed").length;
      return { name: p.name, last: p.last, live: waiting.length + unread.length + running.length + tasks.length + blocked > 0, waiting, unread, running, tasks, blocked, open, sessions: ordinary.length, results: p.results, latest: ordinary[0] };
    }).sort((a, b) => Number(b.live) - Number(a.live) || b.last - a.last);
  }, [rows, issues, outcomes, inbox.unread, inbox.waiting]);

  // Projects with something happening get a full card; the rest stay one line each.
  const DAY = 86_400;
  const now = Date.now() / 1000;
  const featured = cards.filter((c) => c.name !== UNGROUPED && (c.live || now - c.last < 3 * DAY));
  const rest = cards.filter((c) => c.name !== UNGROUPED && !featured.includes(c));
  const ungrouped = cards.find((c) => c.name === UNGROUPED);
  const [showRest, setShowRest] = useState(false);

  const running = cards.reduce((n, c) => n + c.running.length, 0);
  const waitingCount = inbox.unread.length + inbox.waiting.length + inbox.blocked.length;
  const openTasks = issues.filter((i) => i.status !== "closed").length;
  const summary = [running ? `${running} 个会话在跑` : "", waitingCount ? `${waitingCount} 项等你` : "", `${openTasks} 项未完成`].filter(Boolean).join(" · ");

  const openSession = (id: string) => (id.startsWith("pid-") ? onFocus(id) : onOpen(id));

  const quotaByAgent = agents.filter((a) => a.actor.kind !== "human").map((a) => ({ agent: a, qs: quota.filter((x) => x.agent === a.actor.id && x.windows.length && (hostFilter ? (x.host_name ?? "") === hostFilter : !x.remote)) })).filter((x) => x.qs.length);

  const renderCard = (c: Card) => {
    const more = Math.max(0, c.waiting.length + c.unread.length - 3) + Math.max(0, c.running.length - 3) + Math.max(0, c.tasks.length - 3);
    return (
      <article key={c.name} className={`home-project${c.live ? "" : " quiet"}`}>
        <header>
          <span className="proj" style={{ background: projectColor(c.name) }} />
          <button className="name" onClick={() => onProject(c.name)}>{c.name}</button>
          <span className="counts muted small">{c.sessions} 个会话 · {c.open} 项未完成{c.blocked ? ` · ${c.blocked} 项被卡住` : ""}{c.results.length ? ` · ${c.results.length} 项成果` : ""}</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => onNew(c.latest)}>新建会话</button>
          <button className="link" onClick={() => onProject(c.name)}>进入项目 ›</button>
        </header>

        {(c.waiting.length > 0 || c.unread.length > 0) && (
          <div className="home-group">
            <div className="home-group-h hot">等你 <b>{c.waiting.length + c.unread.length}</b></div>
            {c.waiting.slice(0, 3).map((s) => {
              const who = actorOf(s.agent, me);
              return (
                <div key={s.session_id} className="home-row opens" role="button" tabIndex={0} onClick={() => openSession(s.session_id)} onKeyDown={(e) => e.key === "Enter" && openSession(s.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="st sm block">{sessionStatus(s)}</span>
                  <span className="t">{s.herdr?.title || s.title || s.cwd}</span>
                  <span className="meta muted small">{who?.name}{s.remote ? ` · ${s.host_name}` : ""} · {durSince(s.last_at)}前</span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); openSession(s.session_id); }}>查看并回复</button>
                </div>
              );
            })}
            {c.unread.slice(0, Math.max(0, 3 - c.waiting.length)).map((a) => {
              const who = actorOf(a.agent, me);
              return (
                <div key={activityKey(a)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(a.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="st sm rev">未读回复</span>
                  <span className="t">{a.title}<span className="sub">{conversationSummary(a)}</span></span>
                  <span className="meta muted small">{who?.name}{a.remote ? ` · ${a.host_name}` : ""} · {durSince(a.last_at)}前</span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); onOpen(a.session_id); }}>查看并回复</button>
                </div>
              );
            })}
          </div>
        )}

        {c.running.length > 0 && (
          <div className="home-group">
            <div className="home-group-h">在跑 <b>{c.running.length}</b></div>
            {c.running.slice(0, 3).map((a) => {
              const who = actorOf(a.agent, me);
              return (
                <div key={activityKey(a)} className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(a.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(a.session_id)}>
                  <Avatar actor={who} size={22} />
                  <span className="st sm prog">进行中</span>
                  <span className="t">{a.title}{a.activity && <span className="sub">正在做：{a.activity}</span>}</span>
                  <span className="meta muted small">{who?.name}{a.remote ? ` · ${a.host_name}` : ""} · {durSince(a.last_at)}前</span>
                </div>
              );
            })}
          </div>
        )}

        {c.tasks.length > 0 && (
          <div className="home-group">
            <div className="home-group-h">进行中的任务 <b>{c.tasks.length}</b></div>
            {c.tasks.slice(0, 3).map((i) => {
              const ac = parseAcceptance(i.acceptance_criteria);
              const done = ac.filter((x) => x.done).length;
              const next = ac.find((x) => !x.done);
              const who = actorOf(i.assignee, me);
              const note = progress[i.id] || i.notes;
              return (
                <div key={i.id} className="home-row task opens" role="button" tabIndex={0} onClick={() => onTask(i.id)} onKeyDown={(e) => e.key === "Enter" && onTask(i.id)}>
                  <Avatar actor={who} size={22} />
                  <Pri p={i.priority} />
                  <span className="t">{i.title}<span className="sub">{note ? `最新：${note}` : next ? `下一项：${next.text}` : "还没留过进度"}</span></span>
                  {ac.length > 0 && <span className="prog"><span className="bar"><i style={{ width: `${(done / ac.length) * 100}%` }} /></span><span className="mono small muted">{done}/{ac.length}</span></span>}
                  <span className="meta muted small mono">{i.id}</span>
                </div>
              );
            })}
          </div>
        )}

        {!c.live && c.latest && (
          <div className="home-group">
            <div className="home-group-h">最近一次会话</div>
            <div className="home-row opens" role="button" tabIndex={0} onClick={() => onOpen(c.latest!.session_id)} onKeyDown={(e) => e.key === "Enter" && onOpen(c.latest!.session_id)}>
              <Avatar actor={actorOf(c.latest.agent, me)} size={22} />
              <span className="t">{c.latest.title}<span className="sub">{conversationSummary(c.latest)}</span></span>
              <span className="meta muted small">{durSince(c.latest.last_at)}前</span>
            </div>
          </div>
        )}

        <footer>
          {c.results[0] ? <button className="link outcome" onClick={() => onTask(c.results[0].id)} title={plain(c.results[0].description ?? "")}>最新成果 · {c.results[0].title} ›</button> : <span className="muted small">还没登记成果</span>}
          {more > 0 && <button className="link" onClick={() => onProject(c.name)}>还有 {more} 项，进入项目 ›</button>}
        </footer>
      </article>
    );
  };

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h2>工作台</h2>
          <p>{summary}</p>
          <span className={`live-indicator${connectionError ? " interrupted" : ""}`}>{connectionError ? "更新中断 · 正在重连" : loaded ? "每 3 秒同步会话活动" : "正在连接会话…"}{unavailable.length > 0 && ` · ${unavailable.join("、")} 暂时连不上`}</span>
        </div>
        <div className="home-head-actions">
          <button className="btn primary" onClick={() => onNew()}>新建会话</button>
          {onPhone && <button className="btn" onClick={onPhone}>手机访问</button>}
        </div>
      </header>

      <div className="home-strip">
        <button className={`home-count${inbox.unread.length ? " hot" : ""}`} onClick={() => onInbox("unread")}>未读回复 <b>{inbox.unread.length}</b></button>
        <button className={`home-count${inbox.waiting.length ? " hot" : ""}`} onClick={() => onInbox("waiting")}>等待确认 <b>{inbox.waiting.length}</b></button>
        <button className={`home-count${inbox.blocked.length ? " hot" : ""}`} onClick={() => onInbox("blocked")}>被卡住 <b>{inbox.blocked.length}</b></button>
        <button className="home-count" onClick={() => onView("agents")}>在跑 <b>{running}</b></button>
        <span className="spacer" />
        {quotaByAgent.map(({ agent: a, qs }) => (
          <button key={a.actor.id} className="home-quota" onClick={() => onView("quota")} title={`${a.actor.name} 的额度 · 点开看详情`}>
            <Avatar actor={a.actor} online={a.online} size={18} />
            {qs[0].windows.map((w) => { const p = w.used_percent ?? 0; return <span key={w.label} className={`q${p >= 90 ? " crit" : p >= 70 ? " warn" : ""}`}><span className="ql">{w.label}</span><span className="qbar"><i style={{ width: `${Math.min(100, p)}%` }} /></span><span className="mono">{w.used_percent === null ? "—" : `${Math.round(p)}%`}</span></span>; })}
          </button>
        ))}
      </div>

      {loaded && featured.length === 0 && rest.length === 0 && <div className="home-quiet">还没有项目。会话按工作目录归入项目，任务用 <span className="mono">project:名字</span> 标签归类。<button className="link" onClick={() => onNew()}>新建会话 ›</button></div>}
      {!loaded && <div className="home-quiet">正在读取项目与会话…</div>}
      <div className="home-projects">
        {featured.map(renderCard)}
        {ungrouped && ungrouped.live && renderCard(ungrouped)}
      </div>

      {rest.length > 0 && (
        <section className="home-rest">
          <h4>其他项目 <span className="muted">最近没有动静</span><button className="link right" onClick={() => setShowRest(!showRest)}>{showRest ? "收起" : `展开 ${rest.length} 个`}</button><button className="link" onClick={() => onView("projects")}>全部项目 ›</button></h4>
          {showRest && (
            <div className="home-rest-list">
              {rest.map((c) => (
                <button key={c.name} className="home-rest-item opens" onClick={() => onProject(c.name)}>
                  <span className="proj" style={{ background: projectColor(c.name) }} /><b>{c.name}</b>
                  <span className="muted small">{c.sessions} 个会话 · {c.open} 项未完成{c.results.length ? ` · ${c.results.length} 项成果` : ""}</span>
                  <span className="muted small right">{c.last ? `${relTime(new Date(c.last * 1000).toISOString())}` : ""}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
