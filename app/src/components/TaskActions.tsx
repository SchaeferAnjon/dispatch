import { createContext, useContext, useState, type ReactNode } from 'react';
import { MenuItem, MenuPanel, type Anchor, type ViewMenuItem } from './ContextMenu';
import type { Api } from '../api';
import type { Issue } from '../types';
import { useT } from '../i18n';

export const isTrashed = (i: Issue) => !!i.labels?.includes('dispatch:trashed');
// Closed long ago and put away: keeps the done column and counts small. Stays on the board for history.
export const isArchivedTask = (i: Issue) => !!i.labels?.includes('dispatch:archived');
type Menu = { issue: Issue; x: number; y: number; from: HTMLElement | null };
const Context = createContext<(issue: Issue, e: Anchor) => void>(() => {});
export const useTaskMenu = () => useContext(Context);
// The same list as the right-click menu, for the ⌘K panel. "-" separates groups.
const ItemsContext = createContext<(issue: Issue) => (ViewMenuItem | "-")[]>(() => []);
export const useTaskActionItems = () => useContext(ItemsContext);

export function TaskActions({ api, children, onOpen, onDelegate, onDone, onError }: { api: Api | null; children: ReactNode; onOpen: (id:string)=>void; onDelegate: (id:string)=>void; onDone:(m:string,id?:string)=>void; onError:(m:string)=>void }) {
  const t = useT();
  const [menu,setMenu]=useState<Menu|null>(null); const [busy,setBusy]=useState(false);
  const open=(issue:Issue,e:Anchor)=>{e.preventDefault();e.stopPropagation();const el=e.currentTarget as HTMLElement|null;const r=el?.getBoundingClientRect();setMenu({issue,x:e.clientX||r?.left||0,y:e.clientY||r?.bottom||0,from:el});};
  const close=()=>setMenu(null);
  // `removed`: the task leaves the current list (trash, archive), so an open detail closes.
  const act=async(i:Issue,label:string,fn:()=>Promise<unknown>,removed=false)=>{try{await fn();onDone(label,removed?i.id:undefined);}catch(e){onError(String(e));}};
  const items=(i:Issue):(ViewMenuItem|"-")[]=>{
    if(!api)return [];
    const out:(ViewMenuItem|"-")[]=[
      {label:t('打开任务详情'),icon:'doc',onClick:()=>onOpen(i.id)},
      {label:t('在新窗口打开'),icon:'window',onClick:()=>{void api.openWindow(`#/board/task/${encodeURIComponent(i.id)}`);}},
      {label:t('复制任务 ID'),icon:'copy',sub:i.id,onClick:()=>act(i,t('任务 ID 已复制'),()=>api.copy(i.id))},
      {label:t('复制任务内容'),icon:'copy',onClick:()=>act(i,t('任务内容已复制'),()=>api.copy(`${i.title}\n${i.id}\n\n${i.description||''}`))},
    ];
    if(!isTrashed(i)&&i.status!=='closed')out.push({label:t('派给 Agent…'),icon:'agent',onClick:()=>onDelegate(i.id)});
    if(!isTrashed(i)){
      out.push("-");
      if(i.status!=='open')out.push({label:t('移到待办'),icon:'left',onClick:()=>act(i,t('已移到待办'),()=>i.status==='closed'?api.reopen(i.id):api.setStatus(i.id,'open'))});
      if(i.status!=='in_progress')out.push({label:t('移到进行中'),icon:'play',onClick:()=>act(i,t('已移到进行中'),async()=>{if(i.status==='closed')await api.reopen(i.id);await api.setStatus(i.id,'in_progress');})});
      if(i.status!=='closed')out.push({label:t('标记完成'),icon:'check',onClick:()=>act(i,t('已标记完成'),()=>api.close(i.id,'用户在 Dispatch 中标记完成'))});
    }
    if(i.status==='closed'&&!isTrashed(i))out.push({label:isArchivedTask(i)?t('取消归档'):t('归档（已完成很久了）'),icon:'archive',onClick:()=>act(i,isArchivedTask(i)?t('已取消归档'):t('已归档：不再出现在已完成列'),()=>api.labels(i.id,isArchivedTask(i)?[]:['dispatch:archived'],isArchivedTask(i)?['dispatch:archived']:[]),!isArchivedTask(i))});
    out.push("-",{label:isTrashed(i)?t('从回收站恢复'):t('移到回收站'),icon:'trash',danger:!isTrashed(i),onClick:()=>act(i,isTrashed(i)?t('任务已恢复'):t('已移到回收站，可从任务页恢复'),()=>api.on('local',['task',isTrashed(i)?'restore':'trash',i.id,'--json']),!isTrashed(i))});
    return out;
  };
  const i=menu?.issue;
  return <ItemsContext.Provider value={items}><Context.Provider value={open}>{children}{menu&&i&&api&&<MenuPanel x={menu.x} y={menu.y} title={i.title} label={t("任务操作")} busy={busy} onClose={close} returnTo={menu.from}>
    {items(i).map((x,n)=>x==="-"?<hr key={n}/>:<MenuItem key={x.label} danger={x.danger} disabled={busy||x.disabled} onClick={async()=>{setBusy(true);try{await x.onClick();}finally{setBusy(false);close();menu.from?.focus();}}}>{x.label}</MenuItem>)}
  </MenuPanel>}</Context.Provider></ItemsContext.Provider>;
}

export function TaskMenuButton({issue}:{issue:Issue}) {const t=useT();const open=useTaskMenu();return <button className="task-more" aria-label={t("任务操作：{title}", { title: issue.title })} title={t("任务操作（也可右键）")} onClick={e=>open(issue,e)} onKeyDown={e=>e.stopPropagation()}>⋯</button>;}
