import { type ReactNode, useMemo, useState } from 'react';
import { activityKey, activityLabel, conversationProject, conversationSummary } from '../activity';
import { actorOf, durSince } from '../derive';
import type { Activity, Issue } from '../types';
import { OpenSessionButton } from './SessionActions';
import { ConversationMenuButton, useConversationMenu } from './ConversationActions';
import { Avatar } from './ui';

export function ConversationRows({ rows, me, onOpen, onRead, taskContent }: { taskContent?: (a: Activity) => ReactNode; rows: Activity[]; onRead: (a: Activity) => Promise<void>; me: string; onOpen: (id: string) => void }) {
  const openMenu = useConversationMenu();
  const [reading, setReading] = useState<Set<string>>(new Set());
  const read = async (a: Activity) => {
    const key = activityKey(a);
    setReading(old => new Set(old).add(key));
    try { await onRead(a); } finally { setReading(old => { const next = new Set(old); next.delete(key); return next; }); }
  };
  return <div className="conversation-rows">{rows.map(a => <div className={`conversation-row${a.unread ? ' unread' : ''}`} key={activityKey(a)} onContextMenu={e => openMenu(a,e)}><button className="conversation-main" onClick={() => onOpen(a.session_id)} aria-label={`查看并回复：${a.title}`}>
    <Avatar actor={actorOf(a.agent, me)} size={30} />
    <div className="conversation-summary">
      <div className="conversation-title"><strong>{a.title}</strong><span className={`activity-badge ${a.stale ? '' : a.state === 'working' ? 'running' : a.unread ? 'new' : ''}`}>{a.scheduled ? '定时会话' : activityLabel(a)}</span></div>
      <div className="conversation-location"><span className="conversation-project"><span>项目</span><b>{conversationProject(a)}</b></span><span className="conversation-folder" title={a.cwd || '未记录工作目录'}><span>文件夹</span><code>{a.cwd ? a.cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~') : '未记录'}</code></span></div>
      <div className="conversation-preview conversation-overview" title="根据整段会话中的需求与变更整理"><span className="conversation-caption">会话概览</span>{a.overview || '暂无足够的对话内容可整理'}</div>
      <div className="conversation-preview"><span className="conversation-caption">{a.reply_preview ? '回复摘要' : '进展摘要'}</span>{conversationSummary(a)}</div>
      {a.state === 'working' && !a.stale && a.activity && <div className="conversation-current" title={a.activity}><span className="conversation-caption">正在做</span>{a.activity}</div>}
      <div className="conversation-meta"><span>{actorOf(a.agent, me)?.name ?? a.agent}</span><span>{a.host_name || '本机'}</span>{Object.keys(a.files ?? {}).length > 0 && <span>记录过 {Object.keys(a.files ?? {}).length} 个文件改动</span>}<time>{durSince(a.last_at) === "刚刚" ? "刚刚" : `${durSince(a.last_at)}前`}</time></div>
    </div><span className="conversation-arrow" aria-hidden>›</span></button>{a.overview && a.overview.length > 120 && <details className="conversation-overview-detail"><summary>展开会话概览</summary><p>{a.overview}</p><small>从对话中的初始目标和后续需求摘录；最新结果见回复摘要。</small></details>}{taskContent?.(a)}<div className="conversation-actions">{a.unread && a.reply_id && <button className="btn sm" disabled={reading.has(activityKey(a))} onClick={() => void read(a)} aria-label={`标记已读：${a.title}`}>已读</button>}<button className="btn sm view-conversation" onClick={() => onOpen(a.session_id)}>查看并回复</button><OpenSessionButton session={a} /><ConversationMenuButton a={a}/></div>
  </div>)}</div>;
}

export function Workspace({ rows, loaded, error, unavailable, me, issues, onOpen, onTask, onInbox, onSessions, onPhone, onNew, onRead }: { rows: Activity[]; onRead: (a: Activity) => Promise<void>; loaded: boolean; error: boolean; unavailable: string[]; me: string; issues: Issue[]; onOpen: (id: string) => void; onTask: (id: string) => void; onInbox: () => void; onSessions: () => void; onPhone?: () => void; onNew: () => void }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const ordinary = rows.filter(a => !a.scheduled);
  const running = ordinary.filter(a => a.state === 'working' && !a.stale);
  const unread = ordinary.filter(a => a.unread);
  const filtered = useMemo(() => rows.filter(a => (filter === 'scheduled' ? !!a.scheduled : !a.scheduled && (filter === 'running' ? a.state === 'working' && !a.stale : filter === 'unread' ? a.unread : true)) && `${a.title} ${conversationProject(a)} ${a.cwd} ${a.agent} ${a.overview || ""} ${conversationSummary(a)}`.toLowerCase().includes(query.toLowerCase())), [rows, filter, query]);
  const list = filtered.slice(0, limit);
  const activeTasks = issues.filter(i => i.status === 'in_progress');
  return <div className="workspace">
    <header className="workspace-heading"><div><h2>接着上次的工作</h2><p>{running.length ? `${running.length} 个会话正在进行` : '查看回复、进展和文件改动'}</p></div><span className={`live-indicator${error ? ' interrupted' : ''}`}>{error ? '更新中断 · 正在重连' : loaded ? '每 3 秒同步活动' : '正在连接会话…'}</span><div className="workspace-heading-actions"><button className="btn primary" onClick={onNew}>＋ 新建会话</button>{onPhone && <button className="btn sm" onClick={onPhone}>手机访问</button>}</div></header>
    {unavailable.length > 0 && <div className="connection-note">{unavailable.join('、')} 的实时活动暂不可用，保留最后一次记录。</div>}
    <div className="workspace-toolbar"><div className="views">{[['all', '最近会话', ordinary.length], ['running', '进行中', running.length], ['unread', '未读回复', unread.length], ['scheduled', '定时会话', rows.filter(a => a.scheduled).length]].map(([key,label,n]) => <button key={key} className={filter === key ? 'on' : ''} onClick={() => setFilter(String(key))}>{label} <span className="mono">{n}</span></button>)}</div><label className="search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索会话、项目、文件夹…" /></label></div>
    {!loaded && <div className="empty">首次读取最近的会话，之后只同步新增内容。</div>}
    {loaded && list.length === 0 && <div className="empty">{filter === 'unread' ? '没有未读回复' : filter === 'running' ? '当前没有正在执行的会话' : '没有匹配的最近会话'}<button className="link" onClick={onSessions}>查看全部会话</button></div>}
    <ConversationRows onRead={onRead} rows={list} me={me} onOpen={onOpen} />
    {filtered.length > limit && <button className="load-more-conversations" onClick={() => setLimit(n => n+20)}>显示更多会话 · 还有 {filtered.length-limit} 个</button>}
    <div className="workspace-footer"><button className="link" onClick={onSessions}>全部会话 →</button><button className="link" onClick={onInbox}>查看等我的事项 →</button></div>
    {activeTasks.length > 0 && <details className="workspace-tasks"><summary>进行中的任务 · {activeTasks.length}</summary>{activeTasks.map(i => <button key={i.id} onClick={() => onTask(i.id)}><span>{i.title}</span><span className="muted mono">{i.id} →</span></button>)}</details>}
  </div>;
}
