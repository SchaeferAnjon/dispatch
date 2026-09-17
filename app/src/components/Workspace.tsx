import { type ReactNode, useEffect, useState } from 'react';
import { activityKey, activityLabel, conversationProject, conversationSummary } from '../activity';
import { actorOf, ago } from '../derive';
import type { Activity } from '../types';
import { ConversationMenuButton } from './ConversationActions';
import { Linkified } from './Markdown';
import { Avatar } from './ui';
import { useT } from '../i18n';

// compact: one line of summary per conversation, for triage lists (等我).
// A clamped line of text that opens in place when tapped, so a cut-off summary or reply can be
// read without leaving the list (the row itself still opens the session).
function Preview({ className = '', title, children, initiallyOpen = false }: { className?: string; title?: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <div className={`conversation-preview${open ? ' open' : ''} ${className}`} title={title} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>{children}</div>;
}

export function ConversationRows({ rows, me, onOpen, onRead, onSummarize, onDigest, taskContent, compact = false, showProject = false }: { taskContent?: (a: Activity) => ReactNode; rows: Activity[]; onRead: (a: Activity) => Promise<void>; onSummarize?: (a: Activity) => Promise<void>; onDigest?: (a: Activity) => Promise<void>; me: string; onOpen: (id: string) => void; compact?: boolean; showProject?: boolean }) {
  const t = useT();
  const digestFresh = (a: Activity) => !!(a.unread && a.unread_summary && a.unread_summary_reply === a.reply_id);
  // An unread reply without its digest yet: ask for one (the handler dedupes per reply).
  useEffect(() => { if (!onDigest) return; for (const a of rows) if (a.unread && a.reply_id && !digestFresh(a)) void onDigest(a); }, [rows, onDigest]);
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set());
  const summarize = async (a: Activity) => { if (!onSummarize) return; const key = activityKey(a); setSummarizing(old => new Set(old).add(key)); try { await onSummarize(a); } finally { setSummarizing(old => { const n = new Set(old); n.delete(key); return n; }); } };
  const [reading, setReading] = useState<Set<string>>(new Set());
  const read = async (a: Activity) => {
    const key = activityKey(a);
    setReading(old => new Set(old).add(key));
    try { await onRead(a); } finally { setReading(old => { const next = new Set(old); next.delete(key); return next; }); }
  };
  return <div className="conversation-rows">{rows.map(a => <div className={`conversation-row${a.unread ? ' unread' : ''}${compact ? ' compact' : ''}`} key={activityKey(a)} data-session={activityKey(a)}><button className="conversation-main" onClick={() => onOpen(a.session_id)} aria-label={t("查看并回复：{title}", { title: a.title })}>
    <Avatar actor={actorOf(a.agent, me)} size={30} />
    <div className="conversation-summary">
      <div className="conversation-title"><span className={`host-chip conversation-host${a.remote ? '' : ' local'}`} title={a.remote ? t('这段会话在 {host} 上', { host: a.host_name || '' }) : t('这段会话在这台电脑上')}>{a.host_name || t('本机')}</span>{showProject &&<span className="conversation-project-chip" title={t("所属项目")}>{conversationProject(a)}</span>}{a.starred&&<span className="star on" title={t("追踪中")}>★</span>}<strong>{a.title}</strong><span className={`activity-badge ${a.stale ? '' : a.state === 'working' ? 'running' : a.unread ? 'new' : ''}`}>{a.scheduled ? t('定时会话') : activityLabel(a)}</span></div>
      {!compact && <div className="conversation-location"><span className="conversation-project"><span>{t('项目')}</span><b>{conversationProject(a)}</b></span><span className="conversation-folder" title={a.cwd || t('未记录工作目录')}><span>{t('文件夹')}</span><code>{a.cwd ? a.cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~') : t('未记录')}</code></span></div>}
      {(() => { const fresh = !!(a.unread_summary && a.unread_summary_reply === a.reply_id); return a.unread || fresh
        ? <div className="conversation-preview open conversation-model-summary conversation-digest" title={t("这一轮的回复摘要：它最后告诉你什么、要你做什么")} onClick={(e) => e.stopPropagation()}><span className="conversation-caption">{a.unread ? t('未读这轮') : t('这轮回复')}</span>{fresh ? <Linkified text={a.unread_summary!} /> : <span className="muted">{onDigest ? t('正在写这一轮的摘要…') : (a.reply_preview || '').slice(0, 300)}</span>}</div>
        : a.summary ? <Preview className="conversation-model-summary" initiallyOpen title={t("模型写的总结：目标、做了什么、还差什么（点文字收起）")}><span className="conversation-caption">{t('总结')}</span><Linkified text={a.summary} /></Preview> : null; })()}
      {!compact && !a.summary && <div className="conversation-preview conversation-overview" title={t("你在这段会话里提过的要求：最初一条，以及后续追加的")}><span className="conversation-caption">{t('你说过的')}</span>{a.overview || t('暂无足够的对话内容可整理')}</div>}
      <Preview title={t("点文字展开全文；点其他地方打开会话")}><span className="conversation-caption">{a.reply_preview ? t('最新回复') : t('最新进展')}</span><Linkified text={a.summary ? (a.reply_preview || a.activity || '').trim().slice(0, 600) || '—' : conversationSummary(a)} /></Preview>
      {a.state === 'working' && !a.stale && a.activity && <div className="conversation-current" title={a.activity}><span className="conversation-caption">{t('正在做')}</span>{a.activity}</div>}
      <div className="conversation-meta"><span>{actorOf(a.agent, me)?.name ?? a.agent}</span><span>{a.host_name || t('本机')}</span>{Object.keys(a.files ?? {}).length > 0 && <span>{t("记录过 {n} 个文件改动", { n: Object.keys(a.files ?? {}).length })}</span>}<time>{ago(a.last_at)}</time></div>
    </div><span className="conversation-arrow" aria-hidden>›</span></button>{taskContent?.(a)}<div className="conversation-actions">{a.unread && a.reply_id && <button className="btn sm" disabled={reading.has(activityKey(a))} onClick={() => void read(a)} aria-label={t("标记已读：{title}", { title: a.title })}>{t('已读')}</button>}<button className="btn sm view-conversation" onClick={() => onOpen(a.session_id)}>{t('查看并回复')}</button>{onSummarize && <button className="btn sm" disabled={summarizing.has(activityKey(a))} onClick={() => void summarize(a)} title={a.summary ? t('用模型重新总结这段会话（会调用 API）') : t('让模型写一段总结：目标、做了什么、还差什么（会调用 API，用 dispatch env 里的 Key）')}>{summarizing.has(activityKey(a)) ? t('总结中…') : a.summary ? t('✦ 重新总结') : t('✦ 总结')}</button>}<ConversationMenuButton a={a}/></div>
  </div>)}</div>;
}
