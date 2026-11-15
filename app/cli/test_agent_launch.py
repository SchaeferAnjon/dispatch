# -*- coding: utf-8 -*-
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import dispatch as D
import serve
import summarize as S
import json, tempfile, threading, time

WINDOWS_READY = True
PROJECT = os.path.abspath('/project')  # '/project' on macOS, 'D:\\project' on a Windows runner


class FakeChat:
    """chatd as `dispatch agent` sees it: request() answers, wait() hands out scripted events."""
    def __init__(self, events=(), sessions=()):
        self.requests = []
        self.events = list(events)
        self.sessions = list(sessions)
        self.waited = False

    def __enter__(self): return self
    def __exit__(self, *exc): pass
    def new_id(self): return 'm1'

    def request(self, cmd, timeout=60.0, **f):
        self.requests.append((cmd, f))
        if cmd == 'open':
            return {'ev': 'opened', 'session': f"{f['agent']}:s1"}
        if cmd == 'send':
            return {'ev': 'turn_started', 'session': f['session'], 'turn_id': 't1', 'message_id': f['message_id']}
        if cmd == 'list':
            return {'ev': 'sessions', 'sessions': self.sessions}
        return {'ev': 'closed' if cmd == 'close' else 'state', 'session': f.get('session')}

    def wait(self, match, timeout):
        self.waited = True
        for e in self.events:
            if match(e):
                return e
        return None


