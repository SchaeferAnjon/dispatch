import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import machines_watch as M
import machines
import waiting as W
from test_machines import MINI, fake_dispatch


def counts(n=1, at=1):
    return dict(approve=n, decide=0, unread=0, only_you=0, total=n, shared=0, as_of=at)


class Watch(unittest.TestCase):
    def test_only_initial_and_changed_counts_are_emitted(self):
        rows = [counts(1, 1), counts(1, 2), counts(2, 3), counts(0, 4)]
        emitted = []
        with patch.object(W, "collect", side_effect=rows), patch.object(W, "this_machine", side_effect=lambda x: x), \
                patch.object(W, "attention", side_effect=lambda x: x):
            sleeps = []
            W.watch(emitted.append, lambda _: sleeps.append(1), stop=lambda: len(sleeps) == 4)
        self.assertEqual(emitted, [rows[0], rows[2], rows[3]])

    def test_an_orphaned_watch_exits_and_a_quiet_one_sends_heartbeats(self):
        with patch.object(W, "collect", return_value={}), patch.object(W, "this_machine", return_value={}), \
                patch.object(W, "attention", return_value=counts()):
            emitted, parents = [], iter([4242, 4242, 1])
            self.assertEqual(W.watch(emitted.append, lambda _: None, parent=lambda: next(parents)), 0)
            self.assertEqual(emitted, [counts()])  # the parent became 1 (sshd gone): it stopped by itself
            now, rows, sleeps = [0.0], [], []
            def sleep(_):
                sleeps.append(1)
                now[0] += 5
            W.watch(rows.append, sleep, stop=lambda: len(sleeps) == 8, parent=lambda: 4242, clock=lambda: now[0])
            self.assertEqual(rows[0], counts())
            beats = [r for r in rows if "heartbeat" in r]
            self.assertEqual(len(beats), 2)  # 40 s of no change: a line every 15 s
            self.assertIsNone(M.normalize(beats[0]))  # the reader ignores it
            def closed(row):
                if "heartbeat" in row:
                    raise BrokenPipeError()
            now[0], sleeps[:] = 0.0, []
            self.assertEqual(W.watch(closed, sleep, parent=lambda: 4242, clock=lambda: now[0]), 0)
            self.assertLessEqual(len(sleeps), 4)  # the first heartbeat after the client left ended it

    def test_broken_ssh_pipe_exits_cleanly(self):
        with patch.object(W, "collect", return_value={}), patch.object(W, "this_machine", return_value={}), \
                patch.object(W, "attention", return_value=counts()):
            def closed(_):
                raise BrokenPipeError()
            self.assertEqual(W.watch(closed), 0)

    def test_stream_validation_and_backoff(self):
        for bad in [None, [], {}, {**counts(), "total": 8}, {**counts(), "approve": True}, {**counts(), "as_of": float("nan")}]:
            self.assertIsNone(M.normalize(bad))
        self.assertEqual([M.retry_delay(i) for i in range(9)], [1, 2, 4, 8, 16, 32, 60, 60, 60])

    def test_real_ndjson_subprocess_caches_and_emits_on_main_queue(self):
        with tempfile.TemporaryDirectory() as temp:
            d = fake_dispatch(temp)
            d.remote_cli = lambda _: "dispatch"
            d.remote_beads = lambda _: ""
            events = queue.Queue()
            script = "import sys,time; print('invalid',flush=True); print(" + repr(json.dumps(counts())) + ",flush=True); time.sleep(.1)"
            def popen(args, **kw):
                self.assertIn("ServerAliveInterval=15", args)
                self.assertIn("waiting watch --json", args[-1])
                return subprocess.Popen([sys.executable, "-c", script], **kw)
            p = M.Peer(d, MINI, events, popen)
            p.stream()
            self.assertEqual(events.get_nowait()["attention"], counts())
            self.assertEqual(M.read_attention(d, MINI), counts())
            p.save(False)
            self.assertIsNone(M.read_attention(d, MINI))
            self.assertEqual(M.read_attention(d, MINI, stale=True), counts())

    def test_expired_lease_restores_poll_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            d = fake_dispatch(temp)
            with open(M.cache_path(d, MINI), "w") as f:
                json.dump(dict(attention=counts(), connected=True, heartbeat=time.time() - 40), f)
            self.assertIsNone(M.read_attention(d, MINI))

    def test_fallback_keeps_the_newer_count_until_polling_catches_up(self):
        with tempfile.TemporaryDirectory() as temp:
            d = fake_dispatch(temp)
            p = M.Peer(d, MINI, queue.Queue())
            p.attention = counts(2, 50)
            p.save(False)
            with patch.object(machines, "D", d), patch.object(W, "remote_list", return_value={}), \
                    patch.object(W, "attention", return_value=counts(1, 10)):
                self.assertEqual(machines.peer_attention(MINI, True), counts(2, 50))

    def test_live_push_overrides_a_stale_down_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            d = fake_dispatch(temp)
            p = M.Peer(d, MINI, queue.Queue())
            p.attention = counts()
            p.save(True)
            with open(os.path.join(temp, "mini.down"), "w"):
                pass
            with patch.object(machines, "D", d):
                self.assertTrue(machines.reachable(MINI))

    def test_offline_uses_a_newer_poll_snapshot_after_stream_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            d = fake_dispatch(temp)
            p = M.Peer(d, MINI, queue.Queue())
            p.attention = counts(2, 10)
            p.save(False)
            with patch.object(machines, "D", d), patch.object(W, "remote_list", return_value={"updated_at": 50}), \
                    patch.object(W, "attention", return_value=counts(1, 50)):
                self.assertEqual(machines.peer_attention(MINI, False), counts(1, 50))

    def test_manager_never_duplicates_connection_and_removes_hosts(self):
        with tempfile.TemporaryDirectory() as temp:
            d = fake_dispatch(temp, hosts=[MINI])
            created, emitted = [], []
            class Stub:
                def __init__(self, d, h, q):
                    self.host, self.closed = dict(h), False
                    self.thread = types.SimpleNamespace(start=lambda: created.append(self))
                def close(self):
                    self.closed = True
            manager = M.Watches(d, lambda *a, **kw: emitted.append(kw), Stub)
            manager.tick()
            manager.next_scan = 0
            manager.tick()
            self.assertEqual(len(created), 1)
            manager.events.put({"host": "mini", "attention": counts()})
            manager.tick()
            self.assertEqual(emitted[0]["host"], "mini")
            d.hosts = lambda: []
            manager.next_scan = 0
            manager.tick()
            self.assertTrue(created[0].closed)
            self.assertFalse(manager.peers)
