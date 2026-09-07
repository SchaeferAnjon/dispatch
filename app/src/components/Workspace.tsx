import { type ReactNode, useState } from 'react';
import { activityKey, activityLabel, conversationProject, conversationSummary } from '../activity';
import { actorOf, durSince } from '../derive';
import type { Activity } from '../types';
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
