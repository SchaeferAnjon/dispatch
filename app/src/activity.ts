import type { Activity } from './types';

export const activityKey = (a: Activity) => `${a.host ?? 'local'}:${a.key}`;

// Transcripts a parent conversation spawned (Claude Code sub-agents) are part of
// that conversation, not conversations of their own.
export const isSubagentSession = (r: { path?: string }) => /\/subagents\//.test(r.path ?? '');
// Sessions another program started through the SDK (scripts, schedulers, agents
// driving agents): real conversations, but noise in a list meant for the user's own.
// A discussion participant's session (dispatch discuss): the prompt names the topic task. It is
// machinery, not a conversation with the user, so it stays out of 等我, the workbench and notifications.
export const isDiscussionSession = (r: { title?: string }) => /(^|「)(你是「[^」]*」，)?你?参加(主题|任务) task-[a-z0-9]{3,4}|^【讨论】/.test(r.title ?? '');
export const isScriptSession = (r: { path?: string; entrypoint?: string; title?: string }) => isSubagentSession(r) || /^sdk/.test(r.entrypoint ?? '') || isDiscussionSession(r);

// A conversation is either tracked (★, never fades), ordinary (fades into the
// archive after `days` without activity) or archived (by hand or by time).
export type Lifecycle = 'starred' | 'active' | 'archived';
export const DEFAULT_ARCHIVE_DAYS = 30;
export function sessionLifecycle(a: { starred?: boolean; archived?: boolean; last_at: number }, days = DEFAULT_ARCHIVE_DAYS, now = Date.now() / 1000): Lifecycle {
  if (a.archived) return 'archived';
  if (a.starred) return 'starred';
  return days > 0 && a.last_at > 0 && now - a.last_at > days * 86_400 ? 'archived' : 'active';
}

// Extract a short quotation from available conversation text, without inventing
// an AI summary or showing serialized tool payloads as prose.
export function conversationSummary(a: Activity): string {
  if (a.summary) return a.summary;
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

export const UNGROUPED_PROJECT = '零散会话';

// The one rule for which project a conversation belongs to. Precedence: what the
// user set by hand; a home-directory chat belongs to nothing; anything under a
// workspace root (~/Projects/<x>/… is <x>; roots come from settings); a path
// segment that names a project already on the board (case-insensitive) wins over
// the leaf folder; otherwise the index's guess (the git repo root) or the leaf folder.
export const DEFAULT_ROOTS = ['~/Projects'];
export function resolveProject(a: { cwd: string; project: string; project_override?: string }, known: Iterable<string> = [], roots: string[] = DEFAULT_ROOTS): string {
  if (a.project_override) return a.project_override;
  const cwd = (a.cwd || '').replace(/\/+$/, '');
  if (!cwd || /^\/(?:Users|home)\/[^/]+$/.test(cwd)) return UNGROUPED_PROJECT;
  const home = cwd.match(/^\/(?:Users|home)\/[^/]+/)?.[0] ?? '';
  for (const r of roots) {
    const root = (r.startsWith('~') ? home + r.slice(1) : r).replace(/\/+$/, '');
    if (root && cwd.startsWith(root + '/')) { const name = cwd.slice(root.length + 1).split('/')[0]; if (name) return name; }
  }
  const names = new Map<string, string>();
  for (const n of known) if (n) names.set(n.toLowerCase(), n);
  const parts = cwd.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) { const hit = names.get(parts[i].toLowerCase()); if (hit) return hit; }
  return a.project || parts[parts.length - 1] || UNGROUPED_PROJECT;
}
export function conversationProject(a: Activity): string { return resolveProject(a); }
export function activityLabel(a: Activity) {
  if (a.stale) return '活动已暂停更新';
  if (a.state === 'working') return '进行中';
  return a.unread ? '未读回复' : '本轮结束';
}
/** One line for a list row: only what adds information. A finished, read turn says nothing; a stale
 *  "still working" record never claims to be processing your message. */
export function activityLine(a: Activity): string {
  if (a.stale) return a.state === 'working' ? '记录已停止更新（最后在处理时中断）' : '';
  if (a.state === 'working') return a.activity ? `进行中 · ${a.activity}` : '进行中';
  return a.unread ? '未读回复' : '';
}
export function canReadReply(a: Activity | undefined, reply: string | undefined, atLatest: boolean, visible: boolean, timeline: boolean) {
  return Boolean(a?.unread && reply && a.reply_id === reply && atLatest && visible && timeline);
}

// A transcript is evidence of a running conversation, not proof of which PID owns it.
export function mergeActivity(presence: import('./types').Presence, rows: Activity[]): import('./types').Presence {
  const sessions = presence.sessions.map(s => {
    const a = rows.find(a => a.session_id === s.session_id && (a.host ?? 'local') === (s.host ?? 'local'));
    if (!a) return s;
    const merged = a.last_at >= s.last_at ? { ...s, title: a.title, state: a.stale ? 'unknown' as const : a.state === 'working' ? 'working' as const : 'idle' as const, last_at: a.last_at, state_source: 'transcript' as const } : s;
    // The files the conversation wrote travel with the session, so the Agents view can show them.
    const withFiles = a.files ? { ...merged, files: a.files } : merged;
    // The user's classification travels with the session so every count treats it the same way.
    return a.scheduled ? { ...withFiles, scheduled: true } : withFiles;
  });
  for (const a of rows) {
    if (a.stale || a.state !== 'working' || sessions.some(s => s.session_id === a.session_id && (s.host ?? 'local') === (a.host ?? 'local'))) continue;
    sessions.push({ agent:a.agent, session_id:a.session_id, title:a.title, cwd:a.cwd, project:a.project, agent_pid:null, source_kind:'unknown', source_app:'会话记录', entrypoint:'', started_at:0, last_at:a.last_at, state:'working', prompts:0, alive:true, registered:true, state_source:'transcript', host:a.host,host_name:a.host_name,remote:a.remote, scheduled:a.scheduled||undefined, files:a.files });
  }
  return { ...presence, sessions };
}

export const EDIT_WINDOW_S = 30 * 60;

// Files a session touched inside the window, newest first, merging the hook registry
// (`editing`, already windowed by the CLI) with the transcript snapshot (`files`).
export function recentEdits(s: { editing?: { path: string; ts: number }[]; files?: Record<string, number> }, now = Date.now() / 1000): { path: string; at: number }[] {
  const by = new Map<string, number>();
  for (const [path, at] of Object.entries(s.files ?? {})) if (now - at <= EDIT_WINDOW_S) by.set(path, Math.max(by.get(path) ?? 0, at));
  for (const e of s.editing ?? []) by.set(e.path, Math.max(by.get(e.path) ?? 0, e.ts));
  return [...by].map(([path, at]) => ({ path, at })).sort((a, b) => b.at - a.at);
}

// Absolute paths more than one session touched recently: the edits that will actually clash.
export function conflictingFiles(sessions: { session_id: string; editing?: { path: string; ts: number }[]; files?: Record<string, number> }[], now = Date.now() / 1000): Set<string> {
  const by = new Map<string, Set<string>>();
  for (const s of sessions) for (const { path } of recentEdits(s, now)) { const ids = by.get(path) ?? new Set<string>(); ids.add(s.session_id); by.set(path, ids); }
  return new Set([...by].filter(([, ids]) => ids.size > 1).map(([path]) => path));
}
