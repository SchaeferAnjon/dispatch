# -*- coding: utf-8 -*-
"""chatd's local door: a real serve() on a thread, clients over 127.0.0.1."""
import json
import os
import queue
import socket
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import chatd
import chat_client
from test_chatd import FakeAdapter, SUPPORTED


def blocking_lines(q):
    while True:
        line = q.get()
        if line is None:
            return
        yield line


class Door(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.d = SimpleNamespace(HOME=tmp.name, DISPATCH_DIR=tmp.name, SESS_DIR=tmp.name, live_sessions=lambda local_only=False: [])
        self.app_in = queue.Queue()
        self.app_out = []
        patches = [patch.object(chatd.Chatd, "adapter_class", lambda self, agent: FakeAdapter), patch.object(chatd, "_probe", lambda agent: dict(SUPPORTED))]
        for p in patches:
            p.start(); self.addCleanup(p.stop)
        self.thread = threading.Thread(target=chatd.serve, kwargs={"read": blocking_lines(self.app_in), "write": self.app_out.append, "d": self.d}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        for _ in range(200):
            if chat_client.door(self.dir):
                break
            threading.Event().wait(0.01)

    def stop(self):
        self.app_in.put(None)
        self.thread.join(5)

    def test_registry_names_the_door_and_only_this_user_can_read_it(self):
        path = os.path.join(self.dir, "chatd.json")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        with open(path) as f:
            reg = json.load(f)
        self.assertIsInstance(reg["door"]["port"], int)
        self.assertEqual(len(reg["door"]["token"]), 32)

    def test_a_client_opens_a_session_and_the_app_sees_it_too(self):
        with chat_client.ChatClient.connect(self.dir) as c:
            self.assertTrue(c.request("hello")["agents"]["claude-code"]["supported"])
            opened = c.request("open", agent="claude-code", cwd=self.dir)
            self.assertEqual(opened["ev"], "opened")
            self.assertEqual(len(c.request("list")["sessions"]), 1)
        evs = [json.loads(l) for l in self.app_out]
        self.assertIn("opened", [e["ev"] for e in evs])  # the app window follows sessions a client started

    def test_the_app_command_reaches_clients_as_events(self):
        with chat_client.ChatClient.connect(self.dir) as c:
            c.request("hello")
            self.app_in.put(json.dumps({"cmd": "open", "request_id": "from-app", "agent": "claude-code", "cwd": self.dir}))
            e = c.wait(lambda e: e.get("ev") == "opened", timeout=5)
            self.assertEqual(e["request_id"], "from-app")

    def test_a_client_cannot_shut_chatd_down(self):
        with chat_client.ChatClient.connect(self.dir) as c:
            with self.assertRaises(chat_client.ChatError):
                c.request("shutdown")
            self.assertEqual(c.request("hello")["ev"], "hello")  # still up

    def test_a_wrong_token_is_hung_up_on(self):
        d = chat_client.door(self.dir)
        s = socket.create_connection(("127.0.0.1", d["port"]), timeout=3)
        s.sendall(b'{"token":"nope"}\n{"cmd":"hello","request_id":"h"}\n')
        self.assertEqual(s.recv(100), b"")
        s.close()

    def test_no_door_once_dispatch_quits(self):
        self.stop()
        with self.assertRaises(chat_client.NotRunning):
            chat_client.ChatClient.connect(self.dir, autostart=False)


class NoChatd(unittest.TestCase):
    def test_says_dispatch_is_not_open(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(chat_client, "start_resident", return_value=False), self.assertRaises(chat_client.NotRunning) as cm:
                chat_client.ChatClient.connect(d)
            self.assertIn("chatd is not running", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
