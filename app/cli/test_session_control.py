import json
import os
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch
from contextlib import ExitStack

import dispatch
import session_control as c
from session_reply import Rejected


class SessionControl(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.d = SimpleNamespace(HOME=self.temp.name, DISPATCH_DIR=self.temp.name, SESS_DIR=self.temp.name,
                                 load_index=lambda: {}, herdr_agents=lambda: [], herdr=Mock(return_value={'result': {}}), sh=Mock(return_value=(0,'','')))
        self.data = dict(request_id=str(uuid.uuid4()), agent='claude-code', cwd=self.temp.name, prompt='测试 `literal` $(literal)\n下一行')

    def test_named_terminal_fallback_matches_remote_server(self):
        with patch.object(dispatch, 'HOME', self.temp.name), patch.object(dispatch.os.path, 'exists', side_effect=lambda p: p.endswith('/main/herdr.sock')):
            self.assertEqual(dispatch.herdr_local_command(['agent','list'])[1:], ['--session','main','agent','list'])
        # Both servers up: use the one that hosts agents (a stray empty default server must not win).
        for root_n, main_n, want in [(2, 0, ['agent','list']), (0, 3, ['--session','main','agent','list']), (0, 0, ['agent','list'])]:
            with patch.object(dispatch.os.path, 'exists', return_value=True), patch.object(dispatch, '_HERDR_NAMED', None), \
                 patch.object(dispatch, '_herdr_agent_count', side_effect=lambda cmd: main_n if '--session' in cmd else root_n):
                self.assertEqual(dispatch.herdr_local_command(['agent','list'])[1:], want)

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
        self.d.show_herdr_pane=Mock(return_value=('Ghostty','focused'))
        with patch.object(c,'herdr_target',return_value=dict(pane_id='right')) as target:
            c.open_original(self.d,dict(session_id='exact',agent='claude-code'))
            self.assertFalse(target.call_args.kwargs['require_idle'])
            self.d.show_herdr_pane.assert_called_once_with('right')

    def test_codex_in_herdr_opens_its_terminal_even_when_blocked(self):
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='codex')}
        self.d.show_herdr_pane=Mock(return_value=('Ghostty','focused'))
        self.d.herdr_agents=lambda:[dict(agent='codex',agent_status='blocked',pane_id='right',agent_session={'value':'exact'})]
        self.assertEqual(c.open_original(self.d, dict(session_id='exact',agent='codex'))['pane_id'], 'right')
        self.d.show_herdr_pane.assert_called_once_with('right')
        self.d.sh.assert_not_called()

    def test_repeated_adoption_reconnects_existing_herdr_without_stopping_it(self):
        self.d.live_sessions=lambda **kw:[dict(session_id='exact',agent='codex',state='working',agent_pid=42,herdr={'pane_id':'right'})]
        self.d.herdr_agents=lambda:[dict(agent='codex',agent_status='working',pane_id='right',agent_session={'value':'exact'})]
        with patch.object(c.os, 'kill') as kill, patch.object(c, 'enqueue') as launch:
            result=c.adopt(self.d,dict(session_id='exact'))
        self.assertEqual((result['state'],result['pane_id']), ('ready','right'))
        kill.assert_not_called(); launch.assert_not_called()

    def test_presence_matches_the_same_exact_identity_as_replies(self):
        rows = [dict(session_id='one',agent='codex',agent_pid=10,cwd='/shared',state='working'),
                dict(session_id='two',agent='codex',agent_pid=20,cwd='/shared',state='idle'),
                dict(session_id='three',agent='codex',agent_pid=30,cwd='/other',state='idle')]
        for row in rows:
            with open(os.path.join(self.temp.name, row['session_id']+'.json'), 'w') as f: json.dump(row,f)
        panes = [dict(agent='codex',pane_id='pane-two',cwd='/shared',agent_status='working',agent_session={'value':'two'}),
                 dict(agent='codex',pane_id='pane-three',cwd='/shared',agent_status='idle')]
        patches = dict(SESS_DIR=self.temp.name, ps_table=lambda:{n:(1,'agent') for n in (10,20,30)},
                       zcode_live=lambda _:[], hermes_live=lambda _:[], reconcile_with_transcripts=lambda _:None,
                       codex_desktop_overlay=lambda _:None, annotate_moves=lambda _:None, local_host_name=lambda:'Apple',
                       herdr_agents=lambda:panes, herdr=Mock(return_value={'result':{'process_info':{'foreground_processes':[{'pid':30}]}}}))
        with ExitStack() as stack:
            for name,value in patches.items(): stack.enter_context(patch.object(dispatch,name,value))
            live = {r['session_id']:r for r in dispatch.live_sessions(local_only=True)}
        self.assertNotIn('herdr', live['one'])
        self.assertEqual(live['two']['herdr']['pane_id'], 'pane-two')
        self.assertEqual(live['three']['herdr']['pane_id'], 'pane-three')

    def test_pane_nobody_can_see_says_how_to_attach(self):
        # Mac mini: the pane lives in a headless "main" under tmux and no window could be opened.
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='claude-code')}
        self.d.show_herdr_pane=Mock(return_value=(None,'none')); self.d.herdr_session_name=lambda:'main'
        self.d.herdr_attach_hint=dispatch.herdr_attach_hint
        with patch.object(c,'herdr_target',return_value=dict(pane_id='w1:p3',tab_id='w1:t3')):
            with self.assertRaises(Rejected) as e: c.open_original(self.d,dict(session_id='exact',agent='claude-code'))
        self.assertIn('herdr --session main', str(e.exception))

    def test_herdr_clients_only_counts_windows_attached_to_that_session(self):
        rows = ['20621 1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
                '24414 20621 /usr/bin/login -flp apple fish', '24415 24414 herdr',  # default session, in Ghostty
                '50932 1 /opt/homebrew/bin/tmux new -d -s herdr', '50941 50932 /opt/homebrew/bin/herdr --session main',  # main, headless
                '50942 50941 /opt/homebrew/bin/herdr server', '60000 24414 /opt/homebrew/bin/herdr agent list']
        main = dispatch.herdr_clients('main', rows)
        self.assertEqual([(x['pid'], x['app']) for x in main], [(50941, None)])
        self.assertEqual([(x['pid'], x['app']) for x in dispatch.herdr_clients(None, rows)], [(24415, 'Ghostty')])

    def test_resume_already_running_here_is_not_started_twice(self):
        with patch.object(c.subprocess,'Popen'):
            c.enqueue(self.d,{**self.data,'prompt':'','resume':'exact'})
        self.d.live_sessions=lambda **kw:[dict(session_id='exact',agent='claude-code',source_app='Ghostty',agent_pid=24520)]
        self.d.herdr=Mock(return_value={'result':{}})
        c.worker(self.d,self.data['request_id'])
        r=c.status(self.d,self.data['request_id'])
        self.assertEqual(r['state'],'attention'); self.assertIn('Ghostty',r['message'])
        self.assertFalse(any(call.args[1][:2]==['agent','start'] for call in self.d.herdr.call_args_list))

    def test_unmapped_live_session_does_not_open_same_directory_or_duplicate(self):
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='claude-code')}
        self.d.live_sessions=lambda **kw:[dict(session_id='exact')]
        with patch.object(c,'herdr_target',side_effect=Rejected('unmapped')), patch.object(c,'enqueue') as launch:
            with self.assertRaises(Rejected): c.open_original(self.d,dict(session_id='exact',agent='claude-code'))
            launch.assert_not_called()

    def test_live_session_outside_known_pane_is_focused_not_misreported(self):
        self.d.load_index=lambda:{'file':dict(session_id='exact',agent='claude-code')}
        self.d.live_sessions=lambda **kw:[dict(session_id='exact',agent='claude-code',source_app='Warp')]
        self.d.focus_session=lambda s:'已切到 Warp'
        with patch.object(c,'herdr_target',side_effect=Rejected('unmapped')), patch.object(c,'enqueue') as launch:
            self.assertEqual(c.open_original(self.d,dict(session_id='exact',agent='claude-code'))['message'],'已切到 Warp')
            launch.assert_not_called()
        self.d.focus_session=lambda s:None; self.d.local_host_name=lambda:'Mini'
        with patch.object(c,'herdr_target',side_effect=Rejected('unmapped')):
            with self.assertRaises(Rejected) as e: c.open_original(self.d,dict(session_id='exact',agent='claude-code'))
            self.assertIn('Mini', str(e.exception)); self.assertNotIn('无法定位窗口', str(e.exception))

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
