import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmAction } from './confirm';

afterEach(() => vi.unstubAllGlobals());

describe('confirmation before a destructive action', () => {
  it('uses the allowed message IPC and waits for the native Cancel result', async () => {
    let answer!: (value: string) => void;
    const invoke = vi.fn(() => new Promise<string>(resolve => { answer = resolve; }));
    const legacy = vi.fn(() => { throw new Error('legacy confirm must not run'); });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke }, confirm: legacy });
    const action = vi.fn();
    const flow = (async () => { if (await confirmAction('迁移项目？')) action(); })();
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|message', expect.objectContaining({ message: '迁移项目？', buttons: { OkCancelCustom: ['确认', '取消'] } }), undefined);
    expect(action).not.toHaveBeenCalled();
    answer('取消');
    await flow;
    expect(action).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('accepts the native confirm result', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: vi.fn().mockResolvedValue('确认') } });
    expect(await confirmAction('迁移项目？')).toBe(true);
  });

  it('propagates native failures so the caller can report them without proceeding', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: vi.fn().mockRejectedValue(new Error('ACL rejected')) } });
    await expect(confirmAction('迁移项目？')).rejects.toThrow('ACL rejected');
  });

  it.each([true, false])('keeps browser confirmation result %s', async result => {
    const confirm = vi.fn(() => result);
    vi.stubGlobal('window', { confirm });
    expect(await confirmAction('迁移项目？')).toBe(result);
    expect(confirm).toHaveBeenCalledWith('迁移项目？');
  });
});
