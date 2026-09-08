import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api';
import type { Quota } from '../types';
import { actorOf, relTime } from '../derive';
import { QuotaBar } from './Home';
import { Avatar } from './ui';
import { StatsView } from './Stats';
import type { ComponentProps } from 'react';

export function UsageView({initialTab, ...props}: ComponentProps<typeof StatsView> & {initialTab?: 'quota'}) {
  const [tab, setTab] = useState<'quota' | 'stats'>(() => {
    if (initialTab) return initialTab;
    try { return localStorage.getItem('dispatch-usage-tab') === 'stats' ? 'stats' : 'quota'; } catch { return 'quota'; }
  });
  const select = (next: 'quota' | 'stats') => {
    setTab(next);
    try { localStorage.setItem('dispatch-usage-tab', next); } catch { /* Optional preference. */ }
  };
  return <div className="usage-page">
    <div className="usage-tabs" role="tablist" aria-label="统计与额度">
      <button id="usage-quota-tab" role="tab" aria-selected={tab === 'quota'} aria-controls="usage-panel" onClick={() => select('quota')}>额度概览</button>
      <button id="usage-stats-tab" role="tab" aria-selected={tab === 'stats'} aria-controls="usage-panel" onClick={() => select('stats')}>使用统计</button>
    </div>
    <div id="usage-panel" role="tabpanel" aria-labelledby={`usage-${tab}-tab`}>
      {tab === 'quota' ? <QuotaView api={props.api} hostName={props.hostName ?? ''}/> : <StatsView {...props}/>}
    </div>
  </div>;
}

// Plan ids as the CLIs report them, in words.
const PLAN_LABEL:Record<string,string>={prolite:'Pro Lite',pro:'Pro',plus:'Plus',team:'Team',max:'Max',free:'Free'};
const planLabel=(p:string)=>PLAN_LABEL[p.toLowerCase()]??p;
export function QuotaView({api,hostName}:{api:Api;hostName:string}) {
  const [rows,setRows]=useState<Quota[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [showUnavailable,setShowUnavailable]=useState(false);
  const refresh=useCallback(async()=>{setBusy(true);try{setRows(await api.quota());setError('');}catch(e){setError(String(e));}finally{setBusy(false);}},[api]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},60000);return()=>clearInterval(timer);},[refresh]);
  const matching=rows.filter(q=>!hostName||q.host_name===hostName);
  // Two Macs logged into the same account report the same reset instants; keep the freshest reading and say it covers both.
  // Different reset instants mean different accounts (or a stale snapshot): both stay, and the card says so.
  const sameAccount=(a:Quota,b:Quota)=>a.agent===b.agent&&a.windows.some(w=>b.windows.some(v=>v.label===w.label&&Math.abs((v.resets_at||0)-(w.resets_at||0))<120));
  const merged:(Quota&{also?:string[];conflict?:string[]})[]=[];
  for(const q of matching){
    const twin=merged.find(m=>m.agent===q.agent&&m.windows.length>0&&q.windows.length>0);
    if(twin&&sameAccount(twin,q)){const fresher=(q.updated_at||0)>(twin.updated_at||0);const keep=fresher?{...q,also:[...(twin.also||[]),twin.host_name||'本机'],conflict:twin.conflict}:{...twin,also:[...(twin.also||[]),q.host_name||'本机']};merged[merged.indexOf(twin)]=keep;continue;}
    if(twin){twin.conflict=[...(twin.conflict||[]),q.host_name||'本机'];merged.push({...q,conflict:[twin.host_name||'本机']});continue;}
    merged.push({...q});
  }
  const visible=merged.filter(q=>showUnavailable||q.windows.length>0);
  return <div className="quota-page"><header><div><h3>额度与重置时间</h3><p className="muted">百分比表示已使用额度；相同账号在不同机器上的额度共享，不累加。</p></div><button className="btn sm" disabled={busy} onClick={()=>void refresh()}>{busy?'刷新中…':'刷新额度'}</button></header>{error&&<p className="err">{error}</p>}<div className="quota-grid">{visible.map(q=>{const a=actorOf(q.agent,'');const age=q.updated_at?Date.now()/1000-q.updated_at:Infinity;return <article key={`${q.host||'local'}:${q.agent}`}><header>{a&&<Avatar actor={a}/>}<b>{a?.name||q.agent}</b><span className="muted">{q.host_name||'本机'}{q.also?.length?` + ${q.also.join(' + ')} · 同一账号`:''}{q.plan?` · ${planLabel(q.plan)}`:''}</span></header>{!!q.conflict?.length&&<p className="small muted">和 {q.conflict.join('、')} 上的重置时间不同：不是同一个账号，或其中一份数据已过期</p>}{q.windows.length?q.windows.map((w,n)=><QuotaBar key={n} w={w}/>):<p className="muted">暂无可用额度数据</p>}<p className="small muted">{q.updated_at?`${relTime(new Date(q.updated_at*1000).toISOString())}更新`:'尚未获取'}{age>600&&q.updated_at?' · 数据较旧，可能尚未反映最新使用量':''}</p><details><summary>数据来源</summary><p>{q.note||q.source}</p></details></article>;})}</div>{matching.some(q=>!q.windows.length)&&<button className="btn sm" onClick={()=>setShowUnavailable(!showUnavailable)}>{showUnavailable?"收起暂无数据的 Agent":`暂无额度数据 · ${matching.filter(q=>!q.windows.length).length} 项`}</button>}{!rows.length&&!error&&<div className="empty">{busy?'正在读取各 Agent 的额度…':'尚未找到额度记录'}</div>}</div>;
}
