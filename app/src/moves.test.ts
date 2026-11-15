import { describe, expect, it } from 'vitest';
import { foldHostCopies, migrationCheckPrompt, refMap } from './moves';

type Row = { session_id: string; host?: string; host_name?: string; remote?: boolean; last_at?: number; last_ts?: string; unread?: boolean; moved_to?: string; moved_to_name?: string; moved_from?: string; moved_from_name?: string; moved_at?: number };

describe('foldHostCopies: a moved conversation shows once, where it lives now', () => {
  const original = { session_id: 's1', host: 'local', host_name: '小蓝', moved_to: 'mini', moved_to_name: 'Apple', last_at: 100 };
  const copy = { session_id: 's1', host: 'mini', host_name: 'Apple', remote: true, moved_from: 'hub', moved_from_name: '小蓝', last_at: 200 };
  const other = { session_id: 's2', host: 'local', last_at: 50 };

  it('folds the original under the copy on the other Mac', () => {
    expect(foldHostCopies([original, copy, other])).toEqual([{ ...copy, copies: [{ host: 'local', host_name: '小蓝', last_at: 100, moved_to_name: 'Apple' }] }, other]);
  });

  it('works from the other Mac too (the original is the remote row there)', () => {
    const remoteOriginal = { session_id: 's1', host: 'hub', host_name: '小蓝', remote: true, moved_to: 'mini', moved_to_name: 'Apple', last_at: 100 };
    const localCopy = { session_id: 's1', host: 'local', host_name: 'Apple', moved_from: 'hub', moved_from_name: '小蓝', last_at: 200 };
    const out = foldHostCopies([localCopy, remoteOriginal]);
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe('local'); expect(out[0].copies?.[0].host).toBe('hub');
  });

  it('hides a lone original while the other Mac is offline, and leaves unrelated rows as they are', () => {
    expect(foldHostCopies([{ ...original, unread: true }, other])).toEqual([other]);
    const rows = [other, { session_id: 's3', host: 'local', last_at: 9 }];
    expect(foldHostCopies(rows)).toBe(rows);
  });

  it('a lone original that runs, or went on after the move, stays (the latter with a warning)', () => {
    expect(foldHostCopies([original], () => true)).toEqual([original]);
    const wentOn = { ...original, moved_at: 1000, last_at: 1000 + 3 * 3600 };
    expect(foldHostCopies([wentOn])).toEqual([{ ...wentOn, forked: ['Apple'] }]);
    expect(foldHostCopies([{ ...wentOn, last_at: 1010 }])).toEqual([]);
  });

  it('twins: unread stays on one row even when the winner has none (2b529323)', () => {
    const mb = { session_id: 's1', host: 'local', host_name: '小蓝', moved_from: 'mini', moved_from_name: 'Apple', last_at: 300, unread: false };
    const apple = { session_id: 's1', host: 'mini', host_name: 'Apple', remote: true, moved_to: 'hub', moved_to_name: '小蓝', last_at: 200, unread: true };
    const out = foldHostCopies([mb, apple], () => true);
    expect(out.map((r) => [r.host, r.unread, r.twin_live])).toEqual([['local', false, ['Apple']], ['mini', true, ['小蓝']]]);
    const both = foldHostCopies([{ ...mb, unread: true }, apple], () => true);
    expect(both.filter((r) => r.unread).map((r) => r.host)).toEqual(['local']);
  });

  it('the original went on after the move: both stay, each names the other, unread once', () => {
    // 2b529323 once pid 82632 is closed: moved 09-24 16:10, the Mini copy then wrote until 09-25 02:55.
    const at = 1790259026;
    const mb = { session_id: 's1', host: 'local', host_name: '小蓝', moved_from: 'mini', moved_from_name: 'Apple', moved_at: at, last_at: 1790328070 };
    const apple = { session_id: 's1', host: 'mini', host_name: 'Apple', remote: true, moved_to: 'hub', moved_to_name: '小蓝', moved_at: at, last_at: 1790297750, unread: true };
    const out = foldHostCopies<Row>([mb, apple]);
    expect(out.map((r) => [r.host, r.forked, r.copies, r.unread])).toEqual([['local', ['Apple'], undefined, undefined], ['mini', ['小蓝'], undefined, true]]);
    // Stopped before the move: folded as usual.
    expect(foldHostCopies([mb, { ...apple, last_at: at - 60 }]).map((r) => r.host)).toEqual(['local']);
  });

  it('two moved_to records: the newer one counts (A to B and back to A, second half missing on A)', () => {
    const mb = { session_id: 's1', host: 'local', host_name: '小蓝', moved_to: 'mini', moved_to_name: 'Apple', moved_at: 1000, last_at: 300 };
    const apple = { session_id: 's1', host: 'mini', host_name: 'Apple', remote: true, moved_to: 'hub', moved_to_name: '小蓝', moved_at: 4600, last_at: 200 };
    const [w, ...rest] = foldHostCopies<Row>([mb, apple]);
    expect(rest).toEqual([]);
    expect([w.host, w.moved_to_name, w.moved_from_name, w.copies]).toEqual(['local', undefined, 'Apple', [{ host: 'mini', host_name: 'Apple', last_at: 200, moved_to_name: '小蓝' }]]);
    // Without times (a peer on an older CLI) the copy that said something last took over.
    const noAt = foldHostCopies<Row>([{ ...mb, moved_at: undefined }, { ...apple, moved_at: undefined }]);
    expect(noAt.map((r) => [r.host, r.moved_to_name, r.moved_from_name])).toEqual([['local', undefined, 'Apple']]);
  });

  it('no records and nothing to tell them apart: both stay, untagged, unread once', () => {
    const a = { session_id: 's1', host: 'local', host_name: '小蓝', last_at: 500, unread: true };
    const b = { session_id: 's1', host: 'mini', host_name: 'Apple', remote: true, last_at: 500, unread: true };
    const out = foldHostCopies<Row>([a, b]);
    expect(out.map((r) => [r.host, r.moved_from_name, r.copies, r.unread])).toEqual([['local', undefined, undefined, true], ['mini', undefined, undefined, false]]);
  });

  it('prefers the transcript time over the file time', () => {
    const a = { session_id: 's1', host: 'local', last_at: 9_999_999_999, last_ts: '2026-09-25T00:55:50Z' };
    const b = { session_id: 's1', host: 'mini', last_at: 1790328070 };
    expect(foldHostCopies([a, b]).map((r) => r.host)).toEqual(['mini']);
  });

  it('without any record the newest copy wins, says where it came from, and only its unread counts', () => {
    const stale = { session_id: 's1', host: 'mini', host_name: 'Apple', remote: true, last_at: 100, unread: true };
    const later = { session_id: 's1', host: 'local', host_name: '小蓝', last_at: 300, unread: false };
    const out = foldHostCopies([stale, later]);
    expect(out).toEqual([{ ...later, moved_from_name: 'Apple', copies: [{ host: 'mini', host_name: 'Apple', last_at: 100 }] }]);
    expect(out.filter((r) => r.unread)).toHaveLength(0);
  });

  it('a running copy wins over a newer one that is not running', () => {
    const running = { session_id: 's1', host: 'mini', host_name: 'Apple', last_at: 100 };
    const newer = { session_id: 's1', host: 'local', host_name: '小蓝', last_at: 300 };
    const out = foldHostCopies([running, newer], (r) => r.host === 'mini');
    expect(out.map((r) => r.host)).toEqual(['mini']);
  });

  it('running on both Macs: both stay with a warning naming the other, unread shown once', () => {
    // The 2b529323 case: moved to 小蓝, then `claude --resume` on the Mini again. Both processes live.
    const mini = { ...original, host: 'mini', host_name: 'Apple', remote: true, moved_to: 'hub', moved_to_name: '小蓝', unread: true };
    const here = { ...copy, host: 'local', host_name: '小蓝', remote: false, moved_from: 'mini', moved_from_name: 'Apple', unread: true };
    const out = foldHostCopies([mini, here], () => true);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.host === 'mini')?.twin_live).toEqual(['小蓝']);
    expect(out.find((r) => r.host === 'local')?.twin_live).toEqual(['Apple']);
    expect(out.filter((r) => r.unread).map((r) => r.host)).toEqual(['local']);
  });

  it('never merges bare process ids or two rows of the same Mac', () => {
    const rows = [{ session_id: 'pid-12', host: 'local', last_at: 1 }, { session_id: 'pid-12', host: 'mini', last_at: 2 }, { session_id: 's3', host: 'local', last_at: 1 }, { session_id: 's3', host: 'local', last_at: 2 }];
    expect(foldHostCopies(rows)).toBe(rows);
  });

  it('refMap keys this Mac first by bare id, another Mac by id@host', () => {
    const m = refMap([{ session_id: 's1', host: 'mini', remote: true }, { session_id: 's1', host: 'local' }]);
    expect([...m.keys()]).toEqual(['s1', 's1@mini']);
    expect(m.get('s1')?.host).toBe('local');
  });
});

// The handoff must carry the actual preflight, without granting permission to overwrite it.
it('prepares a read-only migration check with both machines and all conflicts', () => {
  const prompt = migrationCheckPrompt({ project: 'demo', host: 'local', cwd: '/Users/a/demo', target: 'Apple', remoteCwd: '/Users/b/demo', conflicts: ['独有提交 abc123', '未提交文件 src/main.ts'] });
  for (const text of ['demo', '/Users/a/demo', 'Apple', '/Users/b/demo', '独有提交 abc123', '未提交文件 src/main.ts', '只读检查', '不要执行迁移', '等用户决定']) expect(prompt).toContain(text);
});