class AgentLaunch(unittest.TestCase):
    """`dispatch agent start` opens an in-app chat in the running Dispatch (chatd)."""
    def launch(self, kind='codex', prompt='read only', wait=False, label='', cwd=PROJECT, auto=False, task=None,
               events=(), owner=None, target=None, isdir=True, extra='', resume=None):
        self.chat = FakeChat(events)
        args = SimpleNamespace(op='start', kind=kind, host=target['id'] if target else None, cwd=cwd, task=task,
            label=label, name='', extra=extra, model='', auto=auto, prompt=prompt, resume=resume,
            wait=wait, timeout=600000, lines=80, json=True, focus=False)
        with patch.object(D, 'chat_client', return_value=self.chat), patch.object(D, 'local_host_name', return_value='Apple'), \
             patch.object(D, 'target_host', return_value=target), patch.object(D, 'owner_elsewhere', return_value=owner), \
             patch.object(D.os.path, 'isdir', return_value=isdir), patch.object(D, 'proxy_to_host', return_value='proxied') as self.proxy, \
             patch.object(D, 'claim_for_agent') as self.claim, patch.object(D, 'bd_json', return_value={'title': '修登录'}), \
             patch.object(D, 'out', side_effect=lambda result, *unused: result):
            return D.cmd_agent(args)

    def opened(self):
        return next(f for cmd, f in self.chat.requests if cmd == 'open')

    def test_opens_an_in_app_chat_and_sends_nothing_without_a_prompt(self):
        for kind, agent in (('claude', 'claude-code'), ('codex', 'codex'), ('opencode', 'opencode')):
            with self.subTest(kind=kind):
                r = self.launch(kind=kind, prompt='')
                self.assertEqual(self.opened()['agent'], agent)
                self.assertEqual(self.opened()['cwd'], PROJECT)
                self.assertNotIn('send', [c for c, _ in self.chat.requests])
                self.assertEqual((r['pane_id'], r['session'], r['host']), (f'{agent}:s1', f'{agent}:s1', 'Apple'))

    def test_only_the_chat_agents_start(self):
        with self.assertRaisesRegex(SystemExit, 'Claude, Codex and OpenCode'):
            self.launch(kind='pi')

    def test_missing_project_directory_opens_nothing(self):
        with self.assertRaisesRegex(SystemExit, 'Folder does not exist'):
            self.launch(isdir=False)
        self.assertEqual(self.chat.requests, [])

    def test_a_folder_under_this_macs_home_starts_in_the_same_place_on_the_other_mac(self):
        mini = {'id': 'mini', 'name': 'Apple', 'ssh': 'apple@100.64.0.11'}
        self.assertEqual(self.launch(prompt='', cwd=os.path.join(D.HOME, 'Projects', 'kanban'), target=mini), 'proxied')
        self.assertIn('--cwd=~/Projects/kanban', self.proxy.call_args.args[0])

    def test_no_wait_returns_once_the_prompt_went_out(self):
        r = self.launch(prompt='read only', wait=False)
        self.assertEqual(next(f for c, f in self.chat.requests if c == 'send')['text'], 'read only')
        self.assertFalse(self.chat.waited)
        self.assertEqual((r['prompt_sent'], r['status']), (True, 'working'))

    def test_wait_returns_what_this_turn_wrote_and_nothing_from_other_sessions(self):
        events = [{'ev': 'text_done', 'session': 'codex:other', 'turn_id': 'x', 'text': 'not mine'},
                  {'ev': 'text_done', 'session': 'codex:s1', 'turn_id': 't1', 'text': 'first'},
                  {'ev': 'text_done', 'session': 'codex:s1', 'turn_id': 't1', 'text': 'second'},
                  {'ev': 'turn_done', 'session': 'codex:s1', 'turn_id': 't1', 'status': 'success'}]
        r = self.launch(wait=True, events=events)
        self.assertEqual((r['status'], r['output']), ('idle', 'first\n\nsecond'))

    def test_a_queued_message_waits_for_its_own_turn_not_the_running_one(self):
        events = [{'ev': 'text_done', 'session': 'codex:s1', 'turn_id': 't0', 'text': 'handoff reply'},
                  {'ev': 'turn_done', 'session': 'codex:s1', 'turn_id': 't0', 'status': 'success'},
                  {'ev': 'turn_started', 'session': 'codex:s1', 'turn_id': 't1', 'message_id': 'm1'},
                  {'ev': 'text_done', 'session': 'codex:s1', 'turn_id': 't1', 'text': 'before'},
                  {'ev': 'turn_done', 'session': 'codex:s1', 'turn_id': 't1', 'status': 'success'}]
        with patch.object(FakeChat, 'request', lambda self, cmd, timeout=60.0, **f: self.requests.append((cmd, f)) or (
                {'ev': 'queued', 'session': f['session'], 'message_id': f['message_id']} if cmd == 'send' else {'ev': 'opened', 'session': f"{f['agent']}:s1"})):
            r = self.launch(wait=True, events=events)
        self.assertEqual((r['status'], r['output']), ('idle', 'before'))

    def test_a_permission_prompt_is_reported_not_waited_out(self):
        r = self.launch(wait=True, events=[{'ev': 'permission_request', 'session': 'codex:s1', 'turn_id': 't1', 'summary': 'rm -rf build'}])
        self.assertEqual(r['status'], 'blocked')
        self.assertIn('rm -rf build', r['warning'])
        self.assertEqual(D.permission_what({'tool_name': 'Write', 'summary': '/p/a.txt'}), 'Write · /p/a.txt')
        self.assertEqual(D.permission_what({'tool_name': 'NotebookEdit', 'summary': 'NotebookEdit', 'diff': {'path': '/p/nb.ipynb'}}), 'NotebookEdit · /p/nb.ipynb')

    def test_a_turn_still_running_at_the_timeout_says_so(self):
        r = self.launch(wait=True, events=[])
        self.assertEqual(r['status'], 'working')
        self.assertIn('dispatch agent wait', r['warning'])

    def test_task_or_auto_runs_unattended_and_task_is_claimed(self):
        self.launch(task='task-1', prompt='')
        self.assertEqual(self.opened()['permission_mode'], 'bypassPermissions')
        self.assertEqual(self.opened()['task'], 'task-1')
        self.claim.assert_called_once()
        self.launch(auto=True, prompt='')
        self.assertEqual(self.opened()['permission_mode'], 'bypassPermissions')
        self.launch(prompt='')
        self.assertNotIn('permission_mode', self.opened())  # the person's own settings decide

    def test_resume_goes_on_with_the_conversation_and_a_move_skips_the_owner_check(self):
        self.launch(prompt='', resume='th-1')
        self.assertEqual(self.opened()['resume'], 'th-1')
        self.assertNotIn('moving', self.opened())
        with patch.dict(D.os.environ, {'DISPATCH_MOVE': '1'}):
            self.launch(prompt='', resume='th-1')
        self.assertTrue(self.opened()['moving'])

    def test_effort_from_extra_is_kept(self):
        self.launch(prompt='', extra='--effort high')
        self.assertEqual(self.opened()['effort'], 'high')

    def test_start_aimed_at_a_peer_for_this_macs_project_runs_here(self):
        hub = {'id': 'hub', 'name': '小蓝', 'ssh': 'dev@100.64.0.12'}
        r = self.launch(prompt='', cwd='/Users/dev/Projects/harbor', target=hub,
                        owner={'project': 'harbor', 'host': 'Apple', 'peer': None, 'here': True})
        self.assertEqual(self.opened()['cwd'], os.path.join(D.HOME, 'Projects', 'harbor'))
        self.proxy.assert_not_called()
        self.assertEqual(r['host'], 'Apple')

    def test_start_on_another_mac_runs_there(self):
        hub = {'id': 'hub', 'name': '小蓝', 'ssh': 'dev@100.64.0.12'}
        self.assertEqual(self.launch(prompt='hi', cwd='~/Projects/x', target=hub), 'proxied')
        self.assertEqual(self.proxy.call_args.args[0][:5], ['--host', 'hub', 'agent', 'start', 'codex'])
        self.assertEqual(self.chat.requests, [])

    def test_web_launch_uses_non_waiting_cli(self):
        with patch.object(serve, 'sh', return_value='{}') as run:
            serve.commands()['agent_start']({'kind': 'codex', 'prompt': 'read only'}, 'user')
            self.assertIn('--no-wait', run.call_args.args[0])

    def test_first_message_gives_a_short_label_now(self):
        with patch('activity.set_preferences') as saved:
            self.launch(prompt='帮我看一下 tmp 目录里有什么文件')
        saved.assert_not_called()  # the namer names it after the first turn
        self.assertEqual(self.opened()['label'], '帮我看一下')

    def test_old_app_label_that_is_a_prefix_of_the_message_is_replaced(self):
        msg = 'Please review the release notes for the new build'
        self.launch(prompt=msg, label=msg[:24])
        self.assertEqual(self.opened()['label'], 'Please review the')

    def test_real_label_is_kept_and_becomes_the_title(self):
        with patch('activity.set_preferences') as saved:
            self.launch(prompt='检查一下迁移后的项目', label='迁移检查 · kanban')
        self.assertEqual(self.opened()['label'], '迁移检查 · kanban')
        self.assertEqual(saved.call_args.args[1:], ('codex:s1', {'title_override': '迁移检查 · kanban'}))

    def test_no_label_and_no_message_leaves_naming_to_chatd(self):
        self.launch(prompt='')
        self.assertNotIn('label', self.opened())


