import { describe, expect, it } from 'vitest';
import { newSessionTarget, ownerHostId, parseProjectOwners, PROJECT_OWNERS_KEY } from './projectFlags';

const hosts = [
  { id: 'local', name: '大哥', local: true, aliases: [], ip: '100.85.245.72' },
  { id: 'apple-mac-mini', name: 'Apple', local: false, aliases: ['Apple的Mac mini'], ip: '100.118.80.86' },
];

describe('project owner — which Mac a handed-over project lives on', () => {
  it('parses the shared memory the CLI writes and ignores junk', () => {
    const m = [{ key: PROJECT_OWNERS_KEY, value: JSON.stringify({ atrium: { host: 'Apple', ip: '100.118.80.86', at: 1 }, bad: { host: '' }, x: 3 }) }];
    expect(parseProjectOwners(m as never)).toEqual({ atrium: { host: 'Apple', ip: '100.118.80.86', at: 1 } });
    expect(parseProjectOwners([{ key: PROJECT_OWNERS_KEY, value: '{' }] as never)).toEqual({});
  });

  it('resolves the owner by name, old name or IP, and this Mac as local', () => {
    expect(ownerHostId({ host: 'Apple', ip: '', at: 0 }, hosts)).toBe('apple-mac-mini');
    expect(ownerHostId({ host: 'Apple的Mac mini', ip: '', at: 0 }, hosts)).toBe('apple-mac-mini');
    expect(ownerHostId({ host: 'renamed', ip: '100.85.245.72', at: 0 }, hosts)).toBe('local');
    expect(ownerHostId(undefined, hosts)).toBeUndefined();
  });

  it('new sessions open on the owner, with the folder under that Mac\'s home', () => {
    const ctx = { host: 'local', cwd: '/Users/macbook14/Projects/atrium' };
    expect(newSessionTarget('apple-mac-mini', ctx, 'local')).toEqual({ initialHost: 'apple-mac-mini', initialCwd: '~/Projects/atrium' });
    expect(newSessionTarget('local', ctx, 'local')).toEqual({ initialHost: 'local', initialCwd: '/Users/macbook14/Projects/atrium' });
    expect(newSessionTarget(undefined, undefined, 'local')).toEqual({ initialHost: 'local', initialCwd: undefined });
    expect(newSessionTarget('apple-mac-mini', { host: 'local', cwd: '/opt/x' }, 'local')).toEqual({ initialHost: 'apple-mac-mini', initialCwd: undefined });
  });
});
