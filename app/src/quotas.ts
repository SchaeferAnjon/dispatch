import { t } from './i18n';
import type { Quota } from './types';

export type SharedQuota = Quota & { also?: string[]; conflict?: string[] };
export interface QuotaSnapshot {
  rows: Quota[];
  busy: boolean;
  error: string;
  refresh: () => Promise<void>;
}

// Matching reset windows are the available evidence of a shared subscription.
// Missing resets cannot establish a match. Always choose the newest whole reading.
// `localHostName`: this machine's quota comes first in the header — what the person sitting
// here is spending — the other Macs' after it.
export function selectQuotas(rows: Quota[], hostName = '', localHostName = ''): SharedQuota[] {
  const groups: SharedQuota[] = [];
  const sorted = [...rows].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)
    || (a.host_name ?? '').localeCompare(b.host_name ?? ''));
  // Reset times alone are not identity: Anthropic aligns them to the hour, so two accounts often
  // reset together. The same account also reports the same used percentages (they come from the
  // server), so a twin must agree on both for every window they share.
  // `newer` is the group's reading (sorted newest first), `older` the candidate's: within one
  // window usage only grows, so an older reading above a newer one is another account.
  const sameWindow = (newer: Quota['windows'][number], older: Quota['windows'][number]) =>
    older.label === newer.label && older.resets_at != null && newer.resets_at != null && Math.abs(older.resets_at - newer.resets_at) < 120
    && (older.used_percent == null || newer.used_percent == null || newer.used_percent >= older.used_percent - 1);
  const contradicts = (newer: Quota['windows'][number], older: Quota['windows'][number]) =>
    older.label === newer.label && older.resets_at != null && newer.resets_at != null && Math.abs(older.resets_at - newer.resets_at) < 120 && !sameWindow(newer, older);
  for (const q of sorted) {
    const twin = groups.find(m => m.agent === q.agent && m.windows.some(w => q.windows.some(v => sameWindow(w, v)))
      && !m.windows.some(w => q.windows.some(v => contradicts(w, v))));
    if (twin) twin.also = [...(twin.also ?? []), q.host_name || t('本机')];
    else groups.push({ ...q });
  }
  for (const q of groups) {
    q.conflict = groups.filter(other => other !== q && other.agent === q.agent
      && other.windows.length && q.windows.length).map(other => other.host_name || t('本机'));
  }
  const local = (q: SharedQuota) => localHostName
    ? q.host_name === localHostName || !!q.also?.includes(localHostName)
    : !q.remote && (q.host ?? 'local') === 'local';
  return groups.filter(q => !hostName || q.host_name === hostName || q.also?.includes(hostName))
    .sort((a, b) => Number(local(b)) - Number(local(a)) || a.agent.localeCompare(b.agent) || (a.host_name ?? '').localeCompare(b.host_name ?? ''));
}
