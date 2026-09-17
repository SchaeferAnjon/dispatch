import { useState } from 'react';
import { selectQuotas, type QuotaSnapshot } from '../quotas';
import { useT } from '../i18n';
import { actorOf, relTime } from '../derive';
import { QuotaBar } from './Home';
import { Avatar } from './ui';
import { StatsView } from './Stats';
import type { ComponentProps } from 'react';

export function UsageView({initialTab, quota, ...props}: ComponentProps<typeof StatsView> & {initialTab?: 'quota'; quota: QuotaSnapshot}) {
  const t = useT();
  const [tab, setTab] = useState<'quota' | 'stats'>(() => {
    if (initialTab) return initialTab;
    try { return localStorage.getItem('dispatch-usage-tab') === 'stats' ? 'stats' : 'quota'; } catch { return 'quota'; }
  });
  const select = (next: 'quota' | 'stats') => {
    setTab(next);
    try { localStorage.setItem('dispatch-usage-tab', next); } catch { /* Optional preference. */ }
  };
  return <div className="usage-page">
    <div className="usage-tabs" role="tablist" aria-label={t('统计与额度')}>
      <button id="usage-quota-tab" role="tab" aria-selected={tab === 'quota'} aria-controls="usage-panel" onClick={() => select('quota')}>{t('额度概览')}</button>
      <button id="usage-stats-tab" role="tab" aria-selected={tab === 'stats'} aria-controls="usage-panel" onClick={() => select('stats')}>{t('使用统计')}</button>
    </div>
    <div id="usage-panel" role="tabpanel" aria-labelledby={`usage-${tab}-tab`}>
      {tab === 'quota' ? <QuotaView quota={quota} hostName={props.hostName ?? ''}/> : <StatsView {...props}/>}
    </div>
  </div>;
}

// Plan ids as the CLIs report them, in words.
const PLAN_LABEL:Record<string,string>={prolite:'Pro Lite',pro:'Pro',plus:'Plus',team:'Team',max:'Max',free:'Free'};
const planLabel=(p:string)=>PLAN_LABEL[p.toLowerCase()]??p;
export function QuotaView({quota,hostName}:{quota:QuotaSnapshot;hostName:string}) {
  const t=useT();
  const {rows,busy,error,refresh}=quota;
  const [showUnavailable,setShowUnavailable]=useState(false);
  const merged=selectQuotas(rows,hostName);
  const matching=merged;
  const visible=merged.filter(q=>showUnavailable||q.windows.length>0);
  return <div className="quota-page"><header><div><h3>{t('额度与重置时间')}</h3><p className="muted">{t('百分比表示已使用额度；相同账号在不同机器上的额度共享，不累加。')}</p></div><button className="btn sm" disabled={busy} onClick={()=>void refresh()}>{busy?t('刷新中…'):t('刷新额度')}</button></header>{error&&<p className="err">{error}</p>}<div className="quota-grid">{visible.map(q=>{const a=actorOf(q.agent,'');const age=q.updated_at?Date.now()/1000-q.updated_at:Infinity;return <article key={`${q.host||'local'}:${q.agent}`}><header>{a&&<Avatar actor={a}/>}<b>{a?.name||q.agent}</b><span className="muted">{q.host_name||t('本机')}{q.also?.length?` + ${q.also.join(' + ')} · ${t('同一账号')}`:''}{q.plan?` · ${planLabel(q.plan)}`:''}</span></header>{!!q.conflict?.length&&<p className="small muted">{t('和 {hosts} 上不是同一个账号：重置时间或用量对不上（同一账号两边的数字应该一样）；也可能其中一份数据已过期',{hosts:q.conflict.join(t('、'))})}</p>}{q.windows.length?q.windows.map((w,n)=><QuotaBar key={n} w={w}/>):<p className="muted">{t('暂无可用额度数据')}</p>}<p className="small muted">{q.updated_at?t('{time}更新',{time:relTime(new Date(q.updated_at*1000).toISOString())}):t('尚未获取')}{age>600&&q.updated_at?` · ${t('数据较旧，可能尚未反映最新使用量')}`:''}</p><details><summary>{t('数据来源')}</summary><p>{q.note||q.source}</p></details></article>;})}</div>{matching.some(q=>!q.windows.length)&&<button className="btn sm" onClick={()=>setShowUnavailable(!showUnavailable)}>{showUnavailable?t('收起暂无数据的 Agent'):t('暂无额度数据 · {n} 项',{n:matching.filter(q=>!q.windows.length).length})}</button>}{!rows.length&&!error&&<div className="empty">{busy?t('正在读取各 Agent 的额度…'):t('尚未找到额度记录')}</div>}</div>;
}
