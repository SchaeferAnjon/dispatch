import { describe, expect, it } from 'vitest';
import { dropMovedOriginals } from './moves';

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
