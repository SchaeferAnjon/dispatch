import type { Activity } from './types';

export const activityKey = (a: Activity) => `${a.host ?? 'local'}:${a.key}`;

// Extract a short quotation from available conversation text, without inventing
// an AI summary or showing serialized tool payloads as prose.
export function conversationSummary(a: Activity): string {
  let text = (a.reply_preview || a.activity || '').trim();
  const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (/^[{[]/.test(raw)) {
    const fields = ['headline_cn', 'summary', 'summary_cn', 'description', 'title'];
    let found = '';
    try {
      const obj = JSON.parse(raw);
      found = fields.map(k => obj?.[k]).find(v => typeof v === 'string') || '';
    } catch {
      // Previews can end in the middle of a JSON object; decode a complete
      // human-readable field only, never display the remaining raw structure.
      for (const key of fields) {
        const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")'));
        if (m) { try { found = JSON.parse(m[1]); break; } catch { /* next field */ } }
      }
    }
    if (!found) return '已收到结构化结果，打开会话查看详情。';
    text = found;
  }
  text = text.replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^[\s#>*-]+/gm, '').replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!text) return '暂时没有可用摘要，打开会话查看记录。';
  const sentence = text.match(/^.*?[。！？][”’"]?/u)?.[0]?.trim();
  const result = sentence && sentence.length >= 12 ? sentence : text;
  return result.length > 110 ? result.slice(0, 109) + '…' : result;
}

export function conversationProject(a: Activity): string {
  if (/^\/(?:Users|home)\/[^/]+\/?$/.test(a.cwd)) return '未关联项目';
  const workspace = a.cwd.match(/^\/(?:Users|home)\/[^/]+\/Projects\/([^/]+)/)?.[1];
  return workspace && a.project === a.cwd.split('/').filter(Boolean).slice(-1)[0] ? workspace : a.project || '未关联项目';
}
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
