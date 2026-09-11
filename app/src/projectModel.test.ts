import { describe, expect, it } from 'vitest';
import type { Activity, Issue, SessionRef } from './types';
import { projectConversations, isOutcome, knownProjects, linkedSessions, originSession, projectGroups, projectHome, sourceTasks } from './projectModel';

describe('project ownership and outcomes', () => {
  const task = {id:'task-one',labels:['project:demo'],updated_at:'2026-09-07T12:00:00Z'} as Issue;
  const session = {session_id:'conversation-a',project:'demo',cwd:'/work/demo',last_at:1,tasks:['task-one']} as Activity;
  it('keeps historical conversations and their manual classification without false unread state', () => {
    const rows=projectConversations([session],[{...session,session_id:'older',scheduled:true,project_override:'research'} as unknown as SessionRef]);
    expect(rows).toHaveLength(2);
    expect(rows.find(a=>a.session_id==='older')).toMatchObject({scheduled:true,project_override:'research',unread:false,stale:true});
    expect(projectConversations([session],[session as unknown as SessionRef])).toHaveLength(1);
  });
  it('does not turn a mention or a shared project into ownership', () => {
    expect(linkedSessions(task)).toEqual([]);
    expect(projectGroups([session],[task],[])[0].items).toEqual([task]);
    expect(originSession({...task,labels:['session:conversation-a']})).toBe('');
  });
  it('keeps one origin and multiple participating conversations without duplicates', () => {
    const i={...task,labels:['session-origin:conversation-a','session:conversation-a','session:conversation-b']};
    expect(originSession(i)).toBe('conversation-a');
    expect(linkedSessions(i)).toEqual(['conversation-a','conversation-b']);
  });
  it('retains multiple task and conversation sources for one outcome', () => {
    const i={...task,labels:['dispatch:outcome','outcome-task:task-one','outcome-task:task-two','session:conversation-a','session:conversation-b']};
    expect(isOutcome(i)).toBe(true);
    expect(sourceTasks(i)).toEqual(['task-one','task-two']);
    expect(linkedSessions(i)).toHaveLength(2);
    expect(isOutcome(task)).toBe(false);
  });
  it('includes conversation-only and outcome-only projects, honoring a manual assignment', () => {
    const groups=projectGroups([{...session,project_override:'research'}],[],[{...task,labels:['project:delivery','dispatch:outcome']}]);
    expect(groups.map(p=>p.name).sort()).toEqual(['delivery','research']);
    expect(groups.find(p=>p.name==='delivery')?.items).toEqual([]);
  });
});

describe('known project names', () => {
  it('collects task labels and hand-set conversation projects once', () => {
    const rows=[{project_override:'研究'} as Activity,{project_override:''} as Activity,{project_override:'研究'} as Activity];
    expect(knownProjects([{labels:['project:demo']} as Issue,{labels:[] as string[]} as Issue],rows)).toEqual(['demo','研究']);
  });
});

describe('projectHome — default folder for a project\'s new session', () => {
  const s=(cwd:string,last_at:number,extra:Partial<Activity>={})=>({key:`claude-code:${cwd}:${last_at}`,session_id:`${last_at}`,agent:'claude-code',cwd,project:cwd.split('/').pop(),last_at,...extra} as Activity);
  const hiwi='/Users/x/iCloud/HIWI', kanban='/Users/x/Projects/kanban';
  it('prefers the folder most sessions live in, not the most recent session\'s folder', () => {
    const rows=[s(kanban,500,{project_override:'HIWI'}),s(hiwi,400),s(hiwi,300),s(hiwi,200)];
    expect(projectHome(rows)?.cwd).toBe(hiwi);
    expect(projectHome(rows)?.last_at).toBe(400);
  });
  it('breaks a count tie by recency', () => {
    expect(projectHome([s(kanban,500),s(hiwi,400)])?.cwd).toBe(kanban);
  });
  it('ignores trailing slashes and sessions without a folder', () => {
    expect(projectHome([s(`${hiwi}/`,1),s(hiwi,2),s('',9),s(kanban,3)])?.cwd).toBe(hiwi);
  });
  it('falls back to the first session when no session has a folder', () => {
    const rows=[s('',2),s('',1)];
    expect(projectHome(rows)).toBe(rows[0]);
    expect(projectHome([])).toBeUndefined();
  });
});
