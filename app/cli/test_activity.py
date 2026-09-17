# -*- coding: utf-8 -*-
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

    def zcode(self, *rows, agent='zcode'):
        """A miniature ZCode / OpenCode SQLite store: rows are (session, message, [parts]).
        OpenCode's tables have no `sequence` column."""
        import sqlite3
        from activity import SQLITE_STORES
        seq = agent == 'zcode'
        path = os.path.join(self.home, SQLITE_STORES[agent][0])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        z = sqlite3.connect(path)
        extra = ', sequence INTEGER' if seq else ''
        z.executescript('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);'
                        f'CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT{extra});'
                        f'CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT{extra});')
        for sess, msg, parts in rows:
            z.execute('INSERT OR REPLACE INTO session VALUES (?,?,?,?,?,?,?)', (sess['id'], None, sess['dir'], sess.get('title', ''), sess['at'], sess['updated'], None))
            if msg:
                z.execute(f'INSERT OR REPLACE INTO message VALUES (?,?,?,?,?{",?" if seq else ""})', (msg['id'], sess['id'], msg['at'], msg['at'], json.dumps(msg['data'])) + ((msg.get('seq', 0),) if seq else ()))
                for n, part in enumerate(parts):
                    z.execute(f'INSERT OR REPLACE INTO part VALUES (?,?,?,?,?,?{",?" if seq else ""})', (f"{msg['id']}-{n}", msg['id'], sess['id'], msg['at'] + n, msg['at'] + n, json.dumps(part)) + ((n,) if seq else ()))
        z.commit(); z.close()

    def test_zcode_sessions_join_the_activity_list(self):
        ms = lambda t: int(t * 1000)
        sess = {'id': 'sess_1', 'dir': '/tmp/谭师', 'title': '下载视频', 'at': ms(self.t - 60), 'updated': ms(self.t - 5)}
        user = {'id': 'm1', 'at': ms(self.t - 60), 'data': {'role': 'user', 'time': {'created': ms(self.t - 60)}}}
        working = {'id': 'm2', 'at': ms(self.t - 5), 'seq': 1, 'data': {'role': 'assistant', 'time': {'created': ms(self.t - 5)}}}
        self.zcode((sess, user, [{'type': 'text', 'text': '把全部视频下载下来'}]),
                   (sess, working, [{'type': 'tool', 'tool': 'Bash', 'state': {'status': 'running', 'input': {'command': 'yt-dlp …'}}}]))
        rows = activity_list(self.home, self.store, {'zcode:sess_1': {'tasks': {'task-1': 2}, 'entrypoint': 'desktop'}})
        self.assertEqual([r['agent'] for r in rows], ['zcode'])
        r = rows[0]
        self.assertEqual((r['key'], r['path'], r['project'], r['title'], r['tasks'], r['entrypoint']), ('zcode:sess_1', 'zcode:sess_1', '谭师', '下载视频', ['task-1'], 'desktop'))
        self.assertEqual((r['state'], r['stale'], r['unread']), ('working', False, False))
        self.assertTrue(r['activity'].startswith('Bash · '))
        self.assertEqual([e['kind'] for e in r['events']], ['user', 'tool'])
        # The turn ends with a stopped assistant message: idle, and its text is the unread reply.
        sess['updated'] = ms(self.t)
        done = {'id': 'm2', 'at': ms(self.t - 5), 'seq': 1, 'data': {'role': 'assistant', 'time': {'created': ms(self.t - 5), 'completed': ms(self.t)}, 'finish': 'stop'}}
        self.zcode((sess, done, [{'type': 'tool', 'tool': 'Bash', 'state': {'status': 'completed', 'input': {'command': 'yt-dlp …'}}}, {'type': 'text', 'text': '下载完成，共 12 个'}]))
        r = activity_list(self.home, self.store, {})[0]
        self.assertEqual((r['state'], r['activity'], r['unread'], r['reply_preview']), ('idle', '已回复', True, '下载完成，共 12 个'))
        self.assertAlmostEqual(float(r['reply_id'].split(':')[0]), self.t, delta=0.001)
        acknowledge(self.store, r['key'], r['reply_id'])
        self.assertFalse(activity_list(self.home, self.store, {})[0]['unread'])

    def test_opencode_sessions_join_the_activity_list_from_their_own_store(self):
        """OpenCode proper (~/.local/share/opencode/opencode.db, no `sequence` column) is read like ZCode, as agent opencode."""
        ms = lambda t: int(t * 1000)
        sess = {'id': 'ses_oc1', 'dir': '/tmp/notesapp', 'title': 'Greeting', 'at': ms(self.t - 60), 'updated': ms(self.t)}
        done = {'id': 'm2', 'at': ms(self.t - 5), 'data': {'role': 'assistant', 'time': {'created': ms(self.t - 5), 'completed': ms(self.t)}, 'finish': 'stop'}}
        self.zcode((sess, {'id': 'm1', 'at': ms(self.t - 60), 'data': {'role': 'user', 'time': {'created': ms(self.t - 60)}}}, [{'type': 'text', 'text': 'hi'}]),
                   (sess, done, [{'type': 'text', 'text': '你好！有什么可以帮你的？'}]), agent='opencode')
        rows = activity_list(self.home, self.store, {})
        self.assertEqual([(r['agent'], r['key'], r['project'], r['title']) for r in rows], [('opencode', 'opencode:ses_oc1', 'notesapp', 'Greeting')])
        self.assertEqual((rows[0]['state'], rows[0]['unread'], rows[0]['reply_preview']), ('idle', True, '你好！有什么可以帮你的？'))

    def hermes(self, sessions, messages):
        """A miniature Hermes state.db (~/.hermes/state.db): sessions + messages, OpenAI-style tool_calls."""
        import sqlite3
        path = os.path.join(self.home, '.hermes', 'state.db')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        z = sqlite3.connect(path)
        z.executescript('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, cwd TEXT, model TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER);'
                        'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT, reasoning_content TEXT, display_kind TEXT);')
        for s in sessions:
            z.execute('INSERT OR REPLACE INTO sessions (id, source, title, cwd, model, parent_session_id, started_at, ended_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)', (s['id'], s.get('source', 'cli'), s.get('title', ''), s.get('cwd', ''), 'glm', s.get('parent'), s['at'], s.get('ended'), s.get('last', s['at'])))
        for m in messages:
            z.execute('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)', (m['sid'], m['role'], m.get('content', ''), m.get('call_id'), json.dumps(m['calls']) if m.get('calls') else None, m.get('tool'), m['at']))
        z.commit(); z.close()

    def test_hermes_sessions_join_the_activity_list_from_state_db(self):
        """Hermes (~/.hermes/state.db) rows read like ZCode's: tool calls pair with their result rows, a
        reply without tool calls ends the turn, cron sessions carry entrypoint cron."""
        t = self.t
        call = [{'id': 'c1', 'type': 'function', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'ls ~/Alice_Master'})}}]
        self.hermes([{'id': 'h1', 'source': 'cli', 'title': '找一篇笔记', 'cwd': '/tmp/notesapp', 'at': t - 60, 'last': t},
                     {'id': 'cron_1', 'source': 'cron', 'title': 'flomo 存档 · 02:00', 'at': t - 300, 'ended': t - 240, 'last': t - 240}],
                    [{'sid': 'h1', 'role': 'user', 'content': '我库里那篇海德堡的秋天在哪', 'at': t - 60},
                     {'sid': 'h1', 'role': 'assistant', 'content': '我来找。', 'calls': call, 'at': t - 50},
                     {'sid': 'h1', 'role': 'tool', 'content': json.dumps({'output': '60-Creative/秋天.canvas'}), 'call_id': 'c1', 'tool': 'terminal', 'at': t - 40},
                     {'sid': 'h1', 'role': 'assistant', 'content': '在 60-Creative/秋天.canvas。', 'at': t},
                     {'sid': 'cron_1', 'role': 'user', 'content': '把 flomo 新笔记存档', 'at': t - 300},
                     {'sid': 'cron_1', 'role': 'assistant', 'content': '已存档 3 条。', 'at': t - 240}])
        rows = sorted(activity_list(self.home, self.store, {}), key=lambda r: r['key'])
        self.assertEqual([(r['agent'], r['key'], r['project'], r['title'], r['entrypoint']) for r in rows],
                         [('hermes', 'hermes:cron_1', os.path.basename(self.home), 'flomo 存档 · 02:00', 'cron'), ('hermes', 'hermes:h1', 'notesapp', '找一篇笔记', 'cli')])
        h1 = rows[1]
        self.assertEqual((h1['state'], h1['activity'], h1['unread'], h1['reply_preview']), ('idle', '已回复', True, '在 60-Creative/秋天.canvas。'))
        self.assertEqual([e['kind'] for e in h1['events']], ['user', 'tool', 'message', 'result', 'reply'])
        self.assertTrue(any(e['kind'] == 'tool' and e['text'].startswith('运行命令 · ls') for e in h1['events']))
        acknowledge(self.store, h1['key'], h1['reply_id'])
        self.assertFalse(next(r for r in activity_list(self.home, self.store, {}) if r['key'] == 'hermes:h1')['unread'])
        # A new message invalidates the cached parse.
        self.hermes([], [{'sid': 'h1', 'role': 'user', 'content': '打开它', 'at': t + 1}])
        h1 = next(r for r in activity_list(self.home, self.store, {}) if r['key'] == 'hermes:h1')
        self.assertEqual((h1['state'], h1['activity']), ('working', '正在处理你的消息'))

    def presence(self, sid, pid, state='working', last_at=None):
        folder = os.path.join(self.store, 'sessions'); os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, f'claude-code__{sid}.json'), 'w') as f:
            json.dump({'agent': 'claude-code', 'session_id': sid, 'agent_pid': pid, 'state': state, 'last_at': last_at if last_at is not None else self.t}, f)

    def test_long_tool_call_with_live_heartbeat_is_not_stale(self):
        # The transcript's last record is a tool call four minutes ago and nothing since.
        self.append({'timestamp': datetime.datetime.fromtimestamp(self.t - 240, datetime.timezone.utc).isoformat(), 'type': 'response_item',
                     'payload': {'type': 'function_call', 'call_id': 'c1', 'name': 'shell', 'arguments': '{"command":"make test"}'}})
        sid = self.row()['session_id']
        self.assertEqual((self.row()['state'], self.row()['stale']), ('working', True))
        # Hooks say the process is alive and working: a long tool call, still running.
        self.presence(sid, os.getpid(), last_at=self.t - 240)
        self.assertFalse(self.row()['stale'])
        # The heartbeat may even predate the transcript's last record (metadata lines land after PreToolUse).
        self.presence(sid, os.getpid(), last_at=self.t - 300)
        self.assertFalse(self.row()['stale'])
        # A dead process or an idle heartbeat proves nothing.
        self.presence(sid, 2 ** 22 + 12345, last_at=self.t)
        self.assertTrue(self.row()['stale'])
        self.presence(sid, os.getpid(), state='idle')
        self.assertTrue(self.row()['stale'])

    def test_background_sub_agents_keep_a_finished_turn_working(self):
        iso = lambda ts: datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()
        folder = os.path.join(self.home, '.claude/projects/-p')
        os.makedirs(os.path.join(folder, 's1', 'subagents'))
        path = os.path.join(folder, 's1.jsonl')
        sub = os.path.join(folder, 's1', 'subagents', 'agent-abc.jsonl')
        def add(*records):
            with open(path, 'a') as f:
                for r in records: f.write(json.dumps(r) + '\n')
        t = self.t - 600
        add({'type': 'user', 'timestamp': iso(t), 'message': {'role': 'user', 'content': '做两件事'}},
            {'type': 'assistant', 'timestamp': iso(t + 1), 'message': {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'tu1', 'name': 'Agent', 'input': {'description': '同步规则'}}]}},
            {'type': 'user', 'timestamp': iso(t + 2), 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'tu1', 'content': 'Async agent launched'}]},
             'toolUseResult': {'isAsync': True, 'status': 'async_launched', 'agentId': 'abc', 'description': '同步规则'}},
            {'type': 'assistant', 'timestamp': iso(t + 3), 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '子 Agent 在做，做完告诉你。'}]}})
        row = lambda: next(r for r in activity_list(self.home, self.store, {}) if r['agent'] == 'claude-code')
        # The reply is out and the sub-agent's file has not appeared for ten minutes: just a finished turn.
        self.assertEqual(row()['state'], 'idle')
        # The sub-agent writes: the session is still working, and says who.
        open(sub, 'w').write('{}\n'); os.utime(sub, (self.t, self.t))
        r = row()
        self.assertEqual((r['state'], r['stale']), ('working', False))
        self.assertIn('子 Agent 在跑 · 同步规则', r['activity'])
        self.assertEqual([a['id'] for a in r['background_agents']], ['abc'])
        self.assertGreaterEqual(r['last_at'], self.t - 1)
        self.assertNotIn('bg_agents', r)
        # Its completion notification arrives (a queued_command attachment): the turn is done.
        os.utime(sub, (self.t - 30, self.t - 30))
        add({'type': 'attachment', 'timestamp': iso(self.t - 20), 'attachment': {'type': 'queued_command', 'commandMode': 'task-notification',
             'prompt': '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>'}})
        self.assertEqual(row()['state'], 'idle')
        # Resumed with SendMessage: it writes after its report, so the session works again.
        os.utime(sub, (self.t, self.t))
        self.assertEqual(row()['state'], 'working')
        # Silent for longer than BACKGROUND_QUIET (crashed, hung): no longer claims the session.
        from activity import BACKGROUND_QUIET
        old = self.t - BACKGROUND_QUIET - 60
        os.utime(sub, (old, old)); os.utime(path, (old, old))
        add({'type': 'queue-operation', 'timestamp': iso(old), 'content': 'noop'})
        self.assertEqual(row()['state'], 'idle')

    def test_transcript_states_answer_for_the_asked_sessions(self):
        from activity import transcript_states
        self.append(record('user', '问题', self.t - 50), record('assistant', '答完了', self.t - 40))
        sid = self.row()['session_id']
        got = transcript_states(self.store, [sid, 'nobody'])
        self.assertEqual(list(got), [sid]); self.assertEqual(got[sid][0], 'idle'); self.assertAlmostEqual(got[sid][1], self.t - 40, delta=0.001)
        self.assertEqual(transcript_states(self.store, []), {})

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
        set_preferences(self.store,a['key'],{'starred':True,'archived':False})
        self.assertEqual(session_preferences(self.store)[a['key']].get('starred'), True)
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'starred':'yes'})
        self.assertEqual(self.row()['project_override'],'')
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'scheduled':'yes'})
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'unread':False})

    def test_title_override_renames_the_row_until_cleared(self):
        self.append(record('assistant','first',self.t))
        a=self.row(); derived=a['title']
        set_preferences(self.store,a['key'],{'title_override':'  给客户的报价单  '})
        b=self.row()
        self.assertEqual(b['title'],'给客户的报价单'); self.assertEqual(b['title_override'],'给客户的报价单')
        set_preferences(self.store,a['key'],{'title_override':''})
        self.assertEqual(self.row()['title'],derived)
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'title_override':'x'*121})
        with self.assertRaises(ValueError): set_preferences(self.store,a['key'],{'title_override':'a\nb'})

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

    def test_reply_to_harness_event_is_not_unread(self):
        # user asks → agent answers → user reads it → a hook event arrives → agent comments on it.
        self.append(record('user', '帮我看看', self.t), record('assistant', '看完了', self.t+1))
        a = self.row(); self.assertTrue(a['unread'])
        acknowledge(self.store, a['key'], a['reply_id'])
        self.assertFalse(self.row()['unread'])
        self.append(record('user', '<system-reminder>\nhook output\n</system-reminder>', self.t+2),
                    record('assistant', '那个钩子跑完了，没有新情况。', self.t+3))
        r = self.row()
        self.assertFalse(r['unread'])
        self.assertEqual(r['state'], 'idle')
        self.assertNotEqual(r.get('title', ''), '<system-reminder>')
        # A background task finishing is different: the report written after it is the reply the person waits for.
        self.append(record('user', '<task-notification>\n<task-id>abc</task-id>\n<summary>Background command done</summary>\n</task-notification>', self.t+4),
                    record('assistant', '构建完成，已装到本机和 mini。', self.t+5))
        r = self.row()
        self.assertTrue(r['unread']); self.assertEqual(r['reply_preview'], '构建完成，已装到本机和 mini。')
        self.assertNotEqual(r.get('title', ''), '<task-notification>')
        # and a real question afterwards is answered → unread again
        acknowledge(self.store, r['key'], r['reply_id'])
        self.append(record('user', '再看一下', self.t+6), record('assistant', '看了', self.t+7))
        self.assertTrue(self.row()['unread'])

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


class SharedCacheStaysCompatible(unittest.TestCase):
    """The activity cache file is shared by versions that differ (installed app, phone service,
    source checkout): an older one writes `streams` with five positional values (task-lhk2)."""

    def test_an_older_writer_still_works_after_a_newer_one_opened_the_file(self):
        import activity as A
        from contextlib import closing
        with tempfile.TemporaryDirectory() as d:
            with closing(A.connect(d)) as db, db:
                cols = [r[1] for r in db.execute('PRAGMA table_info(streams)')]
                self.assertEqual(cols, ['path', 'inode', 'off', 'mtime', 'data'])
                db.execute('INSERT OR REPLACE INTO streams VALUES (?,?,?,?,?)', ('/p.jsonl', 1, 2, 3.0, '{}'))   # what v0.7.33 does
                self.assertEqual(db.execute('SELECT count(*) FROM streams').fetchone()[0], 1)
                self.assertIn('stream_sids', {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")})
