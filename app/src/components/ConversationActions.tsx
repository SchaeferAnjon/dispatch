import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Anchor, ViewMenuItem } from './ContextMenu';
import type { Activity } from '../types';
import { getApi, type Api } from '../api';
import { useT } from '../i18n';
type Changes = { scheduled?: boolean; project_override?: string; title_override?: string; starred?: boolean; archived?: boolean };
import { sessionLifecycle } from '../activity';
import { heldOpen } from './SessionActions';
const Context = createContext<(a:Activity,e:Anchor)=>void>(()=>{});
export const useConversationMenu = () => useContext(Context);
// What the menu offers for one conversation, as a list for the ⌘K panel. The two that need a text
// field (改名, 关联项目) open the menu's own form.
const ItemsContext = createContext<(a:Activity)=>(ViewMenuItem|'-')[]>(()=>[]);
export const useConversationActionItems = () => useContext(ItemsContext);
// 关掉后台会话 for the pages that show one conversation (会话页, Agent 窗口): the same action as the menu's.
const CloseContext = createContext<((a:Activity)=>Promise<void>)|null>(null);
export const useCloseChat = () => useContext(CloseContext);
type Actions = { onOpen: (sessionId: string) => void; onRead: (a: Activity) => Promise<void>; onUnread?: (a: Activity) => Promise<void>; onResume: (a: Activity) => void; onDelegate?: (a: Activity) => void; onMove?: (a: Activity, hostId: string, hostName: string) => Promise<void>; onSummarize?: (a: Activity) => Promise<void>; hosts?: { id: string; name: string; online: boolean; local: boolean }[];
  /** 在 Dispatch IDE / VS Code / Cursor 里打开 for the conversation's folder (empty for another Mac's). */
  editorItems?: (a: Activity) => ViewMenuItem[];
  /** After 删除会话 moved its transcript to the Trash: drop the row now instead of at the next poll. */
  onDeleted?: (a: Activity) => void;
  /** 关掉后台会话: chatd ends the in-app conversation's process and forgets it. `quiet`: no toast (archiving says its own). */
  onCloseChat?: (a: Activity, quiet?: boolean) => Promise<void> };
