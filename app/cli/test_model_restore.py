"""Saved selections survive a host restart, eviction and a backing context handoff."""
import unittest
from unittest.mock import patch
import chat_life
import chat_protocol as cp
import chatd
from test_chatd import Base, FakeAdapter


class ModelRestore(Base):
    def test_saved_selection_and_native_context_restore_for_every_engine(self):
        for agent, model in [('claude-code', 'sonnet'), ('codex', 'gpt-cheap'), ('opencode', 'deepseek/deepseek-flash')]:
            with self.subTest(agent=agent):
                key = cp.session_key(agent, 'public-' + agent)
                options = {'model': model, 'effort': 'high', 'permission_mode': 'default'}
                adapter = FakeAdapter(None, cp.session_key(agent, 'fresh-' + agent), self.work, options)
                sess = chatd.Session(adapter, agent, self.work, {})
                chat_life.initialize(self.c, key, sess)
                chat_life.persist(self.c, key, sess)
                self.cmd(cmd='open', request_id='restore-' + agent, agent=agent, cwd=self.work, resume=key.split(":", 1)[1])
                actual = self.c.sessions[key].adapter
                self.assertEqual(actual.options, options)
                self.assertEqual(actual.resumed, 'fresh-' + agent)

    def test_explicit_resume_selection_overrides_saved_choice(self):
        key = self.open(model='old', effort='high')['session']
        self.c.sessions[key].adapter.options.update(model='sonnet', effort='medium')
        self.c.sessions[key].adapter.emit('state', **self.c.sessions[key].adapter.state())
        self.c.sessions.clear()
        self.open(rid='resume', resume=key.split(':', 1)[1], model='new', effort='low')
        self.assertEqual(self.c.sessions[key].adapter.options['model'], 'new')
        self.assertEqual(self.c.sessions[key].adapter.options['effort'], 'low')

    def test_idle_restart_preserves_latest_effort(self):
        key = self.open(model='initial', effort='low')['session']
        old = self.c.sessions[key].adapter
        old.options.update(model='sonnet', effort='high')
        old.close('idle')
        self.c.sessions[key].reaped = True
        self.cmd(cmd='send', session=key, message_id='next', text='continue')
        self.assertEqual(self.c.sessions[key].adapter.options['model'], 'sonnet')
        self.assertEqual(self.c.sessions[key].adapter.options['effort'], 'high')

    def test_automatic_handoff_keeps_latest_selection_for_every_engine(self):
        for agent in ('claude-code', 'codex', 'opencode'):
            with self.subTest(agent=agent):
                key = cp.session_key(agent, 'handoff')
                adapter = FakeAdapter(lambda *a, **k: None, key, self.work, {'model': 'chosen', 'effort': 'medium'})
                adapter.lifecycle = 'idle'
                sess = chatd.Session(adapter, agent, self.work, {'model': 'stale', 'effort': 'low'})
                self.c.sessions[key] = sess
                chat_life.initialize(self.c, key, sess)
                sess.life_phase = {'stage': 'prepare', 'done': True, 'result': ({'id': 'receipt', 'after_message': 4}, 'continue')}
                chat_life.advance(self.c, key, sess)
                self.assertEqual(sess.adapter.options['model'], 'chosen')
                self.assertEqual(sess.adapter.options['effort'], 'medium')


if __name__ == '__main__':
    unittest.main()
