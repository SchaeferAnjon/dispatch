import { describe, expect, it } from 'vitest';
import type { Activity, Issue, SessionRef } from './types';
import { projectConversations, isOutcome, linkedSessions, originSession, projectGroups, sourceTasks } from './projectModel';

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
