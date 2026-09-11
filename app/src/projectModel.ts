import type { Activity, Issue, SessionRef } from './types';
import { UNGROUPED_PROJECT, conversationProject } from './activity';
import { projectOf } from './derive';
export const isOutcome = (i:Issue) => !!i.labels?.includes('dispatch:outcome');
export const originSession = (i:Issue) => i.labels?.find(l=>l.startsWith('session-origin:'))?.slice(15) || '';
export const linkedSessions = (i:Issue) => [...new Set([originSession(i), ...(i.labels||[]).filter(l=>l.startsWith('session:')).map(l=>l.slice(8))].filter(Boolean))];
export const sourceTasks = (i:Issue) => (i.labels||[]).filter(l=>l.startsWith('outcome-task:')).map(l=>l.slice(13));
// Project names the board already knows: task labels and hand-set conversation projects.
export const knownProjects = (tasks:Issue[], rows:Activity[]=[]) => [...new Set([...tasks.map(projectOf),...rows.map(a=>a.project_override||'')].filter(Boolean))];
// The folder a project's new session should default to: the cwd most of its sessions live in
// (ties → most recently active). A single hand-linked session from another folder must not steer it.
export function projectHome(sessions:Activity[]):Activity|undefined {
  const dirs=new Map<string,{count:number;last:number;latest:Activity}>();
  for(const a of sessions){const d=(a.cwd||'').replace(/\/+$/,'');if(!d)continue;const cur=dirs.get(d)||{count:0,last:-1,latest:a};cur.count++;if(a.last_at>cur.last){cur.last=a.last_at;cur.latest=a;}dirs.set(d,cur);}
  return [...dirs.values()].sort((x,y)=>y.count-x.count||y.last-x.last)[0]?.latest ?? sessions[0];
}
export function projectGroups(rows:Activity[], tasks:Issue[], outcomes:Issue[]) {
  const names=[...new Set([...rows.map(conversationProject),...tasks.map(i=>projectOf(i)||UNGROUPED_PROJECT),...outcomes.map(i=>projectOf(i)||UNGROUPED_PROJECT)])];
  return names.map(name=>{
    const sessions=rows.filter(a=>conversationProject(a)===name);
    const items=tasks.filter(i=>(projectOf(i)||UNGROUPED_PROJECT)===name);
    const results=outcomes.filter(i=>(projectOf(i)||UNGROUPED_PROJECT)===name);
    const last=Math.max(0,...sessions.map(a=>a.last_at),...items.map(i=>Date.parse(i.updated_at)/1000||0),...results.map(i=>Date.parse(i.updated_at)/1000||0));
    return {name,sessions,items,results,last};
  }).sort((a,b)=>b.last-a.last);
}

// Historical catalog entries remain visible without inventing live state or unread replies.
export function projectConversations(live:Activity[], refs:SessionRef[]):Activity[] {
  const keys=new Set(live.map(a=>`${a.host||'local'}:${a.agent}:${a.session_id}`));
  return [...live,...refs.filter(r=>!keys.has(`${r.host||'local'}:${r.agent}:${r.session_id}`)).map(r=>({
    ...r,key:`${r.agent}:${r.session_id}`,tasks:Object.keys(r.tasks||{}),state:'unknown',stale:true,
    unread:false,activity:'历史会话，打开查看完整记录',version:'',events:[],tracking_since:0,source:'catalog'
  }))].sort((a,b)=>b.last_at-a.last_at);
}
