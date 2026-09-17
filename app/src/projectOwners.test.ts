import { describe, expect, it } from 'vitest';
import { newSessionTarget, ownerHostId, parseProjectOwners, PROJECT_OWNERS_KEY } from './projectFlags';

const hosts = [
  { id: 'local', name: '书房的 Mac', local: true, aliases: [], ip: '100.64.0.1' },
  { id: 'living-room-mini', name: 'Apple', local: false, aliases: ['客厅的 Mac mini'], ip: '100.64.0.2' },
];

describe('project owner — which Mac a handed-over project lives on', () => {
  it('parses the shared memory the CLI writes and ignores junk', () => {
    const m = [{ key: PROJECT_OWNERS_KEY, value: JSON.stringify({ notesapp: { host: 'Apple', ip: '100.64.0.2', at: 1 }, bad: { host: '' }, x: 3 }) }];
    expect(parseProjectOwners(m as never)).toEqual({ notesapp: { host: 'Apple', ip: '100.64.0.2', at: 1 } });
    expect(parseProjectOwners([{ key: PROJECT_OWNERS_KEY, value: '{' }] as never)).toEqual({});
  });

  it('resolves the owner by name, old name or IP, and this Mac as local', () => {
    expect(ownerHostId({ host: 'Apple', ip: '', at: 0 }, hosts)).toBe('living-room-mini');
    expect(ownerHostId({ host: '客厅的 Mac mini', ip: '', at: 0 }, hosts)).toBe('living-room-mini');
    expect(ownerHostId({ host: 'renamed', ip: '100.64.0.1', at: 0 }, hosts)).toBe('local');
    expect(ownerHostId(undefined, hosts)).toBeUndefined();
  });

  it('new sessions open on the owner, with the folder under that Mac\'s home', () => {
    const ctx = { host: 'local', cwd: '/Users/alice/Projects/notesapp' };
    expect(newSessionTarget('living-room-mini', ctx, 'local')).toEqual({ initialHost: 'living-room-mini', initialCwd: '~/Projects/notesapp' });
    expect(newSessionTarget('local', ctx, 'local')).toEqual({ initialHost: 'local', initialCwd: '/Users/alice/Projects/notesapp' });
    expect(newSessionTarget(undefined, undefined, 'local')).toEqual({ initialHost: 'local', initialCwd: undefined });
    expect(newSessionTarget('living-room-mini', { host: 'local', cwd: '/opt/x' }, 'local')).toEqual({ initialHost: 'living-room-mini', initialCwd: undefined });
  });
});
