import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api';
import type { Quota } from '../types';
import { actorOf, relTime } from '../derive';
import { QuotaBar } from './Home';
import { Avatar } from './ui';

export function QuotaView({api,hostName}:{api:Api;hostName:string}) {
  const [rows,setRows]=useState<Quota[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [showUnavailable,setShowUnavailable]=useState(false);
  const refresh=useCallback(async()=>{setBusy(true);try{setRows(await api.quota());setError('');}catch(e){setError(String(e));}finally{setBusy(false);}},[api]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},60000);return()=>clearInterval(timer);},[refresh]);
  const matching=rows.filter(q=>!hostName||q.host_name===hostName);
  const visible=matching.filter(q=>showUnavailable||q.windows.length>0);
  return <div className="quota-page"><header><div><h3>额度与重置时间</h3><p className="muted">百分比表示已使用额度；相同账号在不同机器上的额度共享，不累加。</p></div><button className="btn sm" disabled={busy} onClick={()=>void refresh()}>{busy?'刷新中…':'刷新额度'}</button></header>{error&&<p className="err">{error}</p>}<div className="quota-grid">{visible.map(q=>{const a=actorOf(q.agent,'');const age=q.updated_at?Date.now()/1000-q.updated_at:Infinity;return <article key={`${q.host||'local'}:${q.agent}`}><header>{a&&<Avatar actor={a}/>}<b>{a?.name||q.agent}</b><span className="muted">{q.host_name||'本机'}{q.plan?` · ${q.plan}`:''}</span></header>{q.windows.length?q.windows.map((w,n)=><QuotaBar key={n} w={w}/>):<p className="muted">暂无可用额度数据</p>}<p className="small muted">{q.updated_at?`${relTime(new Date(q.updated_at*1000).toISOString())}更新`:'尚未获取'}{age>600&&q.updated_at?' · 数据较旧，可能尚未反映最新使用量':''}</p><details><summary>数据来源</summary><p>{q.note||q.source}</p></details></article>;})}</div>{matching.some(q=>!q.windows.length)&&<button className="btn sm" onClick={()=>setShowUnavailable(!showUnavailable)}>{showUnavailable?"收起暂无数据的 Agent":`暂无额度数据 · ${matching.filter(q=>!q.windows.length).length} 项`}</button>}{!rows.length&&!error&&<div className="empty">{busy?'正在读取各 Agent 的额度…':'尚未找到额度记录'}</div>}</div>;
}
