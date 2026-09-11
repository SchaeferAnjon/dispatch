import json
import os
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

import dispatch
import session_control as c
from session_reply import Rejected


class SessionControl(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.d = SimpleNamespace(HOME=self.temp.name, DISPATCH_DIR=self.temp.name, SESS_DIR=self.temp.name,
                                 load_index=lambda: {}, herdr=Mock(return_value={'result': {}}), sh=Mock(return_value=(0,'','')))
        self.data = dict(request_id=str(uuid.uuid4()), agent='claude-code', cwd=self.temp.name, prompt='测试 `literal` $(literal)\n下一行')

    def test_named_terminal_fallback_matches_remote_server(self):
        with patch.object(dispatch, 'HOME', self.temp.name), patch.object(dispatch.os.path, 'exists', side_effect=lambda p: p.endswith('/main/herdr.sock')):
            self.assertEqual(dispatch.herdr_local_command(['agent','list'])[1:], ['--session','main','agent','list'])
        with patch.object(dispatch.os.path, 'exists', return_value=True):
            self.assertEqual(dispatch.herdr_local_command(['agent','list'])[1:], ['agent','list'])

    def test_folders_are_real_and_home_is_for_selected_machine(self):
        os.mkdir(self.temp.name+'/项目'); os.mkdir(self.temp.name+'/.hidden')
        r = c.browse(self.d, '~')
        self.assertEqual(r['path'], os.path.realpath(self.temp.name))
        self.assertEqual([f['name'] for f in r['children']], ['项目'])
        with self.assertRaises(Rejected): c.directory(self.d, '/nonexistent-dispatch-path')
        with self.assertRaises(Rejected): c.directory(self.d, 'relative')

    def test_tab_is_named_after_project_then_conversation(self):
        d = SimpleNamespace(git_root_name=lambda cwd: 'kanban' if cwd.endswith('/kanban/app') else '')
        self.assertEqual(c.tab_label(d, dict(cwd='/x/kanban/app', title='工作台显示 ZCode 会话', prompt='')), 'kanban · 工作台显示 ZCode 会话')
        # A resumed session without a title still reads as its project, never a generic 恢复会话.
        self.assertEqual(c.tab_label(d, dict(cwd='/x/谭师', title='', prompt='')), '谭师')
        self.assertEqual(c.tab_label(d, dict(cwd='/x/谭师', title='', prompt='第一行\t带控制符\n第二行')), '谭师 · 第一行带控制符')
        self.assertEqual(len(c.tab_label(d, dict(cwd='/x/kanban/app', title='很'*60, prompt=''))), 32)
        self.assertEqual(c.tab_label(self.d, dict(cwd='', title='', prompt='')), '恢复会话')

    def test_same_creation_request_never_spawns_twice(self):
        with patch.object(c.subprocess, 'Popen') as launch:
            first = c.enqueue(self.d, self.data)
            second = c.enqueue(self.d, self.data)
            self.assertEqual(first, second); launch.assert_called_once()
            with self.assertRaises(Rejected): c.enqueue(self.d, {**self.data, 'prompt':'different'})

    def test_invalid_input_cannot_launch(self):
        with patch.object(c.subprocess, 'Popen') as launch:
            for change in [dict(agent='qoder'), dict(prompt=' '), dict(cwd='relative'), dict(request_id='bad')]:
                with self.assertRaises(Rejected): c.enqueue(self.d, {**self.data, **change})
            launch.assert_not_called()

    def test_codex_uses_exact_deeplink_not_app_activation(self):
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='codex')}
        c.open_original(self.d, dict(session_id='exact',agent='codex'))
        self.assertEqual(self.d.sh.call_args.args[0], ['open','codex://threads/exact'])
        with self.assertRaises(Rejected): c.open_original(self.d, dict(session_id='exa',agent='codex'))

    def test_focus_allows_working_session_but_still_requires_exact_identity(self):
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='claude-code')}
        self.d.ps_table=lambda:{}; self.d.activate=Mock()
        with patch.object(c,'herdr_target',return_value=dict(pane_id='right')) as target:
            c.open_original(self.d,dict(session_id='exact',agent='claude-code'))
            self.assertFalse(target.call_args.kwargs['require_idle'])
            self.assertEqual(self.d.herdr.call_args.args[1],['agent','focus','right'])

    def test_unmapped_live_session_does_not_open_same_directory_or_duplicate(self):
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='claude-code')}
        self.d.live_sessions=lambda **kw:[dict(session_id='exact')]
        with patch.object(c,'herdr_target',side_effect=Rejected('unmapped')), patch.object(c,'enqueue') as launch:
            with self.assertRaises(Rejected): c.open_original(self.d,dict(session_id='exact',agent='claude-code'))
            launch.assert_not_called()

    def test_status_retains_launch_after_client_reconnect(self):
        with patch.object(c.subprocess,'Popen'):
            c.enqueue(self.d,self.data)
        c.save(self.d,self.data['request_id'],state='ready',session_id='actual-id')
        self.assertEqual(c.status(self.d,self.data['request_id'])['session_id'],'actual-id')

    def test_worker_creates_exact_claude_uuid_and_literal_prompt(self):
        with patch.object(c.subprocess,'Popen'):
            c.enqueue(self.d,self.data)
        calls=[]
        def herdr(_, args, **kw):
            calls.append(args)
            if args[:2] == ['tab','create']: return {'result':{'root_pane':{'pane_id':'w1:p9','tab_id':'w1:t9'}}}
            return {'result':{}}
        self.d.herdr=herdr
        def index():
            a=next(a for a in calls if a[:2]==['agent','start'])
            return {'file':dict(agent='claude-code',session_id=a[a.index('--session-id')+1])}
        self.d.refresh_index=index
        c.worker(self.d,self.data['request_id'])
        r=c.status(self.d,self.data['request_id'])
        self.assertEqual(r['state'],'ready')
        a=next(a for a in calls if a[:2]==['agent','start'])
        # The fixture prompt spans lines: Herdr cannot pass that as an agent argument, so it
        # must NOT be in the start args and must arrive verbatim through `agent prompt`.
        self.assertNotIn(self.data['prompt'],a)
        self.assertEqual(next(a for a in calls if a[:2]==['agent','prompt'])[3],self.data['prompt'])
        self.assertEqual(a[a.index('--session-id')+1],r['session_id'])
        self.assertEqual(next(a for a in calls if a[:2]==['tab','create'])[3],os.path.realpath(self.temp.name))

    def test_blocked_start_is_reported_without_sending_confirmation_keys(self):
        with patch.object(c.subprocess,'Popen'):
            c.enqueue(self.d,self.data)
        calls=[]
        def herdr(_, args, **kw):
            calls.append(args)
            if args[:2]==['tab','create']: return {'result':{'root_pane':{'pane_id':'w1:p9'}}}
            if args[:2]==['agent','get']: return {'result':{'agent':{'agent_status':'blocked'}}}
            return {'result':{}}
        self.d.herdr=herdr;self.d.refresh_index=lambda:{}
        c.worker(self.d,self.data['request_id'])
        self.assertEqual(c.status(self.d,self.data['request_id'])['state'],'attention')
        self.assertFalse(any('send-keys' in a for a in calls))


if __name__=='__main__': unittest.main()
