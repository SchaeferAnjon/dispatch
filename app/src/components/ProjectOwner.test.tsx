import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectHub, projectPlace } from './ProjectHub';
import { projectGroups } from '../projectModel';
import type { Activity, Host } from '../types';
import type { Api } from '../api';

afterEach(() => vi.unstubAllGlobals());

const rows = [{ project: 'kanban', host: 'hub', cwd: '/Users/alice/Projects/kanban', last_at: 1, session_id: 'old', agent: 'codex', tasks: [] }] as unknown as Activity[];
const hosts = [{ id: 'local', name: 'Apple', local: true, online: true }, { id: 'hub', name: '阁楼的 Mac', online: true }] as Host[];
const owners = { kanban: { host: 'Apple', ip: '', at: 2 } };

// The terminal button and 迁移到 now live in the window header (useShellHeader) and the 项目操作
// menu, so the target they use is checked through projectPlace, which both read.
it('opens the terminal on Apple and offers migration to 阁楼的 Mac even when history mostly lives on 阁楼的 Mac', () => {
  const project = projectGroups(rows, [], [], {}).find((p) => p.name === 'kanban')!;
  const term = projectPlace({ project, flags: {}, owners, hosts, home: '', canMove: true });
  expect(term.machine).toBe('Apple');
  // Moving to another Mac's owner turns the folder into a home-relative path.
  expect(term.cwd).toBe('~/Projects/kanban');
  expect(term.moveTargets.map((h) => h.name)).toEqual(['阁楼的 Mac']);
  expect(projectPlace({ project, flags: {}, owners, hosts, home: '', canMove: false }).moveTargets).toEqual([]);
  // An offline Mac stays listed so the menus can grey it out with the reason instead of hiding it.
  const offline = hosts.map((h) => (h.local ? h : { ...h, online: false }));
  expect(projectPlace({ project, flags: {}, owners, hosts: offline, home: '', canMove: true }).moveTargets.map((h) => [h.name, !!h.online])).toEqual([['阁楼的 Mac', false]]);
});

it('lists the project folder under 资料 → 目录', () => {
  vi.stubGlobal('location', { search: '?section=folders' });
  const noop = () => {};
  const html = renderToStaticMarkup(<ProjectHub
    rows={rows} tasks={[]} outcomes={[]} selected="kanban" me="user" api={{} as Api}
    owners={owners} hosts={hosts}
    flags={{}} archiveDays={30} connectionError={false} unavailable={[]} loaded
    onFlag={noop} onProject={noop} onOpen={noop} onTask={noop} onRead={async () => {}}
    onReload={noop} onNew={noop} onMoveProject={async () => {}}
  />);
  expect(html).toContain('~/Projects/kanban');
  expect(html).toContain('在此目录新建会话');
});
