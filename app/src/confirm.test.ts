import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmAction } from './confirm';

afterEach(() => vi.unstubAllGlobals());

describe('confirmation before a destructive action', () => {
  it.each([true, false])('keeps browser confirmation result %s', async result => {
    const confirm = vi.fn(() => result);
    vi.stubGlobal('window', { confirm });
    expect(await confirmAction('迁移项目？')).toBe(result);
    expect(confirm).toHaveBeenCalledWith('迁移项目？');
  });
});
