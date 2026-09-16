import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { selectQuotas } from './quotas';
import { QuotaView } from './components/Quota';
import type { Quota } from './types';

const row = (host_name: string, used_percent: number, updated_at: number, reset: number | null = 10000): Quota => ({
  agent: 'codex', host_name, plan: 'prolite', updated_at, source: 'rollout', note: '',
  windows: [{ label: '每周', used_percent, resets_at: reset }],
});

it('both machines select the latest shared quota regardless of local/remote order', () => {
  const apple = row('Apple', 29, 200);
  const brother = row('大哥', 19, 100);
  const first = selectQuotas([apple, { ...brother, remote: true }]);
  const second = selectQuotas([{ ...apple, remote: true }, brother].reverse());
  expect(first.map(q => q.windows)).toEqual(second.map(q => q.windows));
  expect(first).toHaveLength(1);
  expect(first[0].windows[0].used_percent).toBe(29);
  expect(selectQuotas([apple, brother], '大哥')[0].windows[0].used_percent).toBe(29);
});

it('keeps distinct reset windows and unknown reset records separate', () => {
  expect(selectQuotas([row('Apple', 29, 200), row('大哥', 19, 100, 20000)])).toHaveLength(2);
  expect(selectQuotas([row('Apple', 29, 200, null), row('大哥', 19, 100, null)])).toHaveLength(2);
});

it('chooses a whole fresh reading including model-specific windows without summing', () => {
  const fresh = row('大哥', 11, 300);
  fresh.windows.push({ label: '每周 · Fable', used_percent: 100, resets_at: 20000 });
  const rows = [row('Apple', 10, 100), fresh];
  expect(selectQuotas(rows)[0].windows).toEqual(fresh.windows);
  expect(rows[1]).not.toHaveProperty('also');
});

it('overview renders exactly the shared snapshot selected for the header', () => {
  const rows = [row('大哥', 19, 100), row('Apple', 29, 200)];
  const html = renderToStaticMarkup(<QuotaView hostName="" quota={{ rows, busy: false, error: '', refresh: async () => {} }} />);
  expect(html).toContain('29%');
  expect(html).not.toContain('19%');
  expect(html).toContain('Apple + 大哥');
});

it('the header lists this machine first, whatever the host names sort like', () => {
  const brother = row('大哥', 71, 300, 10000); brother.host = 'hub'; brother.remote = true;
  const apple = row('Apple', 2, 200, 20000); apple.host = 'local';
  expect(selectQuotas([brother, apple], '', 'Apple').map(q => q.host_name)).toEqual(['Apple', '大哥']);
  expect(selectQuotas([brother, apple]).map(q => q.host_name)).toEqual(['Apple', '大哥']);
  // A shared subscription read most recently on the other Mac still counts as this machine's.
  const shared = row('大哥', 30, 400, 10000); shared.remote = true;
  const mine = row('Apple', 29, 350, 10000);
  const other = row('大哥', 50, 500, 30000); other.agent = 'claude-code'; other.remote = true;
  expect(selectQuotas([shared, mine, other], '', 'Apple').map(q => `${q.agent}:${q.host_name}`)).toEqual(['codex:大哥', 'claude-code:大哥']);
  expect(selectQuotas([shared, mine, other], '', 'Apple')[0].also).toEqual(['Apple']);
});
