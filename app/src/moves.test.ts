import { describe, expect, it } from 'vitest';
import { dropMovedOriginals, migrationCheckPrompt } from './moves';

describe('dropMovedOriginals — a moved conversation shows once, where it lives now', () => {
  const original = { session_id: 's1', host: 'local', moved_to: 'apple-mac-mini' };
  const copy = { session_id: 's1', host: 'apple-mac-mini', remote: true, moved_from: 'hub' };
  const other = { session_id: 's2', host: 'local' };

  it('drops the original once the copy on the other Mac is listed', () => {
    expect(dropMovedOriginals([original, copy, other])).toEqual([copy, other]);
  });

  it('works from the other Mac too (the original is the remote row there)', () => {
    const remoteOriginal = { session_id: 's1', host: 'hub', remote: true, moved_to: 'apple-mac-mini' };
    const localCopy = { session_id: 's1', host: 'local', moved_from: 'hub' };
    expect(dropMovedOriginals([localCopy, remoteOriginal])).toEqual([localCopy]);
  });

  it('keeps a lone original while the other Mac is offline', () => {
    expect(dropMovedOriginals([original, other])).toEqual([original, other]);
  });
});

// The handoff must carry the actual preflight, without granting permission to overwrite it.
it('prepares a read-only migration check with both machines and all conflicts', () => {
  const prompt = migrationCheckPrompt({ project: 'demo', host: 'local', cwd: '/Users/a/demo', target: 'Apple', remoteCwd: '/Users/b/demo', conflicts: ['独有提交 abc123', '未提交文件 src/main.ts'] });
  for (const text of ['demo', '/Users/a/demo', 'Apple', '/Users/b/demo', '独有提交 abc123', '未提交文件 src/main.ts', '只读检查', '不要执行迁移', '等用户决定']) expect(prompt).toContain(text);
});
