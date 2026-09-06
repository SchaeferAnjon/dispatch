import { useState } from "react";
import { parseAcceptance, sessionStatus, actorOf, durSince, NO_RESUME, projectOf, relTime } from "../derive";
import type { Issue, Session } from "../types";
import { Avatar, Pri, ProjectTag } from "./ui";

export interface InboxItems { waiting: Session[]; idle: Session[]; review: Issue[]; blocked: Issue[] }

interface Props { initialTab?: keyof InboxItems | null; items: InboxItems; me: string; onSelect: (id: string) => void; onResume: (agent: string, sessionId: string, cwd: string) => void; onFocus: (sessionId: string) => void }

// The one screen that answers "what needs me right now": sessions that stopped
// and are waiting for input, finished work awaiting review, and blocked tasks.
export function InboxView({ initialTab, items, me, onSelect, onResume, onFocus }: Props) {
  const [tab, setTab] = useState<keyof InboxItems>(() => initialTab ?? (items.waiting.length ? "waiting" : items.blocked.length ? "blocked" : "waiting"));
  const total = items.waiting.length + items.blocked.length;
  return (
    <div className="inbox">
      <div className="inbox-tabs views" aria-label="待处理分类">
        {([["waiting", "等待确认 / 失败"], ["blocked", "被卡住"], ["review", "Agent 复核"], ["idle", "空闲会话"]] as const).map(([key, label]) => <button key={key} className={tab === key ? "on" : ""} aria-pressed={tab === key} onClick={() => setTab(key)}>{label} <span className="mono">{items[key].length}</span></button>)}
      </div>
      {(total > 0 || tab === "review" || tab === "idle") && items[tab].length === 0 && <div className="empty">这个分类没有待处理事项</div>}
      {total === 0 && tab !== "idle" && tab !== "review" && <div className="empty big">✓ 没有在等你的事<br /><span className="muted">完成结果可在聊天和任务中查看，无需在这里重复确认。</span></div>}
      {(tab === "waiting" || tab === "idle") && items[tab].length > 0 && (
        <section>
          <h4>{tab === "idle" ? "空闲会话" : "需要处理"}<span className="n">{items[tab].length}</span><span className="muted">{tab === "idle" ? "不计入待处理数量，也不会触发通知" : "仅展示明确上报的确认请求或工具失败"}</span></h4>
          {items[tab].map((s) => {
            const a = actorOf(s.agent, me);
            return (
              <div key={s.session_id} className="ib-row">
                <Avatar actor={a} />
                <div className="ib-main">
                  <div className="t"><span className="st sm">{sessionStatus(s)}</span> {s.herdr?.title || s.title || s.project || s.cwd || s.session_id}</div>
                  <div className="muted small">{a?.name} · {s.source_app}{s.remote && <span className="host-chip">{s.host_name}</span>}{s.project ? ` · ${s.project}` : ""} · 最近活动 {durSince(s.last_at)}前{s.prompts ? ` · ${s.prompts} 轮` : ""}</div>
                </div>
                <button className="btn sm" onClick={() => onFocus(s.session_id)} title={s.herdr ? `Herdr 标签 ${s.herdr.tab_id}` : s.source_app}>打开会话</button>
                {s.registered && !s.session_id.startsWith("pid-") && !NO_RESUME.has(s.agent) && <button className="copy-btn" onClick={() => onResume(s.agent, s.session_id, s.cwd)}>恢复命令</button>}
              </div>
            );
          })}
        </section>
      )}
      {tab === "review" && items.review.length > 0 && (
        <section>
          <h4>Agent 复核 <span className="n">{items.review.length}</span><span className="muted">仅包含明确发起的复核请求，不计入你的待处理数量</span></h4>
          {items.review.map((i) => {
            const a = actorOf(i.assignee, me);
            return (
              <div key={i.id} className="ib-row opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(i.id); } }}>
                <Avatar actor={a} />
                <div className="ib-main">
                  <div className="t">{i.title}</div>
                  <div className="muted small"><Pri p={i.priority} /> <ProjectTag name={projectOf(i)} /> <span className="mono">{i.id}</span> · {a?.name ?? "未知"} 完成于 {relTime(i.closed_at ?? i.updated_at)}</div>
                  <div className="review-gap">{parseAcceptance(i.acceptance_criteria).length ? `${parseAcceptance(i.acceptance_criteria).filter((a) => !a.done).length} 项验收尚未勾选` : "未填写验收标准"}{!i.close_reason && " · 缺少完成说明"}</div>
                  {i.close_reason && <div className="ib-summary">{i.close_reason}</div>}
                </div>
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); onSelect(i.id); }}>查看验收</button>
              </div>
            );
          })}
        </section>
      )}
      {tab === "blocked" && items.blocked.length > 0 && (
        <section>
          <h4>被卡住 <span className="n">{items.blocked.length}</span><span className="muted">有未完成的依赖</span></h4>
          {items.blocked.map((i) => (
            <div key={i.id} className="ib-row opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(i.id); } }}>
              <span className="st sm block">⊘</span>
              <div className="ib-main"><div className="t">{i.title}</div><div className="muted small"><Pri p={i.priority} /> <ProjectTag name={projectOf(i)} /> <span className="mono">{i.id}</span> · 依赖 {i.dependency_count} 项</div></div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
