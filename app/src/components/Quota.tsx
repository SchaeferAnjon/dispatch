import { useState, type ComponentProps, type ReactNode } from 'react';
import { selectQuotas, type QuotaSnapshot } from '../quotas';
import { t as tr, useLocale, useT } from '../i18n';
import { actorOf, relTime } from '../derive';
import type { QuotaWindow } from '../types';
import { Avatar } from './ui';
import { StatsFilters, StatsView, useStatsFilters } from './Stats';
import { EmptyView, ListDetail, Meta, Row, Section, Sep, Tabs, Tag, useListKeyboard } from './primitives';
import { About, DetailHead, DetailSection, revealDetail } from './PageParts';
import { useShellHeader } from './Shell';
import { Icon } from './icons';

// 统计与额度: two tabs in one row; on 使用统计 the same row carries the Agent, range and metric pickers.
export function UsageView({initialTab, quota, ...props}: ComponentProps<typeof StatsView> & {initialTab?: 'quota'; quota: QuotaSnapshot}) {
  const t = useT();
  const [tab, setTab] = useState<'quota' | 'stats'>(() => {
    if (initialTab) return initialTab;
    try { return localStorage.getItem('dispatch-usage-tab') === 'stats' ? 'stats' : 'quota'; } catch { return 'quota'; }
  });
  const filters = useStatsFilters();
  const select = (next: 'quota' | 'stats') => {
    setTab(next);
    try { localStorage.setItem('dispatch-usage-tab', next); } catch { /* Optional preference. */ }
  };
  const tabs = <Tabs items={[{ key: 'quota' as const, label: t('额度概览') }, { key: 'stats' as const, label: t('使用统计') }]} value={tab} onChange={select}
    right={tab === 'stats' ? <StatsFilters {...filters} me={props.me} /> : undefined} />;
  return tab === 'quota' ? <QuotaView quota={quota} hostName={props.hostName ?? ''} tabs={tabs}/> : <StatsView {...props} filters={filters} tabs={tabs}/>;
}

// Plan ids as the CLIs report them, in words.
const PLAN_LABEL:Record<string,string>={prolite:'Pro Lite',pro:'Pro',plus:'Plus',team:'Team',max:'Max',free:'Free'};
const planLabel=(p:string)=>PLAN_LABEL[p.toLowerCase()]??p;
function resetText(epoch: number | null): string {
  if (!epoch) return '';
  if (epoch * 1000 < Date.now()) return tr('已过重置时间');
  const m = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  if (m < 60) return tr('{m}m 后重置', { m });
  const h = Math.floor(m / 60);
  return h < 48 ? tr('{h}h{m} 后重置', { h, m: String(m % 60).padStart(2, '0') }) : tr('{d}d 后重置', { d: Math.round(h / 24) });
}
const level = (p: number) => (p >= 90 ? ' crit' : p >= 70 ? ' warn' : '');
const pctText = (w: QuotaWindow) => (w.used_percent === null ? tr('未知') : `${Math.round(w.used_percent)}%`);

/** Row accessory: the window's short name, a 36px bar and the used percent. */
function MiniWindow({ w }: { w: QuotaWindow }) {
  const p = w.used_percent ?? 0;
  return <span className={`ak-qm${level(p)}`} title={`${w.label} · ${pctText(w)}${w.resets_at ? ` · ${resetText(w.resets_at)}` : ''}`}><span className="l">{w.label}</span><span className="m"><i style={{ width: `${Math.min(100, p)}%` }} /></span><span className="num">{pctText(w)}</span></span>;
}

/** Detail: one window per line, full-width bar, percent and reset time. */
function WindowLine({ w }: { w: QuotaWindow }) {
  useLocale();
  const p = w.used_percent ?? 0;
  return <div className={`ak-qw${level(p)}`}><span className="l">{w.label}</span><span className="m"><i style={{ width: `${Math.min(100, p)}%` }} /></span><span className="v num">{pctText(w)}</span><span className="r">{resetText(w.resets_at)}</span></div>;
}

