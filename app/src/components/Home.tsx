import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import type { AgentPresence } from "../derive";
import { actorOf, durSince, parseAcceptance, projectOf, relTime, statusLabel } from "../derive";
import type { Comment, Issue, Quota, Session, SessionRef, View } from "../types";
import { Avatar, Pri, ProjectTag } from "./ui";

function untilText(epoch: number | null): string {
  if (!epoch) return "";
  const m = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  if (m < 60) return `${m}m 后重置`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")} 后重置` : `${Math.round(h / 24)}d 后重置`;
}

function QuotaBar({ w }: { w: { label: string; used_percent: number | null; resets_at: number | null } }) {
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
  hostFilter?: string;
  issues: Issue[];
  agents: AgentPresence[];
  refs: Map<string, SessionRef>;
  me: string;
  counts: { working: number; waiting: number; review: number; blocked: number };
  onSelect: (id: string) => void;
  onView: (v: View) => void;
  onInbox: (tab: "review" | "waiting" | "blocked") => void;
  onFocus: (sessionId: string) => void;
}

interface Lane { agent: AgentPresence; items: { issue: Issue; session?: Session; last?: Comment }[]; idleSessions: Session[] }

// The page that answers "what is everyone doing right now, and how far along":
// one lane per agent, one row per task in progress, with the newest progress note.
export function HomeView({ hostFilter, api, issues, agents, refs, me, counts, onSelect, onView, onInbox, onFocus }: Props) {
  const [lastNote, setLastNote] = useState<Record<string, Comment | undefined>>({});
  const [quota, setQuota] = useState<Quota[]>([]);

  // Usage limits per agent: Claude Code from its statusline feed, Codex from its
  // rollout events; refreshed every minute.
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const q = await api.quota(); if (alive) setQuota(q); } catch { /* keep last */ } };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [api]);

  const inProgress = useMemo(() => issues.filter((i) => i.status === "in_progress"), [issues]);
  const key = inProgress.map((i) => i.id + i.updated_at).join("|");
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, Comment | undefined> = {};
      await Promise.all(inProgress.map(async (i) => {
        try { const c = await api.comments(i.id); out[i.id] = c[c.length - 1]; } catch { /* keep going */ }
      }));
      if (alive) setLastNote(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, api]);

  const lanes = useMemo<Lane[]>(() => {
    const byId = new Map(issues.map((i) => [i.id, i]));
    return agents.map((a) => {
      const sessTask = new Map<string, Session>();
      for (const s of a.sessions) {
        const t = refs.get(s.session_id)?.current_task;
        if (t && byId.get(t)?.status === "in_progress") sessTask.set(t, s);
      }
      const items = inProgress.filter((i) => actorOf(i.assignee, me)?.id === a.actor.id).map((i) => ({ issue: i, session: sessTask.get(i.id), last: lastNote[i.id] }));
      const claimed = new Set(items.map((x) => x.issue.id));
      for (const [t, s] of sessTask) if (!claimed.has(t)) items.push({ issue: byId.get(t)!, session: s, last: lastNote[t] });
      const idleSessions = a.sessions.filter((s) => ![...sessTask.values()].includes(s));
      return { agent: a, items, idleSessions };
    }).filter((l) => l.agent.online || l.items.length > 0);
  }, [agents, inProgress, refs, lastNote, me, issues]);

  const recent = useMemo(() => [...issues].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12), [issues]);

  return (
    <div className="home">
      <div className="stats">
        <button className="stat" onClick={() => onView("agents")}><b>{counts.working}</b><span>在跑</span></button>
        <button className="stat warn" onClick={() => onInbox("waiting")}><b>{counts.waiting}</b><span>会话已空闲</span></button>
        <button className="stat" onClick={() => onInbox("review")}><b>{counts.review}</b><span>待你审核</span></button>
        <button className="stat" onClick={() => onInbox("blocked")}><b>{counts.blocked}</b><span>被卡住</span></button>
        <span className="spacer" />
        <button className="btn sm" onClick={() => onView("board")}>看板 →</button>
      </div>

      <section>
        <h4>现在在做 <span className="muted">每个 Agent 手上的任务，和它做到哪了</span></h4>
        {lanes.length === 0 && <div className="empty">没有进行中的任务，也没有会话在跑。<br /><button className="link-btn" onClick={() => onView("board")}>看看待办里有什么 ›</button></div>}
        <div className="lanes">
          {lanes.map(({ agent: a, items, idleSessions }) => (
            <div key={a.actor.id} className={`lane${a.online ? "" : " off"}`}>
              <div className="lane-h">
                <Avatar actor={a.actor} online={a.online} size={26} />
                <b>{a.actor.name}</b>
                <span className="muted small">{a.sessions.length ? `${a.sessions.length} 个会话 · ${a.sessions.filter((s) => s.state === "working").length} 在跑` : a.online ? "在线" : "离线"}</span>
              </div>
              {(() => {
                const qs = quota.filter((x) => x.agent === a.actor.id && (hostFilter ? (x.host_name ?? "") === hostFilter : !x.remote));
                if (!qs.length || a.actor.kind === "human") return null;
                return qs.map((q) => (
                  <div key={q.host ?? "local"} className="quotas" title={q.updated_at ? `额度数据更新于 ${relTime(new Date(q.updated_at * 1000).toISOString())} 前 · 来源 ${q.source}` : q.note}>
                    {q.windows.length ? q.windows.map((w) => <QuotaBar key={w.label} w={w} />) : <span className="muted small">{q.note || "没有额度数据"}</span>}
                    {q.windows.length > 0 && (() => {
                      const ageMin = q.updated_at ? (Date.now() / 1000 - q.updated_at) / 60 : null;
                      const stale = ageMin !== null && ageMin > (q.source === "oauth" ? 20 : 120);
                      const src = q.source === "oauth" ? "Claude 官方接口，和 /usage、桌面端一致 · 每 5 分钟拉一次" : q.agent === "codex" ? "Codex 自己上报的官方数字" : q.agent === "claude-code" ? "Claude Code 状态栏上报的官方数字" : q.source;
                      const hint = !stale ? "" : q.source === "oauth" ? "（拉不到新数据，可能离线或令牌过期）" : `（用一次 ${q.agent === "codex" ? "Codex" : "Claude Code"} 就会刷新）`;
                      return <span className={`prov small ${stale ? "stale" : "muted"}`}>{src} · {ageMin === null ? "时间未知" : `${relTime(new Date(q.updated_at! * 1000).toISOString())} 前`}{hint}</span>;
                    })()}
                  </div>
                ));
              })()}
              {items.length === 0 && <div className="lane-empty muted">没有认领任务{idleSessions.length ? "，但有会话开着" : ""}</div>}
              {items.map(({ issue: i, session: s, last }) => {
                const ac = parseAcceptance(i.acceptance_criteria);
                const done = ac.filter((x) => x.done).length;
                const st = s ? (s.state === "working" ? { text: "在跑", cls: "prog" } : s.state === "idle" ? { text: "空闲", cls: "done" } : { text: "开着", cls: "open" }) : { text: "没有会话在跑", cls: "open" };
                return (
                  <div key={i.id} className="now-card opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0}>
                    <div className="l1">
                      <span className="t">{i.title}</span>
                      <span className={`st sm ${st.cls}`}>{st.text}</span>
                    </div>
                    <div className="meta"><Pri p={i.priority} /><ProjectTag name={projectOf(i)} /><span className="mono muted">{i.id}</span><span className="muted">· 认领于 {relTime(i.started_at ?? i.updated_at)} 前</span></div>
                    {ac.length > 0 && (
                      <div className="prog"><span className="bar"><i style={{ width: `${(done / ac.length) * 100}%` }} /></span><span className="mono small muted">{done}/{ac.length} 验收项</span>{ac.find((x) => !x.done) && <span className="small muted">· 下一项：{ac.find((x) => !x.done)!.text}</span>}</div>
                    )}
                    <div className="last">
                      {last ? <><span className="lbl">最新</span><span className="sel-text">{last.text}</span><span className="mono muted small">{relTime(last.created_at)}</span></> : <span className="muted small">还没留过进度——Agent 应该 dispatch log</span>}
                    </div>
                    {s && (
                      <div className="sess-line">
                        <span className="muted small">{s.source_app}{s.herdr?.title ? ` · ${s.herdr.title}` : ""}{s.last_at ? ` · 最近活动 ${durSince(s.last_at)}前` : ""}</span>
                        <button className="copy-btn" onClick={(e) => { e.stopPropagation(); onFocus(s.session_id); }}>打开会话</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {idleSessions.length > 0 && (
                <div className="idle-sess">
                  {idleSessions.map((s) => (
                    <div key={s.session_id} className="idle-row">
                      <span className={`st sm ${s.state === "working" ? "prog" : s.state === "idle" ? "done" : "open"}`}>{s.state === "working" ? "在跑" : s.state === "idle" ? "空闲" : "未登记"}</span>
                      <span className="t">{s.herdr?.title || s.title || s.project || s.cwd || "（未知目录）"}</span>
                      <span className="muted small">{s.source_app}{s.remote && <span className="host-chip">{s.host_name}</span>} · 没挂任务</span>
                      <button className="copy-btn" onClick={() => onFocus(s.session_id)}>打开</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h4>最近动态</h4>
        <div className="recent">
          {recent.map((i) => {
            const a = actorOf(i.assignee ?? i.created_by, me);
            const st = statusLabel(i);
            return (
              <div key={i.id} className="recent-row opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0}>
                <Avatar actor={a} />
                <span className="who">{a?.name ?? "—"}</span>
                <span className={`st sm ${st.cls}`}>{st.text}</span>
                <span className="t">{i.title}</span>
                <span className="mono muted small">{i.id}</span>
                <span className="mono muted small right">{relTime(i.updated_at)}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
