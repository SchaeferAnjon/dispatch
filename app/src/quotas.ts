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
  for (const q of sorted) {
    const twin = groups.find(m => m.agent === q.agent && m.windows.some(w =>
      w.resets_at != null && q.windows.some(v => v.label === w.label && v.resets_at != null
        && Math.abs(v.resets_at - w.resets_at!) < 120)));
    if (twin) twin.also = [...(twin.also ?? []), q.host_name || '本机'];
    else groups.push({ ...q });
  }
  for (const q of groups) {
    q.conflict = groups.filter(other => other !== q && other.agent === q.agent
      && other.windows.length && q.windows.length).map(other => other.host_name || '本机');
  }
  const local = (q: SharedQuota) => localHostName
    ? q.host_name === localHostName || !!q.also?.includes(localHostName)
    : !q.remote && (q.host ?? 'local') === 'local';
  return groups.filter(q => !hostName || q.host_name === hostName || q.also?.includes(hostName))
    .sort((a, b) => Number(local(b)) - Number(local(a)) || a.agent.localeCompare(b.agent) || (a.host_name ?? '').localeCompare(b.host_name ?? ''));
}
