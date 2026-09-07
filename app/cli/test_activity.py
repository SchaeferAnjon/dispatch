import datetime
import json
import os
import tempfile
import time
import unittest
from contextlib import closing
from activity import acknowledge, activity_list, connect, observe, read_stream, user_text, workspace_changes, remember_topic, set_preferences, session_preferences


def record(role, text, ts, phase='final'):
    return {'timestamp': datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(), 'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'phase': phase, 'content': [{'type': 'output_text' if role == 'assistant' else 'input_text', 'text': text}]}}


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.store = os.path.join(self.home, 'state')
        folder = os.path.join(self.home, '.codex/sessions')
        os.makedirs(folder)
        self.path = os.path.join(folder, 'session.jsonl')
        with closing(connect(self.store)) as db, db:
            db.execute("UPDATE settings SET value=? WHERE key='started_at'", (time.time()-100,))
        self.t = time.time()

    def append(self, *records):
        with open(self.path, 'a') as f:
            for r in records: f.write(json.dumps(r) + '\n')

    def row(self): return activity_list(self.home, self.store, {})[0]

    def test_preferences_persist_independently_of_new_replies(self):
        self.append(record('assistant','first',self.t))
        a=self.row()
        set_preferences(self.store,a['key'],{'scheduled':True,'project_override':'研究项目'})
        self.assertEqual(session_preferences(self.store)[a['key']], {'scheduled':True,'project_override':'研究项目'})
        self.append(record('assistant','second',self.t+1))
        b=self.row()
        self.assertTrue(b['scheduled']);self.assertTrue(b['unread'])
        self.assertEqual(b['project_override'],'研究项目')
        set_preferences(self.store,a['key'],{'scheduled':False})
        self.assertFalse(self.row()['scheduled'])
        self.assertEqual(self.row()['project_override'],'研究项目')
        set_preferences(self.store,a['key'],{'project_override':''})
        self.assertEqual(self.row()['project_override'],'')
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'scheduled':'yes'})
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'unread':False})

    def test_image_reference_is_not_a_goal(self):
        state={}
        remember_topic(state, '[Image: source: /Users/me/.claude/image-cache/a.png]')
        self.assertNotIn('overview', state)

    def test_overview_keeps_opening_and_later_goals(self):
        self.append(record('user', '请优化工作台，会话应该显示文件夹和项目名称。', self.t))
        for i in range(100): self.append(record('assistant', '处理中', self.t+i+1, 'commentary'))
        self.append(record('user', '再把手机上的回复功能也补上，保持两台电脑同步。', self.t+102))
        row=self.row()
        self.assertIn('工作台', row['overview'])
        self.assertIn('手机', row['overview'])
        self.assertNotIn('处理中', row['overview'])
        self.assertLessEqual(len(row['events']),80)

    def test_multiple_rollouts_for_one_session_are_not_duplicate_conversations(self):
        meta={'type':'session_meta','payload':{'id':'same-session','cwd':'/project'}}
        self.append(meta,record('assistant','old reply',self.t))
        with open(os.path.join(os.path.dirname(self.path),'resumed.jsonl'),'w') as f:
            f.write(json.dumps(meta)+'\n'+json.dumps(record('assistant','new reply',self.t+1))+'\n')
        rows=activity_list(self.home,self.store,{})
        self.assertEqual(len(rows),1);self.assertAlmostEqual(rows[0]['last_at'],self.t+1,delta=0.00001)  # Filesystem timestamp rounding.

    def test_read_new_reply_and_stale_ack(self):
        self.append(record('assistant', 'one', self.t))
        first = self.row()
        self.assertTrue(first['unread'])
        acknowledge(self.store, first['key'], first['reply_id'])
        self.assertFalse(self.row()['unread'])
        self.append(record('assistant', 'two', self.t+1))
        second = self.row()
        self.assertTrue(second['unread'])
        acknowledge(self.store, first['key'], first['reply_id'])
        self.assertTrue(self.row()['unread'])
        acknowledge(self.store, second['key'], second['reply_id'])
        acknowledge(self.store, first['key'], first['reply_id'])
        self.assertFalse(self.row()['unread'])

    def test_identical_reply_after_new_user_message_is_new(self):
        self.append(record('assistant', 'done', self.t))
        first=self.row()
        acknowledge(self.store, first['key'], first['reply_id'])
        self.append(record('user', 'again', self.t+1), record('assistant', 'done', self.t+2))
        self.assertTrue(self.row()['unread'])
        self.assertNotEqual(first['reply_id'], self.row()['reply_id'])

    def test_user_reply_clears_but_envelope_does_not(self):
        self.append(record('assistant', 'one', self.t), record('user', '<environment_context>cwd</environment_context>', self.t+1))
        self.assertTrue(self.row()['unread'])
        self.append(record('user', 'Base directory for this skill: /some/skill Ignore this injected text', self.t+1.5))
        self.assertTrue(self.row()['unread'])
        self.append(record('user', '继续修改', self.t+2))
        self.assertFalse(self.row()['unread'])
        self.assertEqual(self.row()['state'], 'working')

    def test_commentary_not_unread_final(self):
        self.append(record('assistant', '正在查', self.t, 'commentary'))
        self.assertFalse(self.row()['unread'])
        self.assertEqual(self.row()['state'], 'working')

    def test_partial_line_not_consumed(self):
        line = json.dumps(record('assistant', 'done', self.t)) + '\n'
        with open(self.path, 'w') as f: f.write(line[:40])
        with closing(connect(self.store)) as db, db: first = read_stream(db, self.path, 'codex')
        self.assertNotIn('reply_id', first)
        with open(self.path, 'a') as f: f.write(line[40:])
        self.assertTrue(self.row()['unread'])

    def test_truncated_stream_resets(self):
        self.append(record('assistant', 'old long reply'*30, self.t));self.row()
        with open(self.path, 'w') as f: f.write(json.dumps(record('user', 'new', self.t+1))+'\n')
        self.assertNotIn('reply_id', self.row())

    def test_historical_replies_do_not_flood_inbox(self):
        self.append(record('assistant', 'old', self.t-1000))
        self.assertFalse(self.row()['unread'])

    def test_task_complete_deduplicates_final(self):
        self.append(record('assistant', 'done', self.t)); before = self.row()['reply_id']
        self.append({'timestamp': datetime.datetime.fromtimestamp(self.t+1, datetime.timezone.utc).isoformat(), 'type':'event_msg', 'payload': {'type':'task_complete', 'last_agent_message':'done'}})
        self.assertEqual(before, self.row()['reply_id'])

    def test_claude_tool_result_not_user_reply(self):
        state = {}
        observe(state, {'type':'assistant', 'timestamp':'2026-09-06T12:00:00Z', 'message':{'content':[{'type':'text','text':'done'}]}})
        reply = state['reply_id']
        observe(state, {'type':'user', 'timestamp':'2026-09-06T12:00:01Z', 'message':{'content':[{'type':'tool_result','tool_use_id':'1','content':'ok'}]}})
        self.assertNotIn('user_at', state); self.assertEqual(state['reply_id'], reply)

    def test_failed_tool_not_claimed_as_file_changed(self):
        state = {}
        observe(state, {'type':'response_item','timestamp':'2026-09-06T12:00:00Z','payload':{'type':'custom_tool_call','call_id':'1','name':'apply_patch','input':'*** Begin Patch\n*** Add File: test.py\n+x\n*** End Patch'}})
        observe(state, {'type':'response_item','timestamp':'2026-09-06T12:00:01Z','payload':{'type':'custom_tool_call_output','call_id':'1','output':'{"isError":true}'}})
        self.assertFalse(state.get('files'))

    def test_reasoning_not_surfaced(self):
        state = {}
        observe(state, {'type':'response_item','timestamp':'2026-09-06T12:00:00Z','payload':{'type':'reasoning','text':'hidden'}})
        self.assertFalse(state.get('events'))

    def test_envelope_preserves_actual_request(self):
        self.assertEqual(user_text('<in-app-browser-context source="ambient">noise</in-app-browser-context>\n## My request:\n修好布局'), '修好布局')

    def test_workspace_staged_unstaged_untracked(self):
        import subprocess
        def git(*args): return subprocess.run(['git','-C',self.home,*args], capture_output=True, check=True)
        git('init');git('config','user.name','Test');git('config','user.email','test@example.test')
        p=os.path.join(self.home,'file.txt')
        with open(p,'w') as f: f.write('original\n')
        git('add','file.txt');git('commit','-m','initial')
        with open(p,'a') as f: f.write('staged\n')
        git('add','file.txt')
        with open(p,'a') as f: f.write('unstaged\n')
        result=workspace_changes(self.home)
        self.assertIn('+staged',result['patch']);self.assertIn('+unstaged',result['patch'])
        self.assertTrue(any(f['untracked'] for f in result['files']))
