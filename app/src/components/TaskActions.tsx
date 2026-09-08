import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Anchor } from './ContextMenu';
import type { Api } from '../api';
import type { Issue } from '../types';

export const isTrashed = (i: Issue) => !!i.labels?.includes('dispatch:trashed');
// Closed long ago and put away: keeps the done column and counts small. Stays on the board for history.
export const isArchivedTask = (i: Issue) => !!i.labels?.includes('dispatch:archived');
type Menu = { issue: Issue; x: number; y: number };
const Context = createContext<(issue: Issue, e: Anchor) => void>(() => {});
export const useTaskMenu = () => useContext(Context);

export function TaskActions({ api, children, onOpen, onDelegate, onDone, onError }: { api: Api | null; children: ReactNode; onOpen: (id:string)=>void; onDelegate: (id:string)=>void; onDone:(m:string,id?:string)=>void; onError:(m:string)=>void }) {
  const [menu,setMenu]=useState<Menu|null>(null); const [busy,setBusy]=useState(false); const panel=useRef<HTMLDivElement>(null); const returnFocus=useRef<HTMLElement|null>(null);
  const open=(issue:Issue,e:Anchor)=>{e.preventDefault();e.stopPropagation();const el=e.currentTarget as HTMLElement|null;returnFocus.current=el;const r=el?.getBoundingClientRect();setMenu({issue,x:e.clientX||r?.left||0,y:e.clientY||r?.bottom||0});};
  useLayoutEffect(()=>{if(!menu||!panel.current)return;const el=panel.current;el.style.left=`${Math.max(8,Math.min(menu.x,innerWidth-el.offsetWidth-8))}px`;el.style.top=`${Math.max(8,Math.min(menu.y,innerHeight-el.offsetHeight-8))}px`;el.querySelector<HTMLButtonElement>('button')?.focus();},[menu]);
  const close=()=>{setMenu(null);returnFocus.current?.focus();};
  useEffect(()=>{if(!menu)return;const esc=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}};window.addEventListener('keydown',esc,true);return()=>window.removeEventListener('keydown',esc,true);},[menu]);
  const act=async(label:string,fn:()=>Promise<unknown>,removed=false)=>{setBusy(true);try{await fn();onDone(label,removed?menu?.issue.id:undefined);close();}catch(e){onError(String(e));}finally{setBusy(false);}};
  const i=menu?.issue;
  return <Context.Provider value={open}>{children}{menu&&i&&api&&<div className="task-menu-shade" onMouseDown={e=>e.target===e.currentTarget&&!busy&&close()} onContextMenu={e=>{e.preventDefault();if(!busy)close();}}><div className="task-menu" ref={panel} role="menu" aria-label="任务操作" onKeyDown={e=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const buttons=Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const n=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(n+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}}>
    <div className="task-menu-title">{i.title}</div>
    <button role="menuitem" disabled={busy} onClick={()=>{onOpen(i.id);close();}}>打开任务详情</button>
    <button role="menuitem" disabled={busy} onClick={()=>void act('任务 ID 已复制',()=>api.copy(i.id))}>复制任务 ID</button>
    <button role="menuitem" disabled={busy} onClick={()=>void act('任务内容已复制',()=>api.copy(`${i.title}\n${i.id}\n\n${i.description||''}`))}>复制任务内容</button>
    {!isTrashed(i)&&i.status!=='closed'&&<button role="menuitem" disabled={busy} onClick={()=>{onDelegate(i.id);close();}}>派给 Agent…</button>}
    {!isTrashed(i)&&<><hr/>{i.status!=='open'&&<button role="menuitem" disabled={busy} onClick={()=>void act('已移到待办',()=>i.status==='closed'?api.reopen(i.id):api.setStatus(i.id,'open'))}>移到待办</button>}{i.status!=='in_progress'&&<button role="menuitem" disabled={busy} onClick={()=>void act('已移到进行中',async()=>{if(i.status==='closed')await api.reopen(i.id);await api.setStatus(i.id,'in_progress');})}>移到进行中</button>}{i.status!=='closed'&&<button role="menuitem" disabled={busy} onClick={()=>void act('已标记完成',()=>api.close(i.id,'用户在 Dispatch 中标记完成'))}>标记完成</button>}</>}
    {i.status==='closed'&&!isTrashed(i)&&<button role="menuitem" disabled={busy} onClick={()=>void act(isArchivedTask(i)?'已取消归档':'已归档：不再出现在已完成列',()=>api.labels(i.id,isArchivedTask(i)?[]:['dispatch:archived'],isArchivedTask(i)?['dispatch:archived']:[]),!isArchivedTask(i))}>{isArchivedTask(i)?'取消归档':'归档（已完成很久了）'}</button>}
    <hr/><button role="menuitem" className={isTrashed(i)?'':'danger'} disabled={busy} onClick={()=>void act(isTrashed(i)?'任务已恢复':'已移到回收站，可从任务页恢复',()=>api.on('local',['task',isTrashed(i)?'restore':'trash',i.id,'--json']),!isTrashed(i))}>{isTrashed(i)?'从回收站恢复':'移到回收站'}</button>
  </div></div>}</Context.Provider>;
}

export function TaskMenuButton({issue}:{issue:Issue}) {const open=useTaskMenu();return <button className="task-more" aria-label={`任务操作：${issue.title}`} title="任务操作（也可右键）" onClick={e=>open(issue,e)} onKeyDown={e=>e.stopPropagation()}>⋯</button>;}
