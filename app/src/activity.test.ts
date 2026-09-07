import { describe, expect, it } from 'vitest';
import { canReadReply, activityKey, conversationSummary, conversationProject, mergeActivity, resolveProject } from './activity';
import type { Activity } from './types';
const a = { key: 'codex:id', host:'local', unread:true, reply_id:'2:reply' } as Activity;
describe('read cursor', () => {
  it('acknowledges only the reply rendered and visible at the end', () => {
    expect(canReadReply(a, '2:reply', true, true, true)).toBe(true);
    expect(canReadReply(a, '1:old', true, true, true)).toBe(false);
    expect(canReadReply(a, '2:reply', false, true, true)).toBe(false);
    expect(canReadReply(a, '2:reply', true, false, true)).toBe(false);
    expect(canReadReply(a, '2:reply', true, true, false)).toBe(false);
  });
  it('keeps identities separate across machines', () => {
    expect(activityKey(a)).not.toBe(activityKey({...a,host:'mini'}));
  });
});

describe('conversation context', () => {
  it('extracts a readable sentence from markdown', () => {
    expect(conversationSummary({...a, reply_preview:'**已更新桌面应用。** 下一步检查手机。'})).toBe('已更新桌面应用。 下一步检查手机。');
  });
  it('extracts headlines from complete and truncated structured replies', () => {
    expect(conversationSummary({...a, reply_preview:'{"headline_cn":"市场日报","items":[]}'})).toBe('市场日报');
    expect(conversationSummary({...a, reply_preview:'{"headline_cn":"市场日报","items":['})).toBe('市场日报');
    expect(conversationSummary({...a, reply_preview:'{"items":['})).toBe('已收到结构化结果，打开会话查看详情。');
  });
  it('limits preview length and distinguishes a home folder from a project', () => {
    expect(conversationSummary({...a, reply_preview:'长'.repeat(200)})).toHaveLength(110);
    expect(conversationProject({...a, cwd:'/Users/apple', project:'apple'})).toBe('未关联项目');
    expect(conversationProject({...a,cwd:'/Users/apple',project:'apple',project_override:'日报'})).toBe('日报');
    expect(conversationProject({...a, cwd:'/Users/apple/Projects/kanban', project:'kanban'})).toBe('kanban');
    expect(conversationProject({...a, cwd:'/Users/apple/Projects/relecture/app', project:'app'})).toBe('relecture');
  });
});

describe('project resolution', () => {
  const at = (cwd: string, project = cwd.split('/').filter(Boolean).slice(-1)[0] || '') => ({ cwd, project });
  it('follows one precedence: override, home, ~/Projects, known board name, leaf folder', () => {
    expect(resolveProject({ ...at('/Users/x'), project_override: '日报' })).toBe('日报');
    expect(resolveProject(at('/Users/x'))).toBe('未关联项目');
    expect(resolveProject(at('/Users/x/Projects/kanban/app/src'))).toBe('kanban');
    expect(resolveProject(at('/Users/x/workspace/HIWI/notes'), ['hiwi'])).toBe('hiwi');
    expect(resolveProject(at('/Users/x/workspace/HIWI/notes'))).toBe('notes');
    expect(resolveProject(at('/Users/x/Documents/thesis/'))).toBe('thesis');
  });
});

describe('presence merge', () => {
  it('carries the scheduled flag so counts can exclude timer-driven sessions', () => {
    const now = Date.now() / 1000;
    const live = { agent: 'codex', session_id: 's1', cwd: '/w', project: 'w', title: 't', last_at: now, state: 'working', stale: false, scheduled: true, key: 'codex:s1' } as unknown as Activity;
    const presence = { sessions: [{ agent: 'codex', session_id: 's1', last_at: now - 100, state: 'idle', alive: true, registered: true } as never], apps: [] };
    const merged = mergeActivity(presence, [live]);
    expect(merged.sessions[0]).toMatchObject({ state: 'working', scheduled: true });
    expect(mergeActivity({ sessions: [], apps: [] }, [live]).sessions[0]).toMatchObject({ scheduled: true, alive: true });
  });
});
