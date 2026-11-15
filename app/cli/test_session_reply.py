# -*- coding: utf-8 -*-
"""`dispatch reply`: the phone's reply box talks to the running Dispatch's chatd."""
import os
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import chat_client
import session_reply as R

WINDOWS_READY = True
SID = 'abcdef12-0000-4000-8000-00000000000a'
KEY = f'claude-code:{SID}'


class FakeChat:
    def __init__(self, sessions=(), fail=None, reply='turn_started'):
        self.sessions = list(sessions)
        self.fail = fail or {}
        self.reply = reply
        self.requests = []

    def __enter__(self): return self
    def __exit__(self, *exc): pass

    def request(self, cmd, timeout=60.0, **f):
        self.requests.append((cmd, f))
        if cmd in self.fail:
            raise chat_client.ChatError({'code': self.fail[cmd], 'message': f'{cmd} refused'})
        if cmd == 'list':
            return {'ev': 'sessions', 'sessions': self.sessions}
        if cmd == 'send':
            return {'ev': self.reply, 'session': f['session']}
        return {'ev': 'state', 'session': f.get('session')}

    def cmds(self):
        return [c for c, _ in self.requests]


class Reply(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.ref = dict(agent='claude-code', session_id=SID, cwd=self.dir, path='')
        self.live = []
        self.d = SimpleNamespace(HOME=self.dir, DISPATCH_DIR=self.dir, live_sessions=lambda local_only=False: self.live,
                                 load_index=lambda: {'/t.jsonl': dict(agent='claude-code', session_id=SID, cwd=self.dir, mtime=1)})

    def chat(self, fake):
        p = patch.object(chat_client.ChatClient, 'connect', return_value=fake)
        p.start(); self.addCleanup(p.stop)
        return fake

    def no_dispatch(self):
        p = patch.object(chat_client.ChatClient, 'connect', side_effect=chat_client.NotRunning(chat_client.NOT_RUNNING))
        p.start(); self.addCleanup(p.stop)

    def send(self, text='看一下', request_id=None, **kw):
        return R.submit(self.d, self.ref, text, request_id or str(uuid.uuid4()), **kw)

    def test_status_says_when_dispatch_is_not_open(self):
        self.no_dispatch()
        st = R.status(self.d, self.ref)
        self.assertFalse(st['available'])
        self.assertIn('chatd is not running', st['label'])
        self.assertEqual(st['where'], '')

    def test_status_follows_the_session_chatd_holds(self):
        self.chat(FakeChat())
        st = R.status(self.d, self.ref)
        self.assertEqual((st['available'], st['working'], st['where']), (True, False, ''))  # nowhere: the next send opens it in Dispatch
        self.chat(FakeChat([{'session': KEY, 'lifecycle': 'running'}]))
        st = R.status(self.d, self.ref)
        self.assertEqual((st['working'], st['where']), (True, 'desktop'))
        self.chat(FakeChat([{'session': KEY, 'lifecycle': 'stopped'}]))
        self.assertEqual(R.status(self.d, self.ref)['where'], 'desktop')  # idle-reaped: still Dispatch's
        self.chat(FakeChat([{'session': KEY, 'lifecycle': 'waiting_permission'}]))
        st = R.status(self.d, self.ref)
        self.assertEqual((st['available'], st['blocked']), (False, True))
        self.assertIn('Dispatch 里点允许或拒绝', st['label'])

    def test_a_claude_terminal_still_holding_it_is_said_before_sending(self):
        self.chat(FakeChat())
        self.live = [{'agent': 'claude-code', 'session_id': SID, 'agent_pid': 4242}]
        st = R.status(self.d, self.ref)
        self.assertFalse(st['available'])
        self.assertIn('还开在终端里', st['label'])
        self.assertEqual(st['where'], 'terminal')
        codex = R.status(self.d, dict(self.ref, agent='codex'))
        self.assertEqual((codex['available'], codex['where']), (True, ''))  # Codex shares the thread

    def test_a_conversation_chatd_does_not_hold_is_opened_again_then_sent(self):
        fake = self.chat(FakeChat())
        rid = str(uuid.uuid4())
        r = self.send('继续', request_id=rid)
        self.assertEqual(r['state'], 'accepted')
        self.assertEqual(fake.cmds(), ['list', 'open', 'send'])
        self.assertEqual(fake.requests[1][1], dict(agent='claude-code', cwd=self.dir, resume=SID))
        self.assertEqual(fake.requests[2][1]['message_id'], rid)  # the receipt id is chatd's message id

    def test_a_held_conversation_gets_the_message_directly_and_a_busy_one_queues_it(self):
        fake = self.chat(FakeChat([{'session': KEY, 'lifecycle': 'running'}], reply='queued'))
        r = self.send('再看一眼', mode='interrupt')
        self.assertEqual(fake.cmds(), ['list', 'send'])
        self.assertEqual(fake.requests[1][1]['mode'], 'interrupt')
        self.assertTrue(r['note'].startswith('已排队'))
        self.assertTrue(R.status(self.d, self.ref)['receipts'][0]['delivered'])

    def test_pictures_go_as_paths(self):
        fake = self.chat(FakeChat([{'session': KEY, 'lifecycle': 'idle'}]))
        pic = os.path.join(self.dir, 'a.png'); open(pic, 'wb').close()
        self.send('', images=[pic])
        self.assertEqual(fake.requests[-1][1]['images'], [{'path': pic}])
        self.assertEqual(fake.requests[-1][1]['text'], '看一下这几张图')

    def test_the_same_request_is_sent_once_and_a_changed_one_is_refused(self):
        fake = self.chat(FakeChat([{'session': KEY, 'lifecycle': 'idle'}]))
        rid = str(uuid.uuid4())
        self.send('一次', request_id=rid); self.send('一次', request_id=rid)
        self.assertEqual(fake.cmds().count('send'), 1)
        with self.assertRaisesRegex(R.Rejected, '另一条内容'):
            self.send('两次', request_id=rid)

    def test_a_terminal_still_writing_the_transcript_is_named(self):
        self.chat(FakeChat(fail={'open': 'writer_conflict'}))
        r = self.send()
        self.assertEqual(r['state'], 'failed')
        self.assertIn('还开在终端里', r['note'])

    def test_dispatch_not_open_fails_the_receipt(self):
        self.no_dispatch()
        r = self.send()
        self.assertEqual(r['state'], 'failed')
        self.assertIn('chatd is not running', r['note'])

    def test_bad_input_never_reaches_chatd(self):
        fake = self.chat(FakeChat())
        for text, rid in (('', str(uuid.uuid4())), ('x' * 16001, str(uuid.uuid4())), ('好', 'not-a-uuid')):
            with self.assertRaises(R.Rejected):
                R.submit(self.d, self.ref, text, rid)
        with self.assertRaises(R.Rejected):
            R.submit(self.d, dict(self.ref, agent='gemini'), '好', str(uuid.uuid4()))
        self.assertEqual(fake.requests, [])

    def test_interrupt_and_withdraw(self):
        fake = self.chat(FakeChat([{'session': KEY, 'lifecycle': 'running'}], reply='queued'))
        rid = str(uuid.uuid4())
        self.send('排着', request_id=rid)
        self.assertEqual(R.control(self.d, self.ref, {'interrupt': True})['note'], '已打断')
        r = R.control(self.d, self.ref, {'withdraw': rid})
        self.assertEqual((r['note'], r['text']), ('已撤回', '排着'))
        self.assertEqual(fake.requests[-1], ('withdraw', {'session': KEY, 'message_id': rid}))
        self.assertEqual(R.status(self.d, self.ref)['receipts'][0]['state'], 'failed')
        with self.assertRaisesRegex(R.Rejected, 'Dispatch 里操作'):
            R.control(self.d, self.ref, {'mode': 'plan'})

    def test_command_reports_an_unknown_session_as_failed(self):
        out = []
        self.d.out = lambda result, as_json, text: out.append(result)
        self.d.load_index = lambda: {}
        R.command(self.d, SimpleNamespace(op='status', key='nope', agent='claude-code', json=True))
        self.assertEqual(out[0]['state'], 'failed')


    def test_quotes_go_in_front_of_the_message_as_the_ide_sends_them(self):
        fake = self.chat(FakeChat([{'session': KEY, 'lifecycle': 'idle'}]))
        out = []
        self.d.out = lambda result, as_json, text: out.append(result)
        quotes = [{'text': '子任务（父任务算过一次）'}, {'text': 'Subtasks: counted once.', 'from': 'NOTES.md:9'}]
        with patch('sys.stdin') as stdin:
            stdin.read.return_value = '这两处都反过来。'
            R.command(self.d, SimpleNamespace(op='send', key=SID, agent='claude-code', json=True, request=str(uuid.uuid4()), mode='queue', image=[], quote=quotes))
        self.assertEqual(out[0]['state'], 'accepted')
        self.assertEqual(fake.requests[-1][1]['text'],
                         '> 子任务（父任务算过一次）\n\nNOTES.md:9\n> Subtasks: counted once.\n\n这两处都反过来。')


class Quotes(unittest.TestCase):
    def test_a_long_quote_is_cut_like_the_ide_cuts_it(self):
        lines = R.quote_lines('\n'.join(f'line {i}' for i in range(30))).split('\n')
        self.assertEqual(len(lines), 21)
        self.assertEqual(lines[-1], '> …')
        self.assertEqual(R.quote_lines('a\n\nb'), '> a\n>\n> b')

    def test_quotes_are_read_back_from_the_front_of_a_message(self):
        text = R.compose_quoted('why?', [{'text': 'one\ntwo'}, {'text': 'x = 1', 'from': 'src/a.py:3-4'}])
        self.assertEqual(R.parse_quotes(text), [
            {'text': 'one\ntwo', 'from': 'reply'},
            {'text': 'x = 1', 'from': 'file', 'file': 'src/a.py', 'line': 3, 'end': 4},
        ])
        self.assertEqual(R.parse_quotes('why? > not a quote'), [])
        self.assertEqual(R.compose_quoted('only words', []), 'only words')

    def test_the_command_line_keeps_each_quote_with_its_source(self):
        import argparse
        import dispatch
        p = argparse.ArgumentParser()
        p.add_argument('--quote', action=dispatch._QuoteAction, dest='quote', default=[])
        p.add_argument('--quote-from', action=dispatch._QuoteFromAction, dest='quote')
        a = p.parse_args(['--quote', 'a', '--quote', 'b', '--quote-from', 'NOTES.md:9'])
        self.assertEqual(a.quote, [{'text': 'a'}, {'text': 'b', 'from': 'NOTES.md:9'}])
        self.assertEqual(p.parse_args([]).quote, [])


class SlashCommands(unittest.TestCase):
    def test_builtins_then_skills_and_custom_commands(self):
        with tempfile.TemporaryDirectory() as home:
            skill = os.path.join(home, 'skills', 'brain'); os.makedirs(skill)
            open(os.path.join(skill, 'SKILL.md'), 'w').write('---\ndescription: 知识库\n---\n')
            cmds = os.path.join(home, 'proj', '.claude', 'commands'); os.makedirs(cmds)
            open(os.path.join(cmds, 'ship.md'), 'w').write('---\ndescription: 发版\n---\n')
            d = SimpleNamespace(HOME=home, AGENT_SKILL_DIRS={'claude': [os.path.join(home, 'skills')]},
                                read_frontmatter=lambda p: {'description': '知识库'})
            rows = R.commands(d, dict(agent='claude-code', cwd=os.path.join(home, 'proj')))
            names = [r['name'] for r in rows]
            self.assertEqual(names[0], 'compact')
            self.assertIn('brain', names); self.assertIn('ship', names)
            self.assertEqual(R.commands(d, dict(agent='codex', cwd=home))[0]['name'], 'compact')
            self.assertEqual(R.commands(d, dict(agent='gemini', cwd=home)), [])


if __name__ == '__main__':
    unittest.main()