class AgentTalk(unittest.TestCase):
    """ask / read / wait / close / list / keys on a session chatd holds."""
    SESSIONS = [{'session': 'claude-code:abc123', 'lifecycle': 'idle', 'label': '修登录', 'task': 'task-9', 'cwd': PROJECT}]

    def run_op(self, op, target='修登录', text=None, events=(), sessions=None, host=None):
        self.chat = FakeChat(events, self.SESSIONS if sessions is None else sessions)
        args = SimpleNamespace(op=op, kind=target, target=target, text=text, more=[], host=host, wait=True, timeout=60000, lines=80, json=True)
        with patch.object(D, 'chat_client', return_value=self.chat), patch.object(D, 'local_host_name', return_value='Apple'), \
             patch.object(D, 'target_host', side_effect=lambda h: {'id': h, 'name': h} if h else None), \
             patch.object(D, 'proxy_to_host', return_value='proxied') as self.proxy, \
             patch.object(D, 'last_reply', return_value='the reply'), \
             patch.object(D, 'out', side_effect=lambda result, *unused: result):
            return D.cmd_agent(args)

    def test_session_is_found_by_label_task_or_id_start(self):
        for target in ('修登录', 'task-9', 'abc', 'claude-code:abc123'):
            with self.subTest(target=target):
                self.assertEqual(self.run_op('read', target=target)['session'], 'claude-code:abc123')

    def test_ask_sends_and_returns_the_turn(self):
        r = self.run_op('ask', text='再看一眼', events=[{'ev': 'text_done', 'session': 'claude-code:abc123', 'turn_id': 't1', 'text': '好了'},
                                                     {'ev': 'turn_done', 'session': 'claude-code:abc123', 'turn_id': 't1', 'status': 'success'}])
        self.assertEqual((r['output'], r['status']), ('好了', 'idle'))
        self.assertEqual(next(f for c, f in self.chat.requests if c == 'send')['text'], '再看一眼')

    def test_a_closed_transcript_is_opened_again_to_be_asked(self):
        with patch.object(D, 'resolve', return_value=[{'agent': 'codex', 'session_id': 'th-1', 'cwd': PROJECT}]), patch.object(D, 'load_index', return_value={}):
            r = self.run_op('ask', target='th-1', text='继续', sessions=[], events=[{'ev': 'turn_done', 'session': 'codex:s1', 'turn_id': 't1', 'status': 'success'}])
        self.assertEqual(self.chat.requests[1], ('open', {'agent': 'codex', 'cwd': PROJECT, 'resume': 'th-1'}))
        self.assertEqual(r['session'], 'codex:s1')

    def test_unknown_session_is_refused(self):
        with patch.object(D, 'resolve', return_value=[]), patch.object(D, 'load_index', return_value={}):
            with self.assertRaisesRegex(SystemExit, '没有 nope 这个会话'):
                self.run_op('read', target='nope', sessions=[])

    def test_wait_on_an_idle_session_returns_at_once(self):
        self.assertEqual(self.run_op('wait')['status'], 'idle')
        self.assertFalse(self.chat.waited)

    def test_wait_on_a_running_session_follows_it_to_turn_done(self):
        running = [dict(self.SESSIONS[0], lifecycle='running')]
        r = self.run_op('wait', sessions=running, events=[{'ev': 'turn_done', 'session': 'claude-code:abc123', 'status': 'success'}])
        self.assertEqual(r['status'], 'idle')

    def test_wait_on_a_session_already_asking_the_person_is_blocked_at_once(self):
        for lifecycle in ('waiting_permission', 'waiting_input'):
            r = self.run_op('wait', sessions=[dict(self.SESSIONS[0], lifecycle=lifecycle)])
            self.assertEqual(r['status'], 'blocked')
            self.assertFalse(self.chat.waited)

    def test_close_and_list(self):
        self.assertEqual(self.run_op('close')['closed'], 'claude-code:abc123')
        rows = self.run_op('list', target=None)
        self.assertEqual((rows[0]['agent'], rows[0]['title'], rows[0]['task']), ('claude', '修登录', 'task-9'))

    def test_keys_are_refused(self):
        with self.assertRaisesRegex(SystemExit, '没有终端按键'):
            self.run_op('keys', text='enter')

    def test_another_mac_runs_the_same_command_there(self):
        with patch.object(D.sys, 'argv', ['dispatch', 'agent', 'ask', '修登录', 'hi', '--host', 'mini', '--json']):
            self.assertEqual(self.run_op('ask', text='hi', host='mini'), 'proxied')
        self.assertEqual(self.proxy.call_args.args[0], ['--host', 'mini', 'agent', 'ask', '修登录', 'hi', '--json'])
        self.assertEqual(self.chat.requests, [])

    def test_dispatch_not_open_is_said_plainly(self):
        import chat_client as CC
        with patch.object(CC.ChatClient, 'connect', side_effect=CC.NotRunning(CC.NOT_RUNNING)), patch.object(D, 'local_host_name', return_value='Apple'):
            with self.assertRaisesRegex(SystemExit, 'chatd is not running'):
                D.cmd_agent(SimpleNamespace(op='list', kind=None, target=None, host=None, timeout=None, json=True))


