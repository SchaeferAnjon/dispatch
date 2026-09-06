import { useMemo, useState } from 'react';
import { activityKey, activityLabel } from '../activity';
import { actorOf, durSince } from '../derive';
import type { Activity, Issue } from '../types';
import { OpenSessionButton } from './SessionActions';
import { Avatar } from './ui';

export function ConversationRows({ rows, me, onOpen }: { rows: Activity[]; me: string; onOpen: (id: string) => void }) {
  return <div className="conversation-rows">{rows.map(a => <div className={`conversation-row${a.unread ? ' unread' : ''}`} key={activityKey(a)}><button className="conversation-main" onClick={() => onOpen(a.session_id)} aria-label={`查看并回复：${a.title}`}>
    <Avatar actor={actorOf(a.agent, me)} size={30} />
    <div className="conversation-summary">
      <div className="conversation-title"><strong>{a.title}</strong><span className={`activity-badge ${a.stale ? '' : a.state === 'working' ? 'running' : a.unread ? 'new' : ''}`}>{activityLabel(a)}</span></div>
      <div className="conversation-preview">{a.state === 'working' && !a.stale ? a.activity : a.reply_preview || a.activity || '查看对话记录'}</div>
      <div className="conversation-meta"><span>{actorOf(a.agent, me)?.name ?? a.agent}</span><span>{a.project || '未关联目录'}</span><span>{a.host_name || '本机'}</span>{Object.keys(a.files ?? {}).length > 0 && <span>记录过 {Object.keys(a.files ?? {}).length} 个文件改动</span>}<time>{durSince(a.last_at) === "刚刚" ? "刚刚" : `${durSince(a.last_at)}前`}</time></div>
    </div><span className="conversation-arrow" aria-hidden>›</span></button><div className="conversation-actions"><button className="btn sm view-conversation" onClick={() => onOpen(a.session_id)}>查看并回复</button><OpenSessionButton session={a} /></div>
  </div>)}</div>;
}

export function Workspace({ rows, loaded, error, unavailable, me, issues, onOpen, onTask, onInbox, onSessions, onPhone, onNew }: { rows: Activity[]; loaded: boolean; error: boolean; unavailable: string[]; me: string; issues: Issue[]; onOpen: (id: string) => void; onTask: (id: string) => void; onInbox: () => void; onSessions: () => void; onPhone?: () => void; onNew: () => void }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const running = rows.filter(a => a.state === 'working' && !a.stale);
  const unread = rows.filter(a => a.unread);
  const filtered = useMemo(() => rows.filter(a => (filter === 'running' ? a.state === 'working' && !a.stale : filter === 'unread' ? a.unread : true) && `${a.title} ${a.project} ${a.agent}`.toLowerCase().includes(query.toLowerCase())), [rows, filter, query]);
  const list = filtered.slice(0, limit);
  const activeTasks = issues.filter(i => i.status === 'in_progress');
  return <div className="workspace">
    <header className="workspace-heading"><div><h2>接着上次的工作</h2><p>{running.length ? `${running.length} 个会话正在进行` : '查看回复、进展和文件改动'}</p></div><span className={`live-indicator${error ? ' interrupted' : ''}`}>{error ? '更新中断 · 正在重连' : loaded ? '每 3 秒同步活动' : '正在连接会话…'}</span><div className="workspace-heading-actions"><button className="btn primary" onClick={onNew}>＋ 新建会话</button>{onPhone && <button className="btn sm" onClick={onPhone}>手机访问</button>}</div></header>
    {unavailable.length > 0 && <div className="connection-note">{unavailable.join('、')} 的实时活动暂不可用，保留最后一次记录。</div>}
    <div className="workspace-toolbar"><div className="views">{[['all', '最近会话', rows.length], ['running', '进行中', running.length], ['unread', '未读回复', unread.length]].map(([key,label,n]) => <button key={key} className={filter === key ? 'on' : ''} onClick={() => setFilter(String(key))}>{label} <span className="mono">{n}</span></button>)}</div><label className="search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索最近会话…" /></label></div>
    {!loaded && <div className="empty">首次读取最近的会话，之后只同步新增内容。</div>}
    {loaded && list.length === 0 && <div className="empty">{filter === 'unread' ? '没有未读回复' : filter === 'running' ? '当前没有正在执行的会话' : '没有匹配的最近会话'}<button className="link" onClick={onSessions}>查看全部会话</button></div>}
    <ConversationRows rows={list} me={me} onOpen={onOpen} />
    {filtered.length > limit && <button className="load-more-conversations" onClick={() => setLimit(n => n+20)}>显示更多会话 · 还有 {filtered.length-limit} 个</button>}
    <div className="workspace-footer"><button className="link" onClick={onSessions}>全部会话 →</button><button className="link" onClick={onInbox}>查看等我的事项 →</button></div>
    {activeTasks.length > 0 && <details className="workspace-tasks"><summary>进行中的任务 · {activeTasks.length}</summary>{activeTasks.map(i => <button key={i.id} onClick={() => onTask(i.id)}><span>{i.title}</span><span className="muted mono">{i.id} →</span></button>)}</details>}
  </div>;
}