export function QuotaView({quota,hostName,tabs}:{quota:QuotaSnapshot;hostName:string;tabs?:ReactNode}) {
  const t=useT();
  const locale=useLocale();
  const {rows,busy,error,refresh}=quota;
  const [showUnavailable,setShowUnavailable]=useState(false);
  const merged=selectQuotas(rows,hostName);
  const visible=merged.filter(q=>showUnavailable||q.windows.length>0);
  const missing=merged.filter(q=>!q.windows.length).length;
  const keyOf=(q:typeof merged[number])=>`${q.host||'local'}:${q.agent}`;
  const ids=visible.map(keyOf);
  const [picked,setPicked]=useState<string|null>(null);
  const sel=picked&&ids.includes(picked)?picked:ids[0]??null;
  const cur=visible.find(q=>keyOf(q)===sel);
  useListKeyboard(ids,sel,setPicked);
  useShellHeader({
    subtitle: rows.length ? t('{n} 个 Agent', { n: merged.length - missing }) : '',
    actions: <button className="btn sm" disabled={busy} onClick={()=>void refresh()} aria-label={t('刷新额度')}><Icon name="refresh" size={14}/><span className="ak-hd-lbl">{busy?t('刷新中…'):t('刷新额度')}</span></button>,
  },[busy,rows.length,merged.length,locale]);
  const whereOf=(q:typeof merged[number])=>`${q.host_name||t('本机')}${q.also?.length?` + ${q.also.join(' + ')} · ${t('同一账号')}`:''}`;
  const detail=cur?(()=>{const a=actorOf(cur.agent,'');const age=cur.updated_at?Date.now()/1000-cur.updated_at:Infinity;return <div className="ak-detail">
    <DetailHead crumb={[t('额度')]} icon={a?<Avatar actor={a}/>:undefined} title={a?.name||cur.agent} tag={cur.plan?<Tag>{planLabel(cur.plan)}</Tag>:undefined}/>
    <Meta rows={[
      [t('主机'), whereOf(cur)],
      [t('更新'), cur.updated_at?relTime(new Date(cur.updated_at*1000).toISOString()):t('尚未获取')],
    ]}/>
    {age>600&&cur.updated_at?<p className="akd-note">{t('数据较旧，可能尚未反映最新使用量')}</p>:null}
    {!!cur.conflict?.length&&<p className="akd-note">{t('和 {hosts} 上不是同一个账号：重置时间或用量对不上（同一账号两边的数字应该一样）；也可能其中一份数据已过期',{hosts:cur.conflict.join(t('、'))})}</p>}
    <Sep/>
    <DetailSection title={t('额度与重置时间')}>{cur.windows.length?cur.windows.map((w,n)=><WindowLine key={n} w={w}/>):<p className="akd-note">{t('暂无可用额度数据')}</p>}</DetailSection>
    {(cur.note||cur.source)&&<About summary={t('数据来源')} className="in-detail"><p>{cur.note||cur.source}</p></About>}
  </div>;})():null;
  return <ListDetail className="ak-page ak-quota" tabs={tabs} detail={detail}>
    {error&&<p className="akd-note err ak-pad">{error}</p>}
    {visible.length>0&&<Section title={t('额度')} count={visible.length} right={t('已用')}>
      {visible.map(q=>{const a=actorOf(q.agent,'');const k=keyOf(q);return <Row key={k} id={k} selected={sel===k} onClick={()=>{setPicked(k);revealDetail();}}
        icon={a?<Avatar actor={a}/>:<Icon name="agent"/>} title={a?.name||q.agent}
        accessories={q.windows.length?q.windows.slice(0,2).map((w,n)=><MiniWindow key={n} w={w}/>):[t('暂无可用额度数据')]}/>;})}
    </Section>}
    {missing>0&&<Row className="ak-more" icon={<Icon name={showUnavailable?'up':'down'}/>} title={showUnavailable?t('收起暂无数据的 Agent'):t('暂无额度数据 · {n} 项',{n:missing})} onClick={()=>setShowUnavailable(!showUnavailable)}/>}
    {!rows.length&&!error&&<EmptyView icon="chart" title={busy?t('正在读取各 Agent 的额度…'):t('尚未找到额度记录')}/>}
    {rows.length>0&&<About summary={t('数据来源')}><p>{t('百分比表示已使用额度；相同账号在不同机器上的额度共享，不累加。')}</p></About>}
  </ListDetail>;
}
