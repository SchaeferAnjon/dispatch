import { describe, expect, it } from 'vitest';
import { canReadReply, activityKey } from './activity';
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
