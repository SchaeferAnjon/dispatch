# -*- coding: utf-8 -*-
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import dispatch
import session_control as c
from session_reply import Rejected

WINDOWS_READY = True


class Browse(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.d = SimpleNamespace(HOME=self.temp.name, DISPATCH_DIR=self.temp.name, SESS_DIR=self.temp.name, load_index=lambda: {})


    def test_folders_are_real_and_home_is_for_selected_machine(self):
        os.mkdir(self.temp.name+'/项目'); os.mkdir(self.temp.name+'/.hidden')
        r = c.browse(self.d, '~')
        self.assertEqual(r['path'], c.P.to_slash(os.path.realpath(self.temp.name)))  # the app always gets forward slashes
        self.assertEqual([f['name'] for f in r['children']], ['项目'])
        with self.assertRaises(Rejected): c.directory(self.d, '/nonexistent-dispatch-path')
        with self.assertRaises(Rejected): c.directory(self.d, 'relative')


class Branch(unittest.TestCase):
    """`session-control branch`: the line under the reply box shows the folder's git branch."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.d = SimpleNamespace(HOME=self.temp.name)

    def test_branch_of_a_repo_and_none_outside(self):
        import subprocess
        repo = os.path.join(self.temp.name, 'repo'); os.mkdir(repo)
        subprocess.run(['git', 'init', '-q', '-b', 'feat-x', repo], check=True)
        self.assertEqual(c.branch(self.d, repo)['branch'], 'feat-x')
        plain = os.path.join(self.temp.name, 'plain'); os.mkdir(plain)
        self.assertEqual(c.branch(self.d, plain)['branch'], '')
        with self.assertRaises(Rejected): c.branch(self.d, '/nonexistent-dispatch-path')


class Release(unittest.TestCase):
    """Terminal → Dispatch: `session-control release` stops the idle terminal process and starts nothing."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.sid = 'abcdef12-0000-4000-8000-00000000000a'
        self.row = dict(session_id=self.sid, agent='claude-code', state='working', agent_pid=4242, cwd=self.temp.name, source_app='Ghostty')
        self.d = SimpleNamespace(HOME=self.temp.name, DISPATCH_DIR=self.temp.name, SESS_DIR=self.temp.name,
                                 load_index=lambda: {'f': dict(session_id=self.sid, agent='claude-code', cwd=self.temp.name)},
                                 refresh_index=Mock(), live_sessions=lambda **kw: [self.row], ps_table=Mock(return_value={}))
        self.record = os.path.join(self.temp.name, f'claude-code__{self.sid}.json')
        with open(self.record, 'w') as f: json.dump(self.row, f)

    def test_a_working_session_is_refused_and_left_alone(self):
        with patch.object(c.P, 'IS_WIN', False), patch.object(c.os, 'kill') as kill:
            with self.assertRaises(Rejected) as cm:
                c.release(self.d, dict(session_id=self.sid, agent='claude-code'))
        self.assertIn('等它停下来再接', str(cm.exception))
        kill.assert_not_called()
        self.assertTrue(os.path.exists(self.record))

    def test_an_idle_session_is_stopped_and_nothing_is_launched(self):
        self.row['state'] = 'idle'
        with patch.object(c.P, 'IS_WIN', False), patch.object(c.os, 'kill') as kill:
            r = c.release(self.d, dict(session_id=self.sid, agent='claude-code'))
        kill.assert_called_once_with(4242, __import__('signal').SIGTERM)
        self.assertEqual((r['state'], r['stopped_pid']), ('released', 4242))
        self.assertIn('Ghostty', r['message'])
        self.assertFalse(os.path.exists(self.record))

    def test_not_running_or_held_by_dispatch_is_already_free(self):
        self.row['state'] = 'idle'
        with open(os.path.join(self.temp.name, 'chatd.json'), 'w') as f:
            json.dump({'pid': os.getpid(), 'sessions': {f'claude-code:{self.sid}': {'pid': 4242}}}, f)
        with patch.object(c.P, 'IS_WIN', False), patch.object(c, 'stop_process') as stop:
            r = c.release(self.d, dict(session_id=self.sid, agent='claude-code'))
        stop.assert_not_called()  # 4242 is chatd's own headless child, not a terminal
        self.assertEqual((r['state'], r['stopped_pid']), ('released', None))
        self.d.live_sessions = lambda **kw: []
        self.assertEqual(c.release(self.d, dict(session_id=self.sid, agent='claude-code'))['stopped_pid'], None)


class WindowsSessionControl(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.d = SimpleNamespace(HOME=self.temp.name, DISPATCH_DIR=self.temp.name, SESS_DIR=self.temp.name, load_index=lambda: {})

    @unittest.skipUnless(os.name == 'nt', '~\\ is a Windows spelling')
    def test_tilde_backslash_is_home(self):
        os.mkdir(os.path.join(self.temp.name, 'proj'))
        self.assertEqual(c.directory(self.d, '~\\proj'), os.path.realpath(os.path.join(self.temp.name, 'proj')))

    def test_noise_folders_compare_normalized(self):
        import tempfile as T
        with patch.object(c.P, 'IS_WIN', True):
            tmp = T.gettempdir()
            self.assertTrue(c.noise_dir(self.d, os.path.join(tmp, 'x')))
            self.assertTrue(c.noise_dir(self.d, os.path.join(self.temp.name, 'Documents', 'Codex', 'y')))
            self.assertTrue(c.noise_dir(self.d, 'C:\\Users\\x\\scratchpad\\a'))
            self.assertFalse(c.noise_dir(self.d, 'D:\\work\\kanban'))
        with patch.object(c.P, 'IS_WIN', False):
            self.assertTrue(c.noise_dir(self.d, '/private/tmp/x'))
            self.assertTrue(c.noise_dir(self.d, os.path.join(self.temp.name, 'Documents/Codex/y')))
            self.assertFalse(c.noise_dir(self.d, '/Users/x/Projects/kanban'))

    def test_browse_gives_forward_slashes_on_windows(self):
        os.mkdir(os.path.join(self.temp.name, 'a'))
        with patch.object(c.P, 'IS_WIN', True), patch.object(c.P, 'to_slash', side_effect=lambda p: p.replace('\\', '/').replace(os.sep, '/') + '|'):
            r = c.browse(self.d, '~')
        self.assertTrue(r['path'].endswith('|') and r['parent'].endswith('|'))
        self.assertEqual([x['name'] for x in r['children']], ['a'])
        self.assertTrue(all(x['path'].endswith('|') for x in r['children']))
        r = c.browse(self.d, '~')
        self.assertNotIn('|', r['path'])

    @unittest.skipUnless(os.name == 'nt', 'file attributes: Windows only')
    def test_browse_hides_hidden_and_system_folders(self):
        import ctypes
        for n in ('shown', 'secret'):
            os.mkdir(os.path.join(self.temp.name, n))
        ctypes.windll.kernel32.SetFileAttributesW(os.path.join(self.temp.name, 'secret'), 0x2)
        r = c.browse(self.d, self.temp.name)
        self.assertEqual([x['name'] for x in r['children']], ['shown'])
        self.assertNotIn('\\', r['path'] + ''.join(x['path'] for x in r['children']))


if __name__ == '__main__':
    unittest.main()
