import { type ReactNode, useEffect, useState } from 'react';
import { activityKey, activityLabel, conversationProject, conversationSummary, tildePath } from '../activity';
import { actorOf, ago, glyphStyle } from '../derive';
import type { Activity } from '../types';
import { ConversationMenuButton } from './ConversationActions';
import { Linkified } from './Markdown';
import { Avatar } from './ui';
import { Meta, Sep, Tag, type TagColor } from './primitives';
import { t as tr, useT } from '../i18n';

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
      {!compact && <div className="conversation-location"><span className="conversation-project"><span>{t('项目')}</span><b>{conversationProject(a)}</b></span><span className="conversation-folder" title={a.cwd || t('未记录工作目录')}><span>{t('文件夹')}</span><code>{a.cwd ? tildePath(a.cwd) : t('未记录')}</code></span></div>}
      {(() => { const fresh = !!(a.unread_summary && a.unread_summary_reply === a.reply_id); return a.unread || fresh
        ? <div className="conversation-preview open conversation-model-summary conversation-digest" title={t("这一轮的回复摘要：它最后告诉你什么、要你做什么")} onClick={(e) => e.stopPropagation()}><span className="conversation-caption">{a.unread ? t('未读这轮') : t('这轮回复')}</span>{fresh ? <Linkified text={a.unread_summary!} /> : <span className="muted">{onDigest ? t('正在写这一轮的摘要…') : (a.reply_preview || '').slice(0, 300)}</span>}</div>
        : a.summary ? <Preview className="conversation-model-summary" initiallyOpen title={t("模型写的总结：目标、做了什么、还差什么（点文字收起）")}><span className="conversation-caption">{t('总结')}</span><Linkified text={a.summary} /></Preview> : null; })()}
      {!compact && !a.summary && <div className="conversation-preview conversation-overview" title={t("你在这段会话里提过的要求：最初一条，以及后续追加的")}><span className="conversation-caption">{t('你说过的')}</span>{a.overview || t('暂无足够的对话内容可整理')}</div>}
      <Preview title={t("点文字展开全文；点其他地方打开会话")}><span className="conversation-caption">{a.reply_preview ? t('最新回复') : t('最新进展')}</span><Linkified text={a.summary ? (a.reply_preview || a.activity || '').trim().slice(0, 600) || t('暂无') : conversationSummary(a)} /></Preview>
      {a.state === 'working' && !a.stale && a.activity && <div className="conversation-current" title={a.activity}><span className="conversation-caption">{t('正在做')}</span>{a.activity}</div>}
      <div className="conversation-meta"><span>{actorOf(a.agent, me)?.name ?? a.agent}</span><span>{a.host_name || t('本机')}</span>{Object.keys(a.files ?? {}).length > 0 && <span>{t("记录过 {n} 个文件改动", { n: Object.keys(a.files ?? {}).length })}</span>}<time>{ago(a.last_at)}</time></div>
    </div><span className="conversation-arrow" aria-hidden>›</span></button>{taskContent?.(a)}<div className="conversation-actions">{a.unread && a.reply_id && <button className="btn sm" disabled={reading.has(activityKey(a))} onClick={() => void read(a)} aria-label={t("标记已读：{title}", { title: a.title })}>{t('已读')}</button>}<button className="btn sm view-conversation" onClick={() => onOpen(a.session_id)}>{t('查看并回复')}</button>{onSummarize && <button className="btn sm" disabled={summarizing.has(activityKey(a))} onClick={() => void summarize(a)} title={a.summary ? t('用模型重新总结这段会话（会调用 API）') : t('让模型写一段总结：目标、做了什么、还差什么（会调用 API，用 dispatch env 里的 Key）')}>{summarizing.has(activityKey(a)) ? t('总结中…') : a.summary ? t('✦ 重新总结') : t('✦ 总结')}</button>}<ConversationMenuButton a={a}/></div>
  </div>)}</div>;
}

// ---- Project page: a session as a list row plus the Detail beside it (design/raycast-redesign 图 4) ----

/** Which group a session sits in on a project page: waiting on you, running, or idle. */
export function sessionGroup(a: Activity): 'you' | 'running' | 'idle' {
  if (a.state === 'working' && !a.stale) return 'running';
  return a.unread ? 'you' : 'idle';
}

/** The one status tag a session row keeps next to its time. */
export function sessionTag(a: Activity): { color?: TagColor; text: string } | null {
  const t = tr;
  if (a.scheduled) return { color: 'purple', text: t('定时') };
  if (a.state === 'working' && !a.stale) return { color: 'green', text: t('在跑') };
  if (a.unread) return { color: 'blue', text: t('未读') };
  return null;
}