class OwnerMac(unittest.TestCase):
    """A project's Agents start only on the Mac dispatch-project-owners names."""
    HUB = {'id': 'hub', 'name': '小蓝', 'ssh': 'dev@100.64.0.12'}

    def owner(self, owners, cwd='/Users/apple/Projects/harbor', host=None, project='harbor', env=None):
        with patch.object(D, 'project_of_folder', return_value=project), patch.object(D, 'project_owners_load', return_value=owners), \
             patch.object(D, 'local_host_name', return_value='Apple'), patch.object(D, 'local_host_aliases', return_value=[]), \
             patch.object(D, 'tailscale_ip', return_value='100.64.0.11'), patch.object(D, 'hosts', return_value=[self.HUB]), \
             patch.dict(D.os.environ, env or {}, clear=False):
            if not env:
                D.os.environ.pop('DISPATCH_MOVE', None)
            return D.owner_elsewhere(cwd, host)

    def test_project_owned_by_the_other_mac_names_it(self):
        o = self.owner({'harbor': {'host': '小蓝', 'ip': '100.64.0.12', 'at': 1}})
        self.assertEqual((o['project'], o['host'], o['peer']['id'], o['here']), ('harbor', '小蓝', 'hub', False))
        self.assertEqual(self.owner({'Harbor': {'host': '小蓝', 'ip': '', 'at': 1}})['peer']['id'], 'hub')  # names match case-insensitively
        self.assertIsNone(self.owner({'harbor': {'host': '小蓝', 'ip': '', 'at': 1}}, host=self.HUB))  # aimed at the owner: fine

    def test_this_macs_project_is_free_here_and_pulled_back_from_a_peer(self):
        mine = {'harbor': {'host': 'Apple', 'ip': '100.64.0.11', 'at': 1}}
        self.assertIsNone(self.owner(mine))
        o = self.owner(mine, cwd='/Users/dev/Projects/harbor', host=self.HUB)
        self.assertEqual((o['here'], o['host']), (True, 'Apple'))

    def test_no_owner_no_project_or_a_move_in_progress_is_left_alone(self):
        theirs = {'harbor': {'host': '小蓝', 'ip': '', 'at': 1}}
        self.assertIsNone(self.owner({}))
        self.assertIsNone(self.owner(theirs, project=''))
        self.assertIsNone(self.owner(theirs, env={'DISPATCH_MOVE': '1'}))  # dispatch move resumes before the owner record changes
        unknown = self.owner({'harbor': {'host': '阁楼', 'ip': '', 'at': 1}})
        self.assertEqual((unknown['host'], unknown['peer']), ('阁楼', None))

    def test_refusal_says_where_and_what_to_do(self):
        with patch.object(D, 'local_host_name', return_value='Apple'):
            o = {'project': 'harbor', 'host': '小蓝', 'peer': self.HUB, 'here': False}
            self.assertEqual(D.owner_refusal(o), '项目 harbor 归「小蓝」，它的会话只在 小蓝 上开，没有在 Apple 上起 Agent。新建会话时主机选 小蓝。')
            self.assertTrue(D.owner_refusal(o, resume=True).endswith('这个会话的记录在 Apple 上：先把它迁到 小蓝（会话右键「迁到另一台」，或 dispatch move）再接着做。'))
            self.assertIn('hosts.json 里没有 阁楼', D.owner_refusal({'project': 'harbor', 'host': '阁楼', 'peer': None, 'here': False}))

    def test_home_relative_paths_travel_between_macs(self):
        self.assertEqual(D.home_relative('/Users/dev/Projects/kanban', self.HUB), '~/Projects/kanban')
        self.assertEqual(D.home_relative(os.path.join(D.HOME, 'Projects', 'harbor')), '~/Projects/harbor')
        self.assertEqual(D.home_relative('/opt/x', self.HUB), '/opt/x')

    def test_delegating_a_project_of_the_other_mac_runs_there(self):
        o = {'project': 'harbor', 'host': '小蓝', 'peer': self.HUB, 'here': False}
        cwd = os.path.join(D.HOME, 'Projects', 'harbor')
        args = SimpleNamespace(op='start', kind='claude', host=None, cwd=cwd, task='task-1', label='修登录', name='', model='sonnet',
                               extra='', auto=False, prompt='看一下', wait=False, timeout=600000, lines=80, json=True, focus=False)
        with patch.object(D, 'owner_elsewhere', return_value=o) as check, patch.object(D, 'proxy_to_host', return_value=None) as proxy, \
             patch.object(D, 'chat_client') as chat, patch.object(D, 'local_host_name', return_value='Apple'), patch.object(D.os.path, 'isdir', return_value=True):
            D.cmd_agent(args)
        self.assertEqual(check.call_args.args, (cwd, None))
        argv = proxy.call_args.args[0]
        self.assertEqual(argv[:5], ['--host', 'hub', 'agent', 'start', 'claude'])
        for want in ('--cwd=~/Projects/harbor', '--task=task-1', '--label=修登录', '--model=sonnet', '--prompt=看一下', '--no-wait', '--json'):
            self.assertIn(want, argv)
        chat.assert_not_called()

    def test_delegating_to_an_unknown_owner_is_refused(self):
        o = {'project': 'harbor', 'host': '阁楼', 'peer': None, 'here': False}
        args = SimpleNamespace(op='start', kind='claude', host=None, cwd='/Users/apple/Projects/harbor', task=None, focus=False, wait=False, timeout=None)
        with patch.object(D, 'owner_elsewhere', return_value=o), patch.object(D, 'chat_client') as chat, \
             patch.object(D, 'local_host_name', return_value='Apple'), patch.object(D.os.path, 'isdir', return_value=True):
            with self.assertRaisesRegex(SystemExit, '项目 harbor 归「阁楼」'):
                D.cmd_agent(args)
        chat.assert_not_called()


