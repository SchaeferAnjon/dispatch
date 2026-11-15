# -*- coding: utf-8 -*-
"""chat_retry.py in chatd: a turn that ends with a connection error goes out again on its own, with a plain notice in
the conversation; the words are not lost. Driven with test_chatd's scripted adapter."""
import json
import unittest

import chat_protocol as cp
import chat_retry
import chatd
from test_chatd import Base, FakeAdapter

WINDOWS_READY = True


class FlakyAdapter(FakeAdapter):
    def fail(self, error):
        t, self.turn_id = self.turn_id, None
        self.lifecycle = "idle"
        self.emit("turn_done", turn_id=t, status="error", error=error, duration_ms=5, num_tools=0)
        self.emit("state", **self.state())

    def die(self, error):
        """The process ended in the middle of the turn (Claude's _finish_turn_on_exit)."""
        t, self.turn_id = self.turn_id, None
        self.lifecycle = "error"
        self.emit("turn_done", turn_id=t, status="error", error=error, duration_ms=5, num_tools=0)
        self.emit("closed", reason="exited", exit_code=1)


class Retry(Base):
    def setUp(self):
        super().setUp()
        FlakyAdapter.made = []
        self.c.adapter_class = lambda agent: FlakyAdapter
        self.cmd(cmd="open", request_id="o1", agent="claude-code", cwd=self.work)
        self.c.tick(reap=False)
        self.key = next(e["session"] for e in self.events if e["ev"] == "opened")

    @property
    def a(self):
        return self.c.sessions[self.key].adapter

    def notices(self):
        return [e["text"] for e in self.events if e["ev"] == "system" and e.get("kind") == "notice"]

    def send(self, mid="m1", text="fix the login page"):
        self.cmd(cmd="send", request_id="s-" + mid, session=self.key, message_id=mid, text=text)
        self.c.tick(reap=False)

    def test_connection_error_sends_the_same_words_again(self):
        self.send()
        self.a.fail("API Error: Connection error.")
        self.c.tick(reap=False)
        self.assertEqual(len(self.notices()), 1)
        self.assertIn("Lost the connection to Claude's servers", self.notices()[0])
        self.assertIn("Trying again in 3 seconds (2 of 5)", self.notices()[0])
        self.assertIn("Your message is kept", self.notices()[0])
        self.assertEqual(len(self.a.sent), 1)
        self.now[0] += 2.9
        self.c.tick(reap=False)
        self.assertEqual(len(self.a.sent), 1)  # not yet
        self.now[0] += 0.2
        self.c.tick(reap=False)
        self.assertEqual(len(self.a.sent), 2)
        again = self.a.sent[1]
        self.assertTrue(again["text"].startswith(chat_retry.PREFIX))
        self.assertTrue(again["text"].endswith("fix the login page"))
        started = [e for e in self.events if e["ev"] == "turn_started"]
        self.assertEqual(started[-1]["text"], "fix the login page")  # the bubble shows the person's words
        self.a.finish()
        self.c.tick(reap=False)
        self.assertIsNone(self.c.sessions[self.key].net_retry)

    def test_gives_up_after_five_tries_with_a_plain_notice(self):
        self.send()
        for delay in chat_retry.RETRY_DELAYS:
            self.a.fail("read ECONNRESET")
            self.c.tick(reap=False)
            self.now[0] += delay
            self.c.tick(reap=False)
        self.assertEqual(len(self.a.sent), 5)
        self.a.fail("read ECONNRESET")
        self.c.tick(reap=False)
        self.assertIn("Still no connection to Claude's servers after 5 tries", self.notices()[-1])
        self.now[0] += 120
        self.c.tick(reap=False)
        self.assertEqual(len(self.a.sent), 5)

    def test_other_errors_are_not_retried(self):
        self.send()
        self.a.fail("API Error: 401 invalid x-api-key")
        self.now[0] += 100
        self.c.tick(reap=False)
        self.assertEqual(len(self.a.sent), 1)
        self.assertEqual(self.notices(), [])

    def test_stop_cancels_the_waiting_try(self):
        self.send()
        self.a.fail("fetch failed")
        self.c.tick(reap=False)
        self.cmd(cmd="interrupt", request_id="i1", session=self.key)
        self.assertEqual(self.reply("i1")["status"], "interrupted")
        self.assertIn("Stopped trying to reconnect", self.notices()[-1])
        self.now[0] += 100
        self.c.tick(reap=False)
        self.assertEqual(len(self.a.sent), 1)

    def test_a_new_message_sends_the_waiting_one_first(self):
        self.send()
        self.a.fail("Unable to connect. Is the computer able to access the url?")
        self.c.tick(reap=False)
        self.send("m2", "and the footer")
        self.assertEqual(len(self.a.sent), 2)
        self.assertTrue(self.a.sent[1]["text"].endswith("fix the login page"))
        self.a.finish()
        self.c.tick(reap=False)
        self.assertEqual(self.a.sent[-1]["text"], "and the footer")

    def test_a_process_that_died_is_resumed_and_gets_the_message(self):
        self.send()
        first = self.a
        first.die("Claude 进程退出了（退出码 1）：Error: Connection error.")
        self.c.tick(reap=False)
        self.assertIn("Lost the connection", self.notices()[-1])
        self.now[0] += 3
        self.c.tick(reap=False)
        self.c.tick(reap=False)
        second = self.a
        self.assertIsNot(first, second)
        self.assertTrue(second.resumed)
        self.assertEqual(len(second.sent), 1)
        self.assertTrue(second.sent[0]["text"].endswith("fix the login page"))

    def test_no_bell_while_it_tries_again(self):
        filed = []
        self.c.inbox_hook = lambda key, sess, ev, fields: filed.append(ev)
        self.send()
        self.a.fail("socket hang up")
        self.c.tick(reap=False)
        self.assertEqual(filed, [])
        self.now[0] += 3
        self.c.tick(reap=False)
        self.a.finish()
        self.c.tick(reap=False)
        self.assertEqual(filed, ["turn_done"])


if __name__ == "__main__":
    unittest.main()