/** A project's glyph: the first letter of its name on its colour. */
export function ProjectGlyph({ name, small }: { name: string; small?: boolean }) {
  const ch = [...(name || '?')][0] ?? '?';
  return <span className={`pj${small ? ' sm' : ''}`} style={glyphStyle(name)} aria-hidden>{ch}</span>;
}

/** The Detail for one session: what the last turn said, what you asked for, then Metadata. */
export function SessionDetail({ a, me, linked, verdict, onOpen, onRead, onSummarize, onTask }: { a: Activity; me: string; linked: { id: string; title: string; status: string }[]; verdict?: { verdict: string; reason: string }; onOpen: (id: string) => void; onRead: (a: Activity) => Promise<void>; onSummarize?: (a: Activity) => Promise<void>; onTask: (id: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState<'' | 'read' | 'sum'>('');
  const run = async (kind: 'read' | 'sum', f: () => Promise<void>) => { setBusy(kind); try { await f(); } finally { setBusy(''); } };
  const project = conversationProject(a);
  const actor = actorOf(a.agent, me);
  const fresh = !!(a.unread_summary && a.unread_summary_reply === a.reply_id);
  const files = Object.keys(a.files ?? {}).length;
  const statusText = (s: string) => (s === 'closed' ? t('已完成') : s === 'in_progress' ? t('进行中') : t('待办'));
  return <div className="pd">
    <div className="pd-crumb"><ProjectGlyph name={project} small />{project}<span aria-hidden>›</span>{a.host_name || t('本机')}<span aria-hidden>›</span>{t('会话')}</div>
    <h2>{a.starred && <span className="pd-star" title={t('追踪中')}>★ </span>}{a.title}</h2>
    <div className="pd-actions">
      <button className="btn primary sm" onClick={() => onOpen(a.session_id)}>{t('查看并回复')}</button>
      {a.unread && a.reply_id && <button className="btn sm" disabled={busy === 'read'} onClick={() => void run('read', () => onRead(a))}>{t('已读')}</button>}
      {onSummarize && <button className="btn sm" disabled={busy === 'sum'} onClick={() => void run('sum', () => onSummarize(a))} title={a.summary ? t('用模型重新总结这段会话（会调用 API）') : t('让模型写一段总结：目标、做了什么、还差什么（会调用 API，用 dispatch env 里的 Key）')}>{busy === 'sum' ? t('总结中…') : a.summary ? t('✦ 重新总结') : t('✦ 总结')}</button>}
      <ConversationMenuButton a={a} />
    </div>
    <div className="pd-md">
      {(a.unread || fresh) && <><h4>{a.unread ? t('未读这轮') : t('这轮回复')}</h4><p>{fresh ? <Linkified text={a.unread_summary!} /> : (a.reply_preview || '').slice(0, 600) || t('暂无')}</p></>}
      {a.summary && <><h4>{t('总结')}</h4><p><Linkified text={a.summary} /></p></>}
      {!a.summary && a.overview && <><h4>{t('你说过的')}</h4><p>{a.overview}</p></>}
      {!(a.unread || fresh) && (a.reply_preview || a.activity) && <><h4>{a.reply_preview ? t('最新回复') : t('最新进展')}</h4><p><Linkified text={(a.reply_preview || a.activity || '').trim().slice(0, 600)} /></p></>}
      {a.state === 'working' && !a.stale && a.activity && <><h4>{t('正在做')}</h4><p>{a.activity}</p></>}
      {verdict && <><h4>{t('能不能关')}</h4><p><Tag color={verdict.verdict === '别关' ? 'orange' : 'green'}>{t(verdict.verdict)}</Tag> {verdict.reason}</p></>}
      <h4>{t('关联任务')}</h4>
      {linked.length ? <ul className="pd-links">{linked.map((i) => <li key={i.id}><button className="link" onClick={() => onTask(i.id)}>{i.title}</button><span className="muted"> · {statusText(i.status)}</span></li>)}</ul> : <p className="muted">{t('没有明确关联的任务')}</p>}
    </div>
    <Sep />
    <Meta rows={[
      [t('Agent'), <>{actor && <Avatar actor={actor} size={16} />}{actor?.name ?? a.agent}</>],
      [t('主机'), <>{a.state === 'working' && !a.stale && <span className="dotc" />}{a.host_name || t('本机')}</>],
      [t('状态'), a.scheduled ? t('定时会话') : activityLabel(a)],
      [t('文件夹'), <span title={a.cwd}>{a.cwd ? tildePath(a.cwd) : t('未记录')}</span>],
      ...(files ? [[t('改动'), t('记录过 {n} 个文件改动', { n: files })] as [ReactNode, ReactNode]] : []),
      [t('最后活动'), ago(a.last_at)],
      [t('会话 ID'), <span className="mono" title={a.session_id}>{a.session_id.slice(0, 8)}</span>],
    ]} />
  </div>;
}
