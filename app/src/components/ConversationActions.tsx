import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Activity } from '../types';
import type { Api } from '../api';
type Changes = { scheduled?: boolean; project_override?: string };
const Context = createContext<(a:Activity,e:MouseEvent)=>void>(()=>{});
export const useConversationMenu = () => useContext(Context);
export function ConversationActions({api,projects,onSaved,children}:{api:Api|null;projects:string[];onSaved:(a:Activity,c:Changes)=>void;children:ReactNode}) {
  const [menu,setMenu]=useState<{a:Activity;x:number;y:number}|null>(null);
  const [editing,setEditing]=useState(false),[project,setProject]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const panel=useRef<HTMLDivElement>(null),origin=useRef<HTMLElement|null>(null);
  const close=()=>{setMenu(null);origin.current?.focus();};
  const open=(a:Activity,e:MouseEvent)=>{e.preventDefault();e.stopPropagation();origin.current=e.currentTarget as HTMLElement;setEditing(false);setError('');setProject(a.project_override||'');setMenu({a,x:e.clientX||e.currentTarget.getBoundingClientRect().left,y:e.clientY||e.currentTarget.getBoundingClientRect().bottom});};
  useLayoutEffect(()=>{if(!menu||!panel.current)return;const p=panel.current;p.style.left=`${Math.max(8,Math.min(menu.x,innerWidth-p.offsetWidth-8))}px`;p.style.top=`${Math.max(8,Math.min(menu.y,innerHeight-p.offsetHeight-8))}px`;p.querySelector<HTMLElement>(editing?'input':'button')?.focus();},[menu,editing]);
  useEffect(()=>{if(!menu)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy)close();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[menu,busy]);
  const save=async(changes:Changes)=>{if(!api||!menu)return;setBusy(true);setError('');try{const data=JSON.parse(await api.on(menu.a.host||'local',['session-preferences',menu.a.key,JSON.stringify(changes),'--json']));onSaved(menu.a,data);close();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <Context.Provider value={open}>{children}{menu&&<div className="task-menu-shade" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)close();}} onContextMenu={e=>e.preventDefault()}><div ref={panel} className="task-menu conversation-menu" role={editing?'dialog':'menu'} aria-label={editing?'关联项目':'会话操作'}>
    <div className="task-menu-title">{menu.a.title}</div>
    {editing?<form onSubmit={e=>{e.preventDefault();void save({project_override:project});}}><label>项目名称<input aria-label="项目名称" list="conversation-projects" value={project} onChange={e=>setProject(e.target.value)} maxLength={120} placeholder="选择已有项目或输入名称"/></label><datalist id="conversation-projects">{projects.map(p=><option key={p} value={p}/>)}</datalist><p className="muted small">关联后显示此项目名，不移动工作文件夹。留空可恢复自动识别。</p><button disabled={busy} type="submit">保存项目关联</button><button disabled={busy} type="button" onClick={()=>setEditing(false)}>返回</button></form>:<><button role="menuitem" disabled={busy} onClick={()=>void save({scheduled:!menu.a.scheduled})}>{menu.a.scheduled?'恢复为普通会话':'标记为定时会话'}</button><p className="muted small">定时会话默认不出现在工作台和等我，也不发提醒；可在“定时会话”中找回。</p><button role="menuitem" disabled={busy} onClick={()=>setEditing(true)}>关联项目…</button></>}
    {error&&<p role="alert" className="danger">保存失败：{error}</p>}
  </div></div>}</Context.Provider>;
}
export function ConversationMenuButton({a}:{a:Activity}){const open=useConversationMenu();return <button className="btn sm" title="会话操作（也可右键）" aria-label={`会话操作：${a.title}`} onClick={e=>open(a,e)}>更多</button>;}
