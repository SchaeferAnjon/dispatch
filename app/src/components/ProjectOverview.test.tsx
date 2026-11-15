import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectHub } from './ProjectHub';
import type { Activity } from '../types';
import type { Api } from '../api';

afterEach(() => vi.unstubAllGlobals());

const rows = [
  { project: 'TUTOR', host: 'local', cwd: '/Users/alice/Projects/TUTOR', last_at: Date.now() / 1000 - 60, session_id: 's-rag', agent: 'claude-code', title: 'RAG vs agentic search feasibility', tasks: [] },
  { project: 'TUTOR', host: 'local', cwd: '/Users/alice/Projects/TUTOR', last_at: Date.now() / 1000 - 120, session_id: 's-two', agent: 'codex', title: 'Second session', tasks: [] },
] as unknown as Activity[];
const noop = () => {};
const page = (search: string) => {
  vi.stubGlobal('location', { search });
  return renderToStaticMarkup(<ProjectHub rows={rows} tasks={[]} outcomes={[]} selected="TUTOR" me="user" api={{ on: async () => '{}' } as unknown as Api}
    flags={{}} archiveDays={30} connectionError={false} unavailable={[]} loaded
    onFlag={noop} onProject={noop} onOpen={noop} onTask={noop} onRead={async () => {}} onReload={noop} onNew={noop} />);
};

describe('项目页默认', () => {
  it('opens on 脉络 with no session picked', () => {
    const html = page('');
    expect(html).toMatch(/aria-selected="true"[^>]*>脉络</);
    expect(html).toContain('class="pv3"');
    expect(html).toContain('正在读这个项目的会话和任务，写现状…');
    expect(html).toContain('class="pv3-side"');
    // the session list and its Detail are not on this tab
    expect(html).not.toContain('data-session=');
    expect(html).not.toContain('RAG vs agentic search feasibility');
  });

  it('still opens the tab a link asks for', () => {
    const html = page('?section=sessions');
    expect(html).toMatch(/aria-selected="true"[^>]*>会话/);
    expect(html).toContain('RAG vs agentic search feasibility');
    expect(page('?section=review')).toMatch(/aria-selected="true"[^>]*>脉络</);
  });
});