export function ConversationActions({api,projects,onSaved,archiveDays,actions,children}:{api:Api|null;projects:string[];onSaved:(a:Activity,c:Changes)=>void;archiveDays:number;actions:Actions;children:ReactNode}) {
  const t=useT();
  const [menu,setMenu]=useState<{a:Activity;x:number;y:number}|null>(null);
  const [editing,setEditing]=useState<false|'project'|'title'|'delete'>(false),[project,setProject]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const panel=useRef<HTMLDivElement>(null),origin=useRef<HTMLElement|null>(null);
  const close=()=>{setMenu(null);origin.current?.focus();};
  const open=(a:Activity,e:Anchor)=>{e.preventDefault();e.stopPropagation();const el=e.currentTarget as HTMLElement|null;origin.current=el;const r=el?.getBoundingClientRect();setEditing(false);setError('');setProject(a.project_override||'');setName(a.title_override||'');setMenu({a,x:e.clientX||r?.left||0,y:e.clientY||r?.bottom||0});};
  useLayoutEffect(()=>{if(!menu||!panel.current)return;const p=panel.current;p.style.left=`${Math.max(8,Math.min(menu.x,innerWidth-p.offsetWidth-8))}px`;p.style.top=`${Math.max(8,Math.min(menu.y,innerHeight-p.offsetHeight-8))}px`;p.querySelector<HTMLElement>(editing&&editing!=='delete'?'input':'button')?.focus();},[menu,editing]);
  useEffect(()=>{if(!menu)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy)close();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[menu,busy]);
  // Archiving hides the row (Agent 窗口 and 会话 leave archived ones out): nothing should keep running behind it.
  const closeIfArchived=async(a:Activity,changes:Changes)=>{if(changes.archived===true&&a.runner==='dispatch'&&!a.remote&&actions.onCloseChat){try{await actions.onCloseChat(a,true);}catch{/* archived anyway */}}};
  const save=async(changes:Changes)=>{if(!api||!menu)return;setBusy(true);setError('');try{await closeIfArchived(menu.a,changes);const data=JSON.parse(await api.on(menu.a.host||'local',['session-preferences',menu.a.key,JSON.stringify(changes),'--json']));onSaved(menu.a,data);close();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const saveFor=async(a:Activity,changes:Changes)=>{if(!api)return;await closeIfArchived(a,changes);const data=JSON.parse(await api.on(a.host||'local',['session-preferences',a.key,JSON.stringify(changes),'--json']));onSaved(a,data);};
  // 删除会话: the CLI refuses a working or terminal-held one and moves the transcript to the Trash.
  const remove=async()=>{if(!api||!menu)return;const a=menu.a;setBusy(true);setError('');try{await api.on(a.host||'local',['session-delete',a.key,'--json']);actions.onDeleted?.(a);close();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const canDelete=(a:Activity)=>['claude-code','codex'].includes(a.agent)&&!a.session_id.startsWith('pid-');
  const edit=(a:Activity,mode:'project'|'title'|'delete')=>{origin.current=null;setError('');setProject(a.project_override||'');setName(a.title_override||'');setEditing(mode);setMenu({a,x:innerWidth-360,y:innerHeight-320});};
  const canOpen=(a:Activity)=>['codex','claude-code','pi','zcode','opencode','hermes','gemini'].includes(a.agent)&&!a.session_id.startsWith('pid-');
  const items=(a:Activity):(ViewMenuItem|'-')[]=>{
    const out:(ViewMenuItem|'-')[]=[{label:t('查看并回复'),icon:'reply',onClick:()=>actions.onOpen(a.session_id)},{label:t('在新窗口打开'),icon:'window',onClick:()=>{void getApi().then(x=>x.openWindow(`#/sessions/${encodeURIComponent(a.session_id)}`));}}];
    if(actions.onCloseChat&&heldOpen(a))out.push({label:t('关掉后台会话'),icon:'x',onClick:()=>actions.onCloseChat!(a)});
    if(a.unread&&a.reply_id)out.push({label:t('标记已读'),icon:'check',onClick:()=>actions.onRead(a)});
    if(!a.unread&&a.reply_id&&actions.onUnread)out.push({label:t('标为未读'),icon:'inbox',onClick:()=>actions.onUnread!(a)});
    if(canOpen(a))out.push({label:t('复制恢复命令'),icon:'copy',onClick:()=>actions.onResume(a)});
    if(api)out.push({label:t('复制会话 ID'),icon:'copy',onClick:()=>api.copy(a.session_id)});
    out.push(...(actions.editorItems?.(a)??[]));
    if(actions.onSummarize&&!a.remote)out.push({label:a.summary?t('用模型重新总结'):t('用模型总结这段会话'),icon:'refresh',onClick:()=>actions.onSummarize!(a)});
    if(actions.onMove&&['claude-code','codex','pi'].includes(a.agent)&&!a.remote)for(const h of (actions.hosts??[]).filter(h=>!h.local))out.push({label:t('迁移到 {name} 接着做',{name:h.name}),icon:'send',disabled:!h.online,onClick:()=>actions.onMove!(a,h.id,h.name)});
    const life=sessionLifecycle(a,archiveDays);
    out.push('-',{label:a.starred?t('取消收藏'):t('收藏：长期追踪'),icon:'star',onClick:()=>saveFor(a,a.starred?{starred:false}:{starred:true,archived:false})},
      {label:life==='archived'?t('取消归档（转为追踪中）'):t('归档'),icon:'archive',onClick:()=>saveFor(a,life==='archived'?(a.archived?{archived:false,starred:true}:{starred:true}):{archived:true,starred:false})},
      {label:a.scheduled?t('恢复为普通会话'):t('标记为定时会话'),icon:'cal',onClick:()=>saveFor(a,{scheduled:!a.scheduled})},
      {label:t('改名…'),icon:'doc',onClick:()=>edit(a,'title')},{label:t('关联项目…'),icon:'folder',onClick:()=>edit(a,'project')});
    if(canDelete(a))out.push('-',{label:t('删除会话…'),icon:'trash',danger:true,onClick:()=>edit(a,'delete')});
    return out;
  };
  return <CloseContext.Provider value={actions.onCloseChat??null}><ItemsContext.Provider value={items}><Context.Provider value={open}>{children}{menu&&<div className="task-menu-shade" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)close();}} onContextMenu={e=>e.preventDefault()}><div ref={panel} className="task-menu conversation-menu" role={editing?'dialog':'menu'} aria-label={editing==='title'?t('改名'):editing==='project'?t('关联项目'):editing==='delete'?t('删除会话'):t('会话操作')}>
    <div className="task-menu-title">{menu.a.title}</div>
    {!editing&&<>{(()=>{const a=menu.a;const canOpen=['codex','claude-code','pi','zcode','opencode','hermes','gemini'].includes(a.agent)&&!a.session_id.startsWith('pid-');return <><button role="menuitem" disabled={busy} onClick={()=>{actions.onOpen(a.session_id);close();}}>{t('查看并回复')}</button><button role="menuitem" disabled={busy} onClick={()=>{void getApi().then(x=>x.openWindow(`#/sessions/${encodeURIComponent(a.session_id)}`));close();}}>{t('在新窗口打开')}</button>{actions.onCloseChat&&heldOpen(a)&&<button role="menuitem" disabled={busy} title={t('结束 Dispatch 里这个会话的进程，后台不再留着；记录还在，再打开能续上')} onClick={async()=>{setBusy(true);try{await actions.onCloseChat!(a);close();}finally{setBusy(false);}}}>{t('关掉后台会话')}</button>}{a.unread&&a.reply_id&&<button role="menuitem" disabled={busy} onClick={()=>{void actions.onRead(a);close();}}>{t('标记已读')}</button>}{!a.unread&&a.reply_id&&actions.onUnread&&<button role="menuitem" disabled={busy} title={t('回到「等我」里，稍后再看')} onClick={()=>{void actions.onUnread!(a);close();}}>{t('标为未读')}</button>}{canOpen&&<button role="menuitem" disabled={busy} onClick={()=>{actions.onResume(a);close();}}>{t('复制恢复命令')}</button>}{api&&<button role="menuitem" disabled={busy} onClick={()=>{void api.copy(a.session_id);close();}}>{t('复制会话 ID')}</button>}{(actions.editorItems?.(a)??[]).map(i=><button key={i.label} role="menuitem" className={i.hint?'with-hint':''} disabled={busy||i.disabled} onClick={()=>{void i.onClick();close();}}>{i.label}{i.hint&&<kbd>{i.hint}</kbd>}</button>)}{actions.onSummarize&&!a.remote&&<button role="menuitem" disabled={busy} onClick={async()=>{setBusy(true);try{await actions.onSummarize!(a);close();}finally{setBusy(false);}}}>{a.summary?t('用模型重新总结'):t('用模型总结这段会话')}</button>}{actions.onMove&&['claude-code','codex','pi'].includes(a.agent)&&!a.remote&&(actions.hosts??[]).filter(h=>!h.local).map(h=><button key={h.id} role="menuitem" disabled={busy||!h.online} title={h.online?t('把项目目录和这段对话搬到 {name}，在那边接着做',{name:h.name}):t('{name} 离线',{name:h.name})} onClick={async()=>{setBusy(true);try{await actions.onMove!(a,h.id,h.name);close();}finally{setBusy(false);}}}>{t('迁移到 {name} 接着做',{name:h.name})}{busy?'…':''}</button>)}<hr/></>;})()}</>}
    {editing==='delete'?<div className="conversation-delete"><p>{t('删除这段会话？记录会移到废纸篓，可以从废纸篓找回。')}</p><button disabled={busy} onClick={()=>setEditing(false)}>{t('取消')}</button><button className="danger" disabled={busy} onClick={()=>void remove()}>{busy?t('删除中…'):t('删除')}</button></div>:editing==='title'?<form onSubmit={e=>{e.preventDefault();void save({title_override:name});}}><label>{t('会话名称')}<input aria-label={t('会话名称')} value={name} onChange={e=>setName(e.target.value)} maxLength={120} placeholder={menu.a.title_override?'':menu.a.title} autoFocus/></label><p className="muted small">{t('只改在 Dispatch 里显示的名字，不动转录；留空恢复自动取的标题。')}</p><button disabled={busy} type="submit">{t('保存名字')}</button><button disabled={busy} type="button" onClick={()=>setEditing(false)}>{t('返回')}</button></form>:editing==='project'?<form onSubmit={e=>{e.preventDefault();void save({project_override:project});}}><label>{t('项目名称')}<input aria-label={t('项目名称')} list="conversation-projects" value={project} onChange={e=>setProject(e.target.value)} maxLength={120} placeholder={t('选择已有项目或输入名称')}/></label><datalist id="conversation-projects">{projects.map(p=><option key={p} value={p}/>)}</datalist><p className="muted small">{t('关联后显示此项目名，不移动工作文件夹。留空可恢复自动识别。')}</p><button disabled={busy} type="submit">{t('保存项目关联')}</button><button disabled={busy} type="button" onClick={()=>setEditing(false)}>{t('返回')}</button></form>:<>{(()=>{const life=sessionLifecycle(menu.a,archiveDays);return <><button role="menuitem" disabled={busy} onClick={()=>void save(menu.a.starred?{starred:false}:{starred:true,archived:false})}>{menu.a.starred?t('取消收藏'):t('收藏：长期追踪')}</button><button role="menuitem" disabled={busy} onClick={()=>void save(life==='archived'?(menu.a.archived?{archived:false,starred:true}:{starred:true}):{archived:true,starred:false})}>{life==='archived'?t('取消归档（转为追踪中）'):t('归档')}</button><p className="muted small">{life==='archived'?(menu.a.archived?t('手动归档的会话'):t('超过 {days} 天没有活动，已自动归档',{days:archiveDays})):life==='starred'?t('追踪中：固定在工作台顶部，不会自动归档'):t('普通会话 {days} 天没有活动会自动归档；收藏的不会',{days:archiveDays})}</p></>;})()}<button role="menuitem" disabled={busy} onClick={()=>void save({scheduled:!menu.a.scheduled})}>{menu.a.scheduled?t('恢复为普通会话'):t('标记为定时会话')}</button><p className="muted small">{t('定时会话默认不出现在工作台和等我，也不发提醒；可在“定时会话”中找回。')}</p><button role="menuitem" disabled={busy} onClick={()=>setEditing('title')}>{t('改名…')}</button><button role="menuitem" disabled={busy} onClick={()=>setEditing('project')}>{t('关联项目…')}</button>{canDelete(menu.a)&&<><hr/><button role="menuitem" className="danger" disabled={busy} onClick={()=>setEditing('delete')}>{t('删除会话…')}</button></>}</>}
    {error&&<p role="alert" className="danger">{editing==='delete'?t('删除失败：{err}',{err:error.replace(/^Error: /,'')}):t('保存失败：{err}',{err:error})}</p>}
  </div></div>}</Context.Provider></ItemsContext.Provider></CloseContext.Provider>;
}
export function ConversationMenuButton({a}:{a:Activity}){const t=useT();const open=useConversationMenu();return <button className="btn sm" title={t('会话操作（也可右键）')} aria-label={t('会话操作：{title}',{title:a.title})} onClick={e=>open(a,e)}>{t('更多')}</button>;}
