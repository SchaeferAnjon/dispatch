import { actorOf, durSince, projectOf, relTime } from "../derive";
import type { Issue, Session } from "../types";
import { Avatar, Pri, ProjectTag } from "./ui";

export interface InboxItems { waiting: Session[]; review: Issue[]; blocked: Issue[] }

interface Props { items: InboxItems; me: string; onSelect: (id: string) => void; onResume: (agent: string, sessionId: string, cwd: string) => void; onFocus: (sessionId: string) => void; onReview: (id: string) => void }

// The one screen that answers "what needs me right now": sessions that stopped
// and are waiting for input, finished work awaiting review, and blocked tasks.
export function InboxView({ items, me, onSelect, onResume, onFocus, onReview }: Props) {
  const total = items.waiting.length + items.review.length + items.blocked.length;
  return (
    <div className="inbox">
      {total === 0 && <div className="empty">没有在等你的东西。Agent 都在跑，或者都空着。</div>}
      {items.waiting.length > 0 && (
        <section>
          <h4>等你回复 <span className="n">{items.waiting.length}</span><span className="muted">Agent 答完了，光标停在输入框</span></h4>
          {items.waiting.map((s) => {
            const a = actorOf(s.agent, me);
            return (
              <div key={s.session_id} className="ib-row">
                <Avatar actor={a} />
                <div className="ib-main">
                  <div className="t">{s.herdr?.title || s.title || s.project || s.cwd || s.session_id}</div>
                  <div className="muted small">{a?.name} · {s.source_app}{s.project ? ` · ${s.project}` : ""} · 等了 {durSince(s.last_at)}{s.prompts ? ` · ${s.prompts} 轮` : ""}</div>
                </div>
                <button className="btn primary sm" onClick={() => onFocus(s.session_id)} title={s.herdr ? `Herdr 标签 ${s.herdr.tab_id}` : s.source_app}>打开会话</button>
                {s.registered && !s.session_id.startsWith("pid-") && s.agent !== "zcode" && <button className="copy-btn" onClick={() => onResume(s.agent, s.session_id, s.cwd)}>恢复命令</button>}
              </div>
            );
          })}
        </section>
      )}
      {items.review.length > 0 && (
        <section>
          <h4>待你审核 <span className="n">{items.review.length}</span><span className="muted">Agent 标记完成，还没人验收</span></h4>
          {items.review.map((i) => {
            const a = actorOf(i.assignee, me);
            return (
              <div key={i.id} className="ib-row" onClick={() => onSelect(i.id)} role="button" tabIndex={0}>
                <Avatar actor={a} />
                <div className="ib-main">
                  <div className="t">{i.title}</div>
                  <div className="muted small"><Pri p={i.priority} /> <ProjectTag name={projectOf(i)} /> <span className="mono">{i.id}</span> · {a?.name ?? "未知"} 完成于 {relTime(i.closed_at ?? i.updated_at)}{i.close_reason ? ` · "${i.close_reason}"` : ""}</div>
                </div>
                <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); onReview(i.id); }}>✓ 通过</button>
              </div>
            );
          })}
        </section>
      )}
      {items.blocked.length > 0 && (
        <section>
          <h4>被卡住 <span className="n">{items.blocked.length}</span><span className="muted">有未完成的依赖</span></h4>
          {items.blocked.map((i) => (
            <div key={i.id} className="ib-row" onClick={() => onSelect(i.id)} role="button" tabIndex={0}>
              <span className="st sm block">⊘</span>
              <div className="ib-main"><div className="t">{i.title}</div><div className="muted small"><Pri p={i.priority} /> <ProjectTag name={projectOf(i)} /> <span className="mono">{i.id}</span> · 依赖 {i.dependency_count} 项</div></div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