class ProjectOfFolder(unittest.TestCase):
    def test_other_macs_folder_is_matched_home_relative(self):
        host = {'name': '小蓝', 'ssh': 'dev@100.64.0.12'}
        with patch.object(D, 'settings_load', return_value={'workspace_roots': ['~/Projects']}):
            self.assertEqual(D.project_of_folder(host, '/Users/dev/Projects/kanban/app'), 'kanban')
            self.assertEqual(D.project_of_folder(host, '/Users/dev/Projects/kanban-wt/ide'), 'kanban')
            self.assertEqual(D.project_of_folder(host, '/Users/dev'), '')


class ShortName(unittest.TestCase):
    def test_fallback_cuts_at_punctuation_or_words(self):
        self.assertEqual(S.fallback_name('帮我看一下 tmp 目录里有什么文件'), '帮我看一下')
        self.assertEqual(S.fallback_name('修一下，登录页白屏的问题'), '修一下')
        self.assertEqual(S.fallback_name('  「整理」任务板  '), '整理任务板')
        self.assertEqual(S.fallback_name('Fix the flaky login test on CI please'), 'Fix the flaky')
        self.assertEqual(S.fallback_name('帮我看一下 /tmp 目录里有什么文件'), '帮我看一下')
        self.assertEqual(S.fallback_name('   '), '')

    def test_clean_name_accepts_short_names_only(self):
        self.assertEqual(S.clean_name('「查看临时文件」'), '查看临时文件')
        self.assertEqual(S.clean_name('名字：查看 tmp 文件。\n'), '查看 tmp 文件')
        self.assertEqual(S.clean_name('临时 文件'), '临时文件')
        self.assertEqual(S.clean_name('"Fix login test"'), 'Fix login test')
        self.assertEqual(S.clean_name('现在查看 tmp 目录里的所有文件。'), '')  # an answer, not a name
        self.assertEqual(S.clean_name('I will now look at the files in tmp'), '')
        self.assertEqual(S.clean_name(''), '')

    def run_short(self, reply=None, delay=0.0, enabled=True, timeout=2.0):
        seen = []
        def chat(p, system, user, **kw):
            seen.append((system, user))
            time.sleep(delay)
            return reply
        with patch.object(S, 'use_enabled', return_value=enabled), \
             patch.object(S, 'provider', return_value={'id': 'claude', 'model': 'haiku', 'base': '', 'key': ''}), \
             patch.object(S, 'chat', side_effect=chat):
            return S.short_name('帮我看一下 tmp 目录里有什么文件', timeout=timeout), seen

    def test_model_name_comes_back_and_only_the_message_is_sent(self):
        name, seen = self.run_short('查看临时文件')
        self.assertEqual(name, '查看临时文件')
        self.assertEqual(seen[0][1], '<msg>\n帮我看一下 tmp 目录里有什么文件\n</msg>')
        self.assertEqual(seen[0][0], S.NAME_PROMPT)

    def test_slow_model_gives_up_at_the_timeout(self):
        # the model answers only after the name came back: a short_name that waited for it would not return
        # before the 30 s safety stop below (a stopwatch limit of 2 s failed on a busy Mac)
        late = threading.Event()
        self.addCleanup(late.set)  # then the model's thread ends with this test, not in a later one
        seen = []

        def chat(p, system, user, **kw):
            seen.append(user)
            late.wait(30)
            return '查看临时文件'
        with patch.object(S, 'use_enabled', return_value=True), \
             patch.object(S, 'provider', return_value={'id': 'claude', 'model': 'haiku', 'base': '', 'key': ''}), \
             patch.object(S, 'chat', side_effect=chat):
            name = S.short_name('帮我看一下 tmp 目录里有什么文件', timeout=0.3)
        self.assertEqual(name, '')
        self.assertEqual(len(seen), 1)  # it asked
        self.assertFalse(late.is_set())  # and did not wait for the answer

    def test_switched_off_use_sends_nothing(self):
        name, seen = self.run_short('查看临时文件', enabled=False)
        self.assertEqual((name, seen), ('', []))

    def test_model_error_keeps_fallback(self):
        with patch.object(S, 'use_enabled', return_value=True), patch.object(S, 'provider', return_value={'id': 'zhipu'}), \
             patch.object(S, 'chat', side_effect=RuntimeError('boom')):
            self.assertEqual(S.short_name('hello there'), '')

    def test_cli_model_process_is_killed_at_the_name_timeout(self):
        # `claude -p` used to get timeout+60 s: short_name gave up at 15 s and the child ran on for a minute.
        seen = {}
        def run(*args, **kw):
            seen['timeout'] = kw.get('timeout')
            return SimpleNamespace(returncode=0, stdout='查看临时文件', stderr='')
        with patch.object(S, 'use_enabled', return_value=True), patch.object(S, 'provider', return_value={'id': 'claude', 'model': 'haiku'}), \
             patch.object(S, 'record_use'), patch.object(S.subprocess, 'run', side_effect=run):
            self.assertEqual(S.short_name('帮我看一下 tmp 目录', timeout=15), '查看临时文件')
        self.assertEqual(seen['timeout'], 15)


