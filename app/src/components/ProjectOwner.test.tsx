import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectHub } from './ProjectHub';
import type { Activity, Host } from '../types';
import type { Api } from '../api';

afterEach(() => vi.unstubAllGlobals());

it('shows Apple and offers migration to 大哥 even when history mostly lives on 大哥', () => {
  vi.stubGlobal('location', { search: '' });
  const noop = () => {};
  const rows = [{ project: 'kanban', host: 'hub', cwd: '/Users/macbook14/Projects/kanban', last_at: 1, session_id: 'old', agent: 'codex', tasks: [] }] as unknown as Activity[];
  const html = renderToStaticMarkup(<ProjectHub
    rows={rows} tasks={[]} outcomes={[]} selected="kanban" me="user" api={{} as Api}
    owners={{ kanban: { host: 'Apple', ip: '', at: 2 } }}
    hosts={[{ id: 'local', name: 'Apple', local: true, online: true }, { id: 'hub', name: '大哥', online: true }] as Host[]}
    flags={{}} archiveDays={30} connectionError={false} unavailable={[]} loaded
    onFlag={noop} onProject={noop} onOpen={noop} onTask={noop} onRead={async () => {}}
    onReload={noop} onNew={noop} onMoveProject={async () => {}}
  />);
  expect(html).toContain('>Apple</span>');
  expect(html).toContain('终端 · Apple');
  expect(html).toContain('迁移到 大哥');
  expect(html).not.toContain('迁移到 Apple');
  expect(html).toContain('~/Projects/kanban');
});
