import type { Activity } from './types';

export const activityKey = (a: Activity) => `${a.host ?? 'local'}:${a.key}`;
export function activityLabel(a: Activity) {
  if (a.stale) return '活动已暂停更新';
  if (a.state === 'working') return '进行中';
  return a.unread ? '未读回复' : '本轮结束';
}
export function canReadReply(a: Activity | undefined, reply: string | undefined, atLatest: boolean, visible: boolean, timeline: boolean) {
  return Boolean(a?.unread && reply && a.reply_id === reply && atLatest && visible && timeline);
}

// A transcript is evidence of a running conversation, not proof of which PID owns it.
export function mergeActivity(presence: import('./types').Presence, rows: Activity[]): import('./types').Presence {
  const sessions = presence.sessions.map(s => {
    const a = rows.find(a => a.session_id === s.session_id && (a.host ?? 'local') === (s.host ?? 'local'));
    return a && a.last_at >= s.last_at ? { ...s, title: a.title, state: a.stale ? 'unknown' as const : a.state === 'working' ? 'working' as const : 'idle' as const, last_at: a.last_at, state_source: 'transcript' as const } : s;
  });
  for (const a of rows) {
    if (a.stale || a.state !== 'working' || sessions.some(s => s.session_id === a.session_id && (s.host ?? 'local') === (a.host ?? 'local'))) continue;
    sessions.push({ agent:a.agent, session_id:a.session_id, title:a.title, cwd:a.cwd, project:a.project, agent_pid:null, source_kind:'unknown', source_app:'会话记录', entrypoint:'', started_at:0, last_at:a.last_at, state:'working', prompts:0, alive:true, registered:true, state_source:'transcript', host:a.host,host_name:a.host_name,remote:a.remote });
  }
  return { ...presence, sessions };
}