class NameAgent(unittest.TestCase):
    MSG = '帮我看一下 tmp 目录里有什么文件'



    def name_session(self, model='查看临时文件', own='', prefs=None, path='', first=''):
        import activity
        stored = []
        with patch.object(S, 'short_name', return_value=model) as short, \
             patch.object(D, 'own_title', return_value=own), \
             patch.object(D, '_transcript_user_text', return_value=first), \
             patch.object(activity, 'session_preferences', return_value=prefs or {}), \
             patch.object(activity, 'set_preferences', side_effect=lambda d, k, c: stored.append((k, c))):
            res = D.name_session('claude-code:u1', self.MSG, path)
        self.short = short
        return res, stored

    def test_in_app_chat_without_own_title_gets_the_model_name(self):
        # `claude -p` writes no ai-title: the model names it from the first message, stored as its title.
        res, stored = self.name_session(path='/t.jsonl')
        self.assertEqual((res['name'], res['source'], res['saved']), ('查看临时文件', 'model', True))
        self.assertEqual(stored, [('claude-code:u1', {'title_override': '查看临时文件'})])
        self.assertEqual(self.short.call_args.args[0], self.MSG)

    def test_in_app_chat_short_own_title_is_kept_and_not_stored(self):
        res, stored = self.name_session(own='开发者账号申请', path='/t.jsonl')
        self.assertEqual((res['name'], res['source'], stored), ('开发者账号申请', 'agent', []))
        self.short.assert_not_called()

    def test_in_app_chat_resumed_is_named_from_its_first_message(self):
        res, stored = self.name_session(path='/t.jsonl', first='最早那句话')
        self.assertEqual(self.short.call_args.args[0], '最早那句话')

    def test_in_app_chat_the_person_named_is_left_alone(self):
        res, stored = self.name_session(prefs={'claude-code:u1': {'title_override': '我起的'}})
        self.assertEqual((res['name'], stored), ('', []))
        self.short.assert_not_called()

    def test_in_app_chat_no_model_stores_nothing(self):
        res, stored = self.name_session(model='')
        self.assertEqual((res['name'], res['saved'], stored), ('', False, []))

    def test_in_app_codex_chat_waits_for_codex_own_thread_name(self):
        # Codex names its thread a few seconds after the first turn: that name is used, nothing is stored.
        import activity
        stored, names = [], iter(['', '', '修登录页'])
        with patch.object(S, 'short_name', return_value='模型起的') as short, \
             patch.object(D, 'own_title', side_effect=lambda kind, path, sid='': next(names)) as thread, \
             patch.object(D, '_transcript_user_text', return_value=''), \
             patch.object(D.time, 'sleep'), \
             patch.object(activity, 'session_preferences', return_value={}), \
             patch.object(activity, 'set_preferences', side_effect=lambda d, k, c: stored.append((k, c))):
            res = D.name_session('codex:th-1', 'hello', '/nonexistent')
        self.assertEqual((res['name'], res['source'], res['saved'], stored), ('修登录页', 'agent', False, []))
        self.assertEqual(thread.call_args.args, ('codex', '/nonexistent', 'th-1'))
        short.assert_not_called()

    def test_in_app_codex_chat_without_a_thread_name_falls_back_to_the_model(self):
        import activity
        stored = []
        with patch.object(S, 'short_name', return_value='模型起的'), \
             patch.object(D, 'own_title', return_value=''), patch.object(D, '_transcript_user_text', return_value=''), \
             patch.object(activity, 'session_preferences', return_value={}), \
             patch.object(activity, 'set_preferences', side_effect=lambda d, k, c: stored.append((k, c))):
            res = D.name_session('codex:th-1', 'hello', '', title_wait=0)
        self.assertEqual((res['source'], stored), ('model', [('codex:th-1', {'title_override': '模型起的'})]))


