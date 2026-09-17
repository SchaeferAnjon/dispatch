import { conversationProject } from "../activity";
import { MovedChip } from "./Sessions";
import { useState } from "react";
import { ago, parseAcceptance, sessionStatus, actorOf, projectOf, relTime } from "../derive";
import { ConversationRows } from "./Workspace";
import type { Activity, Issue, Session } from "../types";
import { Avatar, Pri, ProjectTag } from "./ui";
import { useT } from "../i18n";

export interface InboxItems { unread: Activity[]; running: Activity[]; read: Activity[]; waiting: Session[]; idle: Session[]; review: Issue[]; blocked: Issue[] }

interface Props { onSummarize?: (a: Activity) => Promise<void>; onDigest?: (a: Activity) => Promise<void>; onRead: (a: Activity) => Promise<void>; onOpen: (id: string) => void; initialTab?: keyof InboxItems | null; items: InboxItems; me: string; onSelect: (id: string) => void; onFocus: (sessionId: string) => void }

// The one screen that answers "what needs me right now": sessions that stopped
// and are waiting for input, finished work awaiting review, and blocked tasks.
export function InboxView({ onSummarize, onDigest, onRead, onOpen, initialTab, items, me, onSelect, onFocus }: Props) {
  const t = useT();
  const [tab, setTab] = useState<keyof InboxItems>(() => initialTab ?? "unread");
  const [readingAll, setReadingAll] = useState(false);
  const readAll = async () => { setReadingAll(true); try { for (const a of items.unread) if (a.reply_id) await onRead(a); } finally { setReadingAll(false); } };
  const total = items.unread.length + items.waiting.length + items.blocked.length;
  return (
    <div className="inbox">
      <div className="inbox-tabs views" aria-label={t("待处理分类")}>
        {([["unread", t("未读回复")], ["running", t("在跑")], ["read", t("已读")], ["waiting", t("等待确认")], ["blocked", t("被卡住")], ["review", t("Agent 复核")], ["idle", t("空闲会话")]] as const).map(([key, label]) => <button key={key} className={`${tab === key ? "on" : ""}${items[key].length === 0 ? " zero" : ""}`} aria-pressed={tab === key} onClick={() => setTab(key)}>{label} <span className="mono">{items[key].length}</span></button>)}
      </div>
      {(total > 0 || tab === "review" || tab === "idle" || tab === "read" || tab === "running") && items[tab].length === 0 && <div className="empty">{tab === "read" ? t("最近七天没有读过的回复") : tab === "running" ? t("现在没有在跑的会话") : t("这个分类没有待处理事项")}</div>}
      {total === 0 && tab !== "idle" && tab !== "review" && tab !== "read" && tab !== "running" && <div className="empty big">✓ {t("暂时没有等我的事项")}<br /><span className="muted">{t("新回复会出现在这里；读到最新后自动移出。")}</span></div>}
      {tab === "unread" && items.unread.length > 1 && <div className="inbox-bulk"><span className="muted small">{t("{n} 条未读 · 每条只留一行摘要，展开看全文请「查看并回复」", { n: items.unread.length })}</span><button className="btn sm" disabled={readingAll} onClick={() => void readAll()}>{readingAll ? t("标记中…") : t("全部标记已读")}</button></div>}
      {tab === "running" && items.running.length > 0 && <section><ConversationRows compact showProject onSummarize={onSummarize} onRead={onRead} rows={items.running} me={me} onOpen={onOpen}/></section>}
      {tab === "read" && items.read.length > 0 && <div className="inbox-bulk"><span className="muted small">{t("最近七天读过的回复，最新在前；再看一眼或接着回复")}</span></div>}
      {tab === "read" && items.read.length > 0 && <section><ConversationRows compact showProject onSummarize={onSummarize} onRead={onRead} rows={items.read} me={me} onOpen={onOpen}/></section>}
      {tab === "unread" && [...new Set(items.unread.map(conversationProject))].map(project=><section key={project}><h3>{project}</h3><ConversationRows compact onSummarize={onSummarize} onDigest={onDigest} onRead={onRead} rows={items.unread.filter(a=>conversationProject(a)===project)} me={me} onOpen={onOpen}/></section>)}
      {(tab === "waiting" || tab === "idle") && items[tab].length > 0 && (
        <section>
          <h4>{tab === "idle" ? t("空闲会话") : t("需要处理")}<span className="n">{items[tab].length}</span><span className="muted">{tab === "idle" ? t("不计入待处理数量，也不会触发通知") : t("只有接入事件上报的会话会出现在这里；Codex 桌面端等没有上报的会话请到会话页看")}</span></h4>
          {items[tab].map((s) => {
            const a = actorOf(s.agent, me);
            return (
              <div key={`${s.host ?? "local"}:${s.session_id}`} data-session={`${s.host ?? "local"}:${s.agent}:${s.session_id}`} className="ib-row" title={t("右键更多操作")}>
                <Avatar actor={a} />
                <div className="ib-main">
                  <div className="t"><span className="st sm">{sessionStatus(s)}</span> {s.herdr?.title || s.title || s.project || s.cwd || s.session_id}</div>
                  <div className="muted small">{a?.name} · {s.source_app}{s.remote && <> · <span className="host-chip">{s.host_name}</span></>}<MovedChip r={s} />{s.project ? ` · ${s.project}` : ""} · {t("最近活动 {ago}", { ago: ago(s.last_at) })}{s.prompts ? ` · ${t("{n} 轮", { n: s.prompts })}` : ""}</div>
                </div>
                <button className="btn sm" onClick={() => s.session_id.startsWith('pid-') ? onFocus(s.session_id) : onOpen(s.session_id)}>{t("查看并回复")}</button>
              </div>
            );
          })}
        </section>
      )}
      {tab === "review" && items.review.length > 0 && (
        <section>
          <h4>{t("Agent 复核")} <span className="n">{items.review.length}</span><span className="muted">{t("仅包含明确发起的复核请求，不计入你的待处理数量")}</span></h4>
          {items.review.map((i) => {
            const a = actorOf(i.assignee, me);
            return (
              <div key={i.id} data-task={i.id} className="ib-row opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(i.id); } }}>
                <Avatar actor={a} />
                <div className="ib-main">
                  <div className="t">{i.title}</div>
                  <div className="muted small"><Pri p={i.priority} /> <ProjectTag name={projectOf(i)} /> <span className="mono">{i.id}</span> · {t("{who} 完成于 {time}", { who: a?.name ?? t("未知"), time: relTime(i.closed_at ?? i.updated_at) })}</div>
                  <div className="review-gap">{parseAcceptance(i.acceptance_criteria).length ? t("{n} 项验收尚未勾选", { n: parseAcceptance(i.acceptance_criteria).filter((a) => !a.done).length }) : t("未填写验收标准")}{!i.close_reason && ` · ${t("缺少完成说明")}`}</div>
                  {i.close_reason && <div className="ib-summary">{i.close_reason}</div>}
                </div>
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); onSelect(i.id); }}>{t("查看验收")}</button>
              </div>
            );
          })}
        </section>
      )}
      {tab === "blocked" && items.blocked.length > 0 && (
        <section>
          <h4>{t("被卡住")} <span className="n">{items.blocked.length}</span><span className="muted">{t("有未完成的依赖 · 不计入红点，等依赖完成会自动解开")}</span></h4>
          {items.blocked.map((i) => (
            <div key={i.id} data-task={i.id} className="ib-row opens" onClick={() => onSelect(i.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(i.id); } }}>
              <span className="st sm block">⊘</span>
              <div className="ib-main"><div className="t">{i.title}</div><div className="muted small"><Pri p={i.priority} /> <ProjectTag name={projectOf(i)} /> <span className="mono">{i.id}</span> · {t("依赖 {n} 项", { n: i.dependency_count ?? "" })}</div></div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
