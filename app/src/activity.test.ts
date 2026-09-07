import { describe, expect, it } from 'vitest';
import { canReadReply, activityKey, conversationSummary, conversationProject } from './activity';
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
    expect(conversationProject({...a, cwd:'/Users/apple/Projects/kanban', project:'kanban'})).toBe('kanban');
    expect(conversationProject({...a, cwd:'/Users/apple/Projects/relecture/app', project:'app'})).toBe('relecture');
  });
});