class OwnTitle(unittest.TestCase):
    MSG = '帮我看一下 tmp 目录里有什么文件'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.addCleanup(self.tmp.cleanup)
        self.patch = patch.object(D, 'HOME', self.home)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write(self, rel, rows):
        path = os.path.join(self.home, *rel.split('/'))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        return path

    def test_claude_transcript_found_by_first_message_and_latest_ai_title_wins(self):
        self.write('.claude/projects/-tmp/other.jsonl', [{'type': 'user', 'message': {'content': '别的会话'}}, {'type': 'ai-title', 'aiTitle': '别的'}])
        mine = self.write('.claude/projects/-tmp/s1.jsonl', [
            {'type': 'user', 'message': {'content': '<command-name>/init</command-name>'}},
            {'type': 'user', 'message': {'content': [{'type': 'text', 'text': self.MSG}]}},
            {'type': 'ai-title', 'aiTitle': '查看临时'}, {'type': 'ai-title', 'aiTitle': '查看 tmp 文件'}])
        path = D.launched_transcript('claude-code', time.time() - 1, self.MSG)
        self.assertEqual(path, mine)
        self.assertEqual(D.own_title('claude-code', path), '查看 tmp 文件')

    def test_claude_session_id_from_hook_record_is_exact(self):
        mine = self.write('.claude/projects/-tmp/sid42.jsonl', [{'type': 'user', 'message': {'content': 'different text'}}])
        self.assertEqual(D.launched_transcript('claude-code', 0, self.MSG, 'sid42'), mine)

    def test_codex_title_comes_from_session_index(self):
        path = self.write('.codex/sessions/2026/09/25/rollout-x.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'c1', 'cwd': '/tmp'}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '# AGENTS.md instructions\n\n<INSTRUCTIONS>…'}]}},
            {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '<environment_context>…</environment_context>'}]}},
            {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': self.MSG}}])
        self.assertEqual(D.launched_transcript('codex', time.time() - 1, self.MSG), path)
        self.assertEqual(D.own_title('codex', path), '')
        self.write('.codex/session_index.jsonl', [{'id': 'c0', 'thread_name': '别的'}, {'id': 'c1', 'thread_name': '查看临时文件'}])
        self.assertEqual(D.own_title('codex', path), '查看临时文件')

    def test_old_transcripts_are_ignored(self):
        path = self.write('.claude/projects/-tmp/old.jsonl', [{'type': 'user', 'message': {'content': self.MSG}}])
        os.utime(path, (1000, 1000))
        self.assertEqual(D.launched_transcript('claude-code', time.time(), self.MSG), '')


