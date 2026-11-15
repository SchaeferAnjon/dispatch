# -*- coding: utf-8 -*-
"""The task board service in chatd (board_service.py) and the way callers reach it (board_client.py).

The first part runs against a fake bd (a function that keeps a little board in memory and records
every call). The last part starts a real chatd on a real embedded board in a temp folder, has many
writers at once, kills chatd in the middle with SIGKILL and checks that every write a caller was told
succeeded is on the board, and the board still opens."""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import board_client
import board_service as B
import chatd

HERE = os.path.dirname(os.path.abspath(__file__))


class FakeBd:
    """bd with a few issues and a key-value store, slow enough to overlap calls. Counts how many of it
    run at once (the service must never run two on an embedded board)."""

    def __init__(self, delay=0.02):
        self.delay = delay
        self.calls = []
        self.issues = {"task-aa": {"id": "task-aa", "title": "A", "deps": ["task-bb"]},
                       "task-bb": {"id": "task-bb", "title": "B", "deps": []},
                       "task-cc": {"id": "task-cc", "title": "C", "deps": []}}
        self.comments = {}
        self.kv = {}
        self.running = 0
        self.most = 0
        self.lock = threading.Lock()
        self.gate = None  # an Event a call waits on (to hold a write in the middle)
        self.fail_next = False

    def __call__(self, argv, env, timeout):
        with self.lock:
            self.running += 1
            self.most = max(self.most, self.running)
            self.calls.append((list(argv), dict(env or {})))
            fail = self.fail_next
            self.fail_next = False
        try:
            if self.gate is not None and argv[:2] == ["comments", "add"]:
                self.gate.wait(5)
            time.sleep(self.delay)
            if fail:
                return 1, "", "database is busy"
            return self.answer(argv, env)
        finally:
            with self.lock:
                self.running -= 1

    def answer(self, argv, env):
        sub = argv[0]
        if sub == "list":
            return 0, json.dumps([{"id": i["id"], "title": i["title"]} for i in self.issues.values()]), ""
        if sub == "show":  # like bd: every id it finds, a line on stderr for the others
            ids = [a for a in argv[1:] if not a.startswith("-")]
            found = [dict(self.issues[i], comment_count=len(self.comments.get(i, [])),
                          dependencies=[{"id": d, "title": self.issues[d]["title"]} for d in self.issues[i]["deps"]])
                     for i in ids if i in self.issues]
            err = "".join("Error fetching %s: no issue found\n" % i for i in ids if i not in self.issues)
            if not found:
                return 1, json.dumps({"error": "no issues found matching the provided IDs"}), err
            return 0, json.dumps(found), err
        if sub == "update":
            for a in argv[2:]:
                if a.startswith("--title="):
                    self.issues[argv[1]]["title"] = a.split("=", 1)[1]
            return 0, json.dumps([{k: v for k, v in self.issues[argv[1]].items() if k != "deps"}]), ""
        if sub == "comments" and argv[1] == "add":
            self.comments.setdefault(argv[2], []).append((env.get("BEADS_ACTOR", ""), argv[3]))
            return 0, "", ""
        if sub == "comments":
            return 0, json.dumps([{"author": a, "text": t} for a, t in self.comments.get(argv[1], [])]), ""
        if sub == "kv" and argv[1] == "set":
            self.kv[argv[2]] = argv[3]
            return 0, "", ""
        if sub == "kv" and argv[1] == "get":
            return (0, self.kv[argv[2]], "") if argv[2] in self.kv else (1, "", "not found")
        if sub == "memories":
            return 0, json.dumps(self.kv), ""
        return 0, "", ""

    def count(self, *prefix):
        return sum(1 for a, _ in self.calls if a[:len(prefix)] == list(prefix))


def service(fake, **kw):
    d = tempfile.mkdtemp(prefix="bsvc-")
    os.makedirs(os.path.join(d, ".beads"))
    svc = B.BoardService(os.path.join(d, ".beads"), fake, noms=kw.pop("noms", None), **kw)
    return svc, d


class Classify(unittest.TestCase):
    def test_reads_and_writes(self):
        c = B.classify
        self.assertEqual((c(["list", "--all", "--json"]).kind, c(["list", "--all", "--json"]).scope), ("read", "issues"))
        self.assertEqual(c(["show", "task-aa", "--json"]).scope, "ids")
        self.assertEqual(c(["show", "task-aa", "--json"]).ids, ("task-aa",))
        self.assertEqual(c(["comments", "task-aa", "--json"]).kind, "read")
        w = c(["comments", "add", "task-aa", "hello task-bb"])
        self.assertEqual((w.kind, w.scope), ("write", "issues"))
        self.assertIn("task-aa", w.ids)
        self.assertEqual((c(["kv", "get", "x"]).kind, c(["kv", "set", "x", "1"]).kind), ("read", "write"))
        self.assertEqual(c(["memories", "--json"]).scope, "kv")
        self.assertEqual(c(["remember", "x", "--key", "k"]).scope, "kv")
        self.assertEqual(c(["update", "task-aa", "--claim", "--json"]).kind, "write")
        self.assertEqual(c(["--dolt-auto-commit", "batch", "comments", "add", "task-aa", "x"]).kind, "write")
        self.assertEqual(c(["version"]).scope, "none")
        self.assertEqual(c(["export", "-o", "/tmp/x.jsonl"]).scope, "none")
        self.assertEqual(c(["sql", "select 1"]).kind, "read")
        self.assertEqual(c(["sql", "delete from issues"]).scope, "all")
        self.assertEqual(c(["frobnicate", "task-aa"]).scope, "all")  # unknown: may change anything

    def test_other_databases_are_not_answered(self):
        self.assertIsNone(B.classify(["--db", "/x", "list"]))
        self.assertIsNone(B.classify(["-C", "/x", "list"]))
        self.assertIsNone(B.classify(["--global", "list"]))


class Lanes(unittest.TestCase):
    """Who runs bd next (Slots)."""

    def order(self, lanes, events):
        """Hold the lanes with one read, queue `events` ("r" / "w") in that order, let go, and return the
        order they ran in."""
        sl = B.Slots(lanes)
        ran, lock, ts = [], threading.Lock(), []
        sl.acquire()  # a read holds the lane while the others line up

        def go(i, kind):
            if kind == "w":
                sl.acquire_write()
            else:
                sl.acquire()
            with lock:
                ran.append("%s%d" % (kind, i))
            time.sleep(0.02)
            sl.release_write() if kind == "w" else sl.release()

        writes = [k for k in events if k == "w"]
        for i, kind in enumerate(events):
            t = threading.Thread(target=go, args=(i, kind))
            t.start()
            ts.append(t)
            time.sleep(0.03)  # in this order
        sl.release()
        for t in ts:
            t.join(10)
        self.assertEqual(len(ran), len(events))
        return ran, writes

    def test_a_write_goes_ahead_of_waiting_reads(self):
        ran, _ = self.order(1, ["r", "r", "w"])
        self.assertEqual(ran[0], "w2")

    def test_a_stream_of_writes_lets_a_read_through_every_few(self):
        # one writer thread in the service: here several stand for a steady stream of them
        ran, _ = self.order(1, ["r", "w", "w", "w", "w", "w"])
        self.assertEqual(B.WRITE_JUMPS, 2)
        self.assertLessEqual(ran.index("r0"), 2)  # after two writes at most

    def test_on_a_server_one_lane_is_left_for_the_write(self):
        sl = B.Slots(4)
        for _ in range(3):
            sl.acquire()
        got = []
        t = threading.Thread(target=lambda: (sl.acquire(), got.append("r")))
        t.start()
        time.sleep(0.1)
        self.assertEqual(got, [])  # a fourth read waits
        sl.acquire_write()  # the write gets the lane kept for it at once
        sl.release_write()
        for _ in range(3):
            sl.release()
        t.join(5)
        self.assertEqual(got, ["r"])
        sl.release()


class Cache(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBd()
        self.svc, self.dir = service(self.fake)
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(self.svc.close)

    def test_a_read_twice_runs_bd_once(self):
        a = self.svc.bd(["list", "--sort", "id", "--json"])
        b = self.svc.bd(["list", "--sort", "id", "--json"])
        self.assertEqual(a[:3], b[:3])
        self.assertEqual((a[3], b[3]), ("bd", "memory"))
        self.assertEqual(self.fake.count("list"), 1)

    def test_a_write_makes_only_what_it_touched_stale(self):
        for argv in (["show", "task-aa", "--json"], ["show", "task-cc", "--json"], ["list", "--sort", "id", "--json"], ["memories", "--json"]):
            self.svc.bd(argv)
        self.svc.bd(["comments", "add", "task-cc", "note"], {"BEADS_ACTOR": "codex"})
        self.assertEqual(self.svc.bd(["show", "task-aa", "--json"])[3], "memory")
        self.assertEqual(self.svc.bd(["memories", "--json"])[3], "memory")
        code, out, _, via = self.svc.bd(["show", "task-cc", "--json"])  # its own show is known after a comment
        self.assertEqual(json.loads(out)[0]["comment_count"], 1)
        self.assertEqual(self.svc.bd(["list", "--sort", "id", "--json"])[3], "bd")

    def test_a_show_is_stale_when_an_issue_it_mentions_changes(self):
        self.svc.bd(["show", "task-aa", "--json"])  # mentions task-bb (a dependency)
        self.svc.bd(["update", "task-bb", "--title=B2", "--json"])
        code, out, _, via = self.svc.bd(["show", "task-aa", "--json"])
        self.assertEqual(via, "bd")
        self.assertIn("B2", out)

    def test_a_key_value_write_leaves_the_issues_alone(self):
        self.svc.bd(["list", "--json"])
        self.svc.bd(["kv", "get", "dispatch.workers.v1"])  # not there yet: a failure is not kept
        self.svc.bd(["kv", "set", "dispatch.workers.v1", "[]"])
        self.assertEqual(self.svc.bd(["list", "--json"])[3], "memory")
        self.assertEqual(self.svc.bd(["kv", "get", "dispatch.workers.v1"])[:2], (0, "[]"))
        self.assertEqual(self.fake.count("kv", "get"), 2)

    def test_a_key_that_was_never_set_is_an_answer_not_a_failure(self):
        """`bd kv get` of a key nobody set exits 1 with {"found": false}; `dispatch board` listed it as a failure shown as "}"."""
        orig = self.fake.answer
        self.fake.answer = lambda argv, env: (1, '{\n  "found": false,\n  "key": "k"\n}', "") if argv[:2] == ["kv", "get"] else orig(argv, env)
        self.assertEqual(self.svc.bd(["kv", "get", "k"])[0], 1)
        self.assertEqual(list(self.svc.failed), [])
        self.fake.fail_next = True
        self.svc.bd(["list", "--json"])
        self.assertEqual([r["error"] for r in self.svc.failed], ["database is busy"])

    def test_failures_are_not_kept(self):
        self.fake.fail_next = True
        self.assertEqual(self.svc.bd(["list", "--json"])[0], 1)
        self.assertEqual(self.svc.bd(["list", "--json"])[0], 0)
        self.assertEqual(self.fake.count("list"), 2)

    def test_the_same_read_at_once_runs_bd_once(self):
        self.fake.delay = 0.3
        out = []
        ts = [threading.Thread(target=lambda: out.append(self.svc.bd(["list", "--all", "--json"]))) for _ in range(8)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(out), 8)
        self.assertEqual(len({o[1] for o in out}), 1)
        self.assertEqual(self.fake.count("list"), 1)

    def test_readers_in_line_share_one_re_read_of_the_whole_board(self):
        self.svc.bd(["list", "--all", "--json"])  # the copy in memory
        self.svc.bd(["comments", "add", "task-aa", "x"])
        self.fake.delay = 0.3
        out = []
        ts = [threading.Thread(target=lambda: out.append(self.svc.bd(["list", "--all", "--json"]))) for _ in range(6)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual([o[0] for o in out], [0] * 6)
        self.assertEqual(self.fake.count("list"), 2)  # the first read, then one re-read of task-aa for all six
        self.assertEqual([a for a, _ in self.fake.calls if a[0] == "list"][1][-2:], ["--id", "task-aa"])

    def test_a_read_that_overlaps_a_write_is_not_kept(self):
        """A list bd started before a write finished must not be served after that write."""
        self.fake.delay = 0.0
        svc, d = service(self.fake, lanes=2)  # a Dolt server: a read may run beside a write
        self.addCleanup(shutil.rmtree, d, True)
        self.addCleanup(svc.close)
        self.fake.gate = threading.Event()
        w = threading.Thread(target=lambda: svc.bd(["comments", "add", "task-aa", "x"]))
        w.start()
        time.sleep(0.1)
        svc.bd(["list", "--sort", "id", "--json"])  # runs while the write is held
        self.fake.gate.set()
        w.join()
        self.assertEqual(svc.bd(["list", "--sort", "id", "--json"])[3], "bd")

    def test_shows_waiting_together_run_as_one_bd(self):
        """Ten Agents each reading their own task while a write runs: one `bd show a b c` after it."""
        self.fake.gate = threading.Event()
        w = threading.Thread(target=lambda: self.svc.bd(["comments", "add", "task-cc", "hold"]))
        w.start()
        time.sleep(0.1)
        out = {}
        ts = [threading.Thread(target=lambda i=i: out.__setitem__(i, self.svc.bd(["show", i, "--json"])))
              for i in ("task-aa", "task-bb", "task-cc", "task-zz")]
        for t in ts:
            t.start()
        time.sleep(0.2)
        self.fake.gate.set()
        for t in ts + [w]:
            t.join()
        shows = [a for a, _ in self.fake.calls if a[0] == "show"]
        self.assertIn(["show", "task-aa", "task-bb", "task-cc", "task-zz", "--json"],
                      [a[:1] + sorted(a[1:-1]) + a[-1:] for a in shows])
        self.assertLessEqual(len(shows), 2)  # the batch, and task-zz alone (bd's own "not found")
        self.assertEqual(json.loads(out["task-aa"][1])[0]["dependencies"][0]["id"], "task-bb")
        self.assertEqual(out["task-zz"][0], 1)
        # the same objects as one show each would give
        for i in ("task-aa", "task-bb", "task-cc"):
            self.assertEqual(json.loads(out[i][1]), json.loads(self.fake.answer(["show", i, "--json"], {})[1]))

    def test_a_task_read_back_after_its_own_write_needs_no_bd(self):
        """`dispatch log` then `dispatch task plan`: the show after a comment or an update is known."""
        self.svc.bd(["show", "task-aa", "--json"])
        self.svc.bd(["comments", "add", "task-aa", "one"])
        code, out, _, via = self.svc.bd(["show", "task-aa", "--json"])
        self.assertEqual(via, "memory")
        self.assertEqual(json.loads(out), json.loads(self.fake.answer(["show", "task-aa", "--json"], {})[1]))
        self.svc.bd(["update", "task-aa", "--title=A2", "--json"])
        code, out, _, via = self.svc.bd(["show", "task-aa", "--json"])
        self.assertEqual(via, "memory")
        self.assertEqual(json.loads(out), json.loads(self.fake.answer(["show", "task-aa", "--json"], {})[1]))
        self.assertEqual(self.fake.count("show"), 1)
        # a write that touches two tasks is not guessed: bd answers
        self.svc.bd(["update", "task-aa", "task-bb", "--title=both", "--json"])
        self.assertEqual(self.svc.bd(["show", "task-aa", "--json"])[3], "bd")

    def test_a_key_that_is_not_set_is_kept_until_a_key_is_written(self):
        self.fake.kv.clear()
        fake_answer = self.fake.answer
        self.fake.answer = lambda argv, env: (1, "%s (not set)" % argv[2], "") if argv[:2] == ["kv", "get"] and argv[2] not in self.fake.kv else fake_answer(argv, env)
        self.assertEqual(self.svc.bd(["kv", "get", "dispatch.workers.v1"])[0], 1)
        self.assertEqual(self.svc.bd(["kv", "get", "dispatch.workers.v1"])[3], "memory")
        self.svc.bd(["kv", "set", "dispatch.workers.v1", "[]"])
        self.assertEqual(self.svc.bd(["kv", "get", "dispatch.workers.v1"])[:2], (0, "[]"))
        # the --json spelling (workers.py)
        self.fake.answer = lambda argv, env: (1, '{"found": false, "key": "x", "value": ""}', "") if argv[:2] == ["kv", "get"] else fake_answer(argv, env)
        self.assertEqual(self.svc.bd(["kv", "get", "x", "--json"])[0], 1)
        self.assertEqual(self.svc.bd(["kv", "get", "x", "--json"])[3], "memory")

    def test_the_caller_environment_reaches_bd(self):
        self.svc.bd(["comments", "add", "task-aa", "hi"], {"BEADS_ACTOR": "codex"})
        self.assertEqual(self.fake.comments["task-aa"], [("codex", "hi")])


class Writes(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBd(delay=0.01)
        self.svc, self.dir = service(self.fake)
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_many_writers_one_bd_at_a_time_and_none_lost(self):
        n = 40
        results = []
        lock = threading.Lock()

        def writer(i):
            r = self.svc.bd(["comments", "add", "task-aa", "c%d" % i])
            with lock:
                results.append(r[0])

        readers_stop = threading.Event()

        def reader():
            while not readers_stop.is_set():
                self.svc.bd(["list", "--json"])
                self.svc.bd(["show", "task-aa", "--json"])

        rs = [threading.Thread(target=reader) for _ in range(3)]
        ws = [threading.Thread(target=writer, args=(i,)) for i in range(n)]
        for t in rs + ws:
            t.start()
        for t in ws:
            t.join()
        readers_stop.set()
        for t in rs:
            t.join()
        self.svc.close()
        self.assertEqual(results, [0] * n)
        self.assertEqual(sorted(t for _, t in self.fake.comments["task-aa"]), sorted("c%d" % i for i in range(n)))
        self.assertEqual(self.fake.most, 1, "two bd at once on an embedded board")

    def test_writes_run_in_the_order_they_came(self):
        for i in range(10):
            self.svc.bd(["comments", "add", "task-aa", str(i)])
        self.svc.close()
        self.assertEqual([t for _, t in self.fake.comments["task-aa"]], [str(i) for i in range(10)])

    def test_a_cancelled_write_never_runs(self):
        self.fake.gate = threading.Event()
        jobs = []
        first = threading.Thread(target=lambda: self.svc.bd(["comments", "add", "task-aa", "held"]))
        first.start()
        time.sleep(0.1)
        second = []
        t = threading.Thread(target=lambda: second.append(self.svc.bd(["comments", "add", "task-aa", "dropped"], jobs=jobs)))
        t.start()
        time.sleep(0.1)
        self.assertTrue(self.svc.cancel(jobs[0]))
        self.fake.gate.set()
        first.join()
        t.join()
        self.svc.close()
        self.assertEqual([t for _, t in self.fake.comments["task-aa"]], ["held"])
        self.assertNotEqual(second[0][0], 0)

    def test_close_finishes_the_queued_writes(self):
        self.fake.delay = 0.05
        ts = [threading.Thread(target=lambda i=i: self.svc.bd(["comments", "add", "task-aa", str(i)])) for i in range(6)]
        for t in ts:
            t.start()
        time.sleep(0.05)
        self.svc.close()
        for t in ts:
            t.join()
        self.assertEqual(len(self.fake.comments["task-aa"]), 6)
        with self.assertRaises(RuntimeError):
            self.svc.bd(["comments", "add", "task-aa", "late"])


class Changes(unittest.TestCase):
    def test_writes_are_pushed_to_watchers_in_one_event_per_burst(self):
        fake = FakeBd(delay=0.0)
        svc, d = service(fake)
        self.addCleanup(shutil.rmtree, d, True)
        self.addCleanup(svc.close)
        got = []
        svc.watch(lambda ev: got.append(ev))
        for i in range(5):
            svc.bd(["comments", "add", "task-aa", str(i)])
        svc.bd(["kv", "set", "k", "v"])
        time.sleep(B.NOTIFY_EVERY * 3)
        self.assertGreaterEqual(len(got), 1)
        self.assertLessEqual(len(got), 2)
        self.assertIn("task-aa", sum((e["ids"] for e in got), []))
        self.assertTrue(any(e["kv"] for e in got))
        self.assertEqual(got[-1]["rev"], svc.rev)

    def test_a_change_made_outside_is_seen_from_the_files(self):
        fake = FakeBd(delay=0.0)
        noms = tempfile.mkdtemp(prefix="noms-")
        self.addCleanup(shutil.rmtree, noms, True)
        with open(os.path.join(noms, "manifest"), "wb") as f:
            f.write(b"root-1")
        with open(os.path.join(noms, "v" * 32), "wb") as f:
            f.write(b"x" * 100)
        svc, d = service(fake, noms=noms, watch_every=0.05)
        self.addCleanup(shutil.rmtree, d, True)
        self.addCleanup(svc.close)
        got = []
        svc.watch(lambda ev: got.append(ev))
        svc.bd(["list", "--json"])
        # a read touches the files' times and writes the manifest again through a temp file: nothing changed
        os.utime(os.path.join(noms, "manifest"))
        with open(os.path.join(noms, "nbs_manifest_12345"), "wb") as f:
            f.write(b"root-1")
        time.sleep(0.3)
        os.remove(os.path.join(noms, "nbs_manifest_12345"))
        time.sleep(0.3)
        self.assertEqual(svc.bd(["list", "--json"])[3], "memory")
        # somebody ran `bd comments add` by hand: the journal grew
        with open(os.path.join(noms, "v" * 32), "ab") as f:
            f.write(b"y" * 10)
        time.sleep(0.3 + B.NOTIFY_EVERY)
        self.assertEqual(svc.bd(["list", "--json"])[3], "bd")
        self.assertTrue(any(e["all"] for e in got))


class Door(unittest.TestCase):
    """Through chatd's door, the way `dispatch` reaches the service from another process."""

    def setUp(self):
        self.fake = FakeBd(delay=0.01)
        self.svc, self.dir = service(self.fake)
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(self.svc.close)
        import queue
        self.door = chatd.Door(queue.Queue())
        self.door.board = self.svc
        self.addCleanup(self.door.close)
        self.dd = os.path.join(self.dir, "dd")
        os.makedirs(self.dd)
        self.write_registry(self.svc.beads_dir)
        board_client.reset()
        self.addCleanup(board_client.reset)

    def write_registry(self, beads_dir, pid=None):
        with open(os.path.join(self.dd, "chatd.json"), "w") as f:
            json.dump({"pid": pid or os.getpid(), "door": self.door.info(),
                       "board": {"protocol": 1, "ready": True, "beads_dir": beads_dir, "mode": "embedded"}, "sessions": {}}, f)

    def call(self, argv, env=None):
        return board_client.call(argv, env, 20, self.dd, self.svc.beads_dir)

    def test_reads_and_writes_go_through_the_door(self):
        self.assertEqual(self.call(["show", "task-aa", "--json"])[0], 0)
        self.assertEqual(self.call(["show", "task-aa", "--json"])[0], 0)
        self.assertEqual(self.fake.count("show"), 1)
        with mock.patch.dict(os.environ, {"BEADS_ACTOR": "claude-code"}):
            self.assertEqual(self.call(["comments", "add", "task-aa", "from a CLI"])[0], 0)
        self.assertEqual(self.fake.comments["task-aa"], [("claude-code", "from a CLI")])

    def test_no_service_means_run_bd_yourself(self):
        os.remove(os.path.join(self.dd, "chatd.json"))
        board_client.reset()
        self.assertIsNone(self.call(["list", "--json"]))

    def test_a_service_that_comes_back_is_used_again(self):
        """A process that lives long (an Agent's MCP server) and saw chatd restart asks the service again
        after a pause, instead of starting bd itself for the rest of its life."""
        reg = os.path.join(self.dd, "chatd.json")
        os.rename(reg, reg + ".away")
        board_client.reset()
        self.assertIsNone(self.call(["show", "task-aa", "--json"]))
        os.rename(reg + ".away", reg)
        self.assertIsNone(self.call(["show", "task-aa", "--json"]))  # within the pause: bd here
        with mock.patch.object(board_client.time, "time", return_value=time.time() + board_client.RETRY_AFTER + 1):
            self.assertEqual(self.call(["show", "task-aa", "--json"])[0], 0)
        self.assertEqual(self.fake.count("show"), 1)

    def test_another_board_is_not_answered(self):
        self.write_registry("/somewhere/else/.beads")
        board_client.reset()
        self.assertIsNone(self.call(["list", "--json"]))

    def test_switched_off(self):
        with mock.patch.dict(os.environ, {"DISPATCH_BOARD_SERVICE": "0"}):
            self.assertIsNone(self.call(["list", "--json"]))

    def test_a_dead_chatd_in_the_registry_is_ignored(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.write_registry(self.svc.beads_dir, pid=p.pid)
        board_client.reset()
        self.assertIsNone(self.call(["list", "--json"]))

    def test_watch_gets_change_events(self):
        info = self.door.info()
        s = socket.create_connection(("127.0.0.1", info["port"]), timeout=5)
        self.addCleanup(s.close)
        f = s.makefile("r", encoding="utf-8")
        s.sendall((json.dumps({"token": info["token"], "board": 1}) + "\n").encode())
        s.sendall((json.dumps({"cmd": "board.watch", "rid": "w"}) + "\n").encode())
        self.assertTrue(json.loads(f.readline())["ok"])
        self.call(["comments", "add", "task-cc", "x"])
        ev = json.loads(f.readline())
        self.assertEqual(ev["ev"], "board_changed")
        self.assertIn("task-cc", ev["ids"])

    def test_a_wrong_token_gets_nothing(self):
        info = self.door.info()
        s = socket.create_connection(("127.0.0.1", info["port"]), timeout=5)
        self.addCleanup(s.close)
        s.sendall((json.dumps({"token": "nope", "board": 1}) + "\n").encode())
        s.sendall((json.dumps({"cmd": "board.bd", "rid": "x", "argv": ["list"]}) + "\n").encode())
        s.settimeout(5)
        try:
            self.assertEqual(s.recv(100), b"")
        except ConnectionResetError:
            pass  # closed without a word either way

    def test_connection_lost_before_the_write_started_runs_bd_here(self):
        """chatd goes away while the write waits in the queue: it never ran, so the caller may run it."""
        self.fake.gate = threading.Event()
        holder = threading.Thread(target=lambda: self.svc.bd(["comments", "add", "task-aa", "first"]))
        holder.start()
        time.sleep(0.1)
        res = []
        t = threading.Thread(target=lambda: res.append(self.call(["comments", "add", "task-aa", "second"])))
        t.start()
        time.sleep(0.2)
        os.remove(os.path.join(self.dd, "chatd.json"))  # the chatd is gone for good
        self.door.close()
        t.join(10)
        self.fake.gate.set()
        holder.join()
        time.sleep(0.1)
        self.assertEqual(res, [None])  # dispatch.sh then runs bd itself
        self.assertEqual([t for _, t in self.fake.comments["task-aa"]], ["first"])  # the queued one was dropped

    def test_connection_lost_while_the_write_runs_is_not_called_a_success(self):
        self.fake.gate = threading.Event()
        res = []
        t = threading.Thread(target=lambda: res.append(self.call(["comments", "add", "task-aa", "maybe"])))
        t.start()
        time.sleep(0.2)
        self.door.close()
        t.join(10)
        self.fake.gate.set()
        self.assertEqual(res[0][0], 75)
        self.assertIn("may or may not be saved", res[0][2])


BD = shutil.which("bd")


@unittest.skipUnless(BD and os.name == "posix", "needs bd")
class RealBoard(unittest.TestCase):
    """A real chatd on a real embedded board in a temp folder."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="bsvc-real-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.board = os.path.join(self.root, "board")
        os.makedirs(self.board)
        self.env = dict(os.environ, HOME=os.path.join(self.root, "home"), DISPATCH_DIR=os.path.join(self.root, "dd"),
                        BEADS_DIR=os.path.join(self.board, ".beads"), BEADS_ACTOR="claude-code", PYTHONDONTWRITEBYTECODE="1")
        for k in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "DISPATCH_IDE_BIN"):
            self.env.pop(k, None)
        os.makedirs(self.env["HOME"])
        os.makedirs(self.env["DISPATCH_DIR"])
        r = subprocess.run([BD, "init", "--prefix", "task", "--non-interactive", "--skip-hooks", "--quiet"], cwd=self.board,
                           env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run([BD, "create", "Crash test", "-t", "task", "-p", "2", "--json"], env=self.env, capture_output=True, text=True, timeout=60)
        self.tid = json.loads(r.stdout)["id"]
        self.chatd = None
        self.addCleanup(self.stop_chatd)

    def start_chatd(self):
        log = open(os.path.join(self.root, "chatd.log"), "a")
        self.addCleanup(log.close)
        # serve() as `dispatch chatd run` does, without the daily doctor; stdin is the stop signal
        code = ("import sys; sys.path.insert(0, %r); import chatd; chatd.serve(write=lambda l: None)" % HERE)
        self.chatd = subprocess.Popen([sys.executable, "-c", code], env=self.env, stdin=subprocess.PIPE, stdout=log, stderr=log)
        end = time.time() + 30
        while time.time() < end:
            try:
                with open(os.path.join(self.env["DISPATCH_DIR"], "chatd.json")) as f:
                    if (json.load(f).get("board") or {}).get("ready"):
                        return
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        self.fail("chatd did not come up")

    def stop_chatd(self):
        if self.chatd is not None and self.chatd.poll() is None:
            self.chatd.kill()
            self.chatd.wait()
        if self.chatd is not None and self.chatd.stdin and not self.chatd.stdin.closed:
            self.chatd.stdin.close()

    def dispatch(self, *argv, timeout=180):
        return subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py")] + list(argv), env=self.env,
                              capture_output=True, text=True, timeout=timeout, cwd=self.board)

    def bd(self, *argv):
        env = dict(self.env, DISPATCH_BOARD_SERVICE="0")
        r = subprocess.run([BD] + list(argv), env=env, capture_output=True, text=True, timeout=120)
        return r.returncode, r.stdout, r.stderr

    def test_writes_through_the_service_land_and_a_killed_chatd_loses_none_it_confirmed(self):
        self.start_chatd()
        # a plain round trip first: the service answers, bd's own output comes back
        r = self.dispatch("log", self.tid, "through the service")
        self.assertEqual(r.returncode, 0, r.stderr)
        stats = json.loads(self.dispatch("board", "stats", "--json").stdout)["stats"]
        self.assertGreaterEqual(stats["writes"], 1)
        # many writers at once; chatd is killed (SIGKILL, no goodbye) while they are queued
        n = 12
        out = {}

        def writer(i):
            out[i] = self.dispatch("log", self.tid, "burst %d" % i)

        ts = [threading.Thread(target=writer, args=(i,)) for i in range(n)]
        for t in ts:
            t.start()
        time.sleep(2.0)
        self.chatd.send_signal(signal.SIGKILL)
        self.chatd.wait()
        self.chatd.stdin.close()
        for t in ts:
            t.join(300)
        code, o, err = self.bd("comments", self.tid, "--json")
        self.assertEqual(code, 0, err)  # the board still opens
        texts = [c["text"] for c in json.loads(o)]
        self.assertIn("through the service", texts)
        unsure = 0
        for i, r in out.items():
            if r.returncode == 0:
                self.assertIn("burst %d" % i, texts, "confirmed but not saved: %r" % r.stderr[-300:])
            elif "may or may not be saved" in r.stderr:
                unsure += 1
            else:
                # after chatd is gone the rest run bd themselves, all at once, as before the service:
                # a caller may give up waiting for the database, and then it says so
                self.assertIn("did not answer within", r.stderr)
        self.assertLessEqual(unsure, 1)  # only the one bd that was running when chatd died
        # nothing written twice
        self.assertEqual(len(texts), len(set(texts)))
        # and a new chatd serves the same board again
        self.start_chatd()
        r = self.dispatch("log", self.tid, "after the restart")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("after the restart", [c["text"] for c in json.loads(self.bd("comments", self.tid, "--json")[1])])

    def test_a_graceful_stop_finishes_every_queued_write(self):
        """Quitting (stdin closed, like SIGTERM under launchd) waits for the queue: every write is saved."""
        self.start_chatd()
        n = 8
        out = {}

        def writer(i):
            out[i] = self.dispatch("log", self.tid, "queued %d" % i)

        ts = [threading.Thread(target=writer, args=(i,)) for i in range(n)]
        for t in ts:
            t.start()
        time.sleep(1.5)
        self.chatd.stdin.close()
        self.chatd.wait(120)
        for t in ts:
            t.join(300)
        texts = [c["text"] for c in json.loads(self.bd("comments", self.tid, "--json")[1])]
        for i, r in out.items():
            if r.returncode == 0:
                self.assertIn("queued %d" % i, texts)
            else:
                self.assertIn("did not answer within", r.stderr)  # came after the stop and ran bd itself
        self.assertEqual(len(texts), len(set(texts)))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(BD and os.name == "posix", "needs bd")
class RealSnapshot(unittest.TestCase):
    """The whole board in memory against bd itself, on a real embedded board: after every kind of write the
    service makes, each list and the export it answers from memory equal what bd answers, and only the
    issues the write touched were read again."""

    QUERIES = [
        ["export"],
        ["list", "--all", "-n", "0", "--json"],
        ["list", "--all", "--json"],
        ["list", "--json"],
        ["list", "--json", "-n", "0", "--status", "open,in_progress,blocked"],
        ["list", "--status", "in_progress", "--json"],
        ["list", "--status", "closed", "--json"],
        ["list", "--label", "project:alpha", "--all", "--json", "--limit", "0"],
        ["list", "--label", "project:alpha", "--label", "kind:x", "--all", "--json", "--limit", "0"],
        ["list", "--label-any", "session-origin:s1,session:s2", "--all", "--json", "--limit", "0"],
        ["list", "--label", "project:alpha", "--status", "open", "--json", "-n", "0"],
        ["list", "--all", "--json", "-n", "2"],
        ["list", "--id", "ID0,ID2", "--json"],
        ["list", "--id", "ID0,ID2", "--all", "--json"],
    ]

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="bsvc-snap-")
        self.addCleanup(shutil.rmtree, self.root, True)
        board = os.path.join(self.root, "board")
        os.makedirs(board)
        self.env = {"PATH": os.environ.get("PATH", ""), "HOME": os.path.join(self.root, "home"),
                    "BEADS_DIR": os.path.join(board, ".beads"), "BEADS_ACTOR": "claude-code", "BD_NON_INTERACTIVE": "1"}
        os.makedirs(self.env["HOME"])
        r = subprocess.run([BD, "init", "--prefix", "task", "--non-interactive", "--skip-hooks", "--quiet"], cwd=board,
                           env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.ids = []
        for i, (title, labels, prio) in enumerate([("Alpha one", "project:alpha,kind:x,session-origin:s1", 1),
                                                    ("Alpha two", "project:alpha", 2),
                                                    ("Beta", "project:beta,session:s2", 2),
                                                    ("Gamma", "project:alpha,kind:x", 0)]):
            self.ids.append(self.raw("create", title, "-t", "task", "-p", str(prio), "-l", labels, "--json", out=True)["id"])
        self.raw("update", self.ids[1], "--status", "in_progress")
        self.raw("comments", "add", self.ids[0], "first note")
        self.raw("close", self.ids[3], "--reason", "done")
        self.runs = []

        def run(argv, env, timeout):
            self.runs.append(list(argv))
            r = subprocess.run([BD] + list(argv), env=dict(self.env, **(env or {})), capture_output=True, text=True, timeout=timeout)
            return r.returncode, r.stdout, r.stderr
        self.svc = B.BoardService(self.env["BEADS_DIR"], run, noms="")
        self.addCleanup(self.svc.close)

    def raw(self, *argv, out=False):
        r = subprocess.run([BD] + list(argv), env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if out else r.stdout

    def parsed(self, kind, text):
        return B.parse_rows("export" if kind == "export" else "list", text)

    def check(self, what):
        for q in self.QUERIES:
            q = [self.ids[int(a[2])] if a.startswith("ID") and len(a) == 3 else a for a in q]
            q = [",".join(self.ids[int(x[2:])] for x in a.split(",")) if a.startswith("ID") else a for a in q]
            self.assertIsNotNone(B.snapshot_query(q), q)
            code, out, err, via = self.svc.bd(q)
            self.assertEqual(code, 0, err)
            want = self.raw(*q)
            self.assertEqual(self.parsed(q[0], out), self.parsed(q[0], want), "%s after %s" % (" ".join(q), what))

    def test_every_write_is_followed_by_reading_only_what_it_touched(self):
        self.check("nothing")
        loads = self.svc.stats["snap_loads"]
        self.assertEqual(loads, 2)  # one list, one export: everything else from them
        writes = [
            ("a comment", ["comments", "add", self.ids[2], "hello, see %s" % self.ids[0]]),
            ("a status", ["update", self.ids[0], "--status", "in_progress", "--json"]),
            ("a claim with metadata", ["update", self.ids[2], "--claim", "--set-metadata", "claim_session=s9", "--json"]),
            ("labels", ["update", self.ids[1], "--add-label", "session:s2", "--remove-label", "project:alpha", "--json"]),
            ("a dependency", ["dep", "add", self.ids[0], self.ids[2]]),
            ("a new task with a dependency", ["create", "Delta", "-t", "task", "-p", "1", "-l", "project:alpha", "--deps", "blocks:" + self.ids[1], "--json"]),
            ("a child", ["create", "Child", "-t", "task", "--parent", self.ids[0], "--json"]),
            ("closing", ["close", self.ids[2], "--reason", "finished"]),
            ("reopening", ["reopen", self.ids[3]]),
            ("a second comment", ["comments", "add", self.ids[0], "second"]),
        ]
        for what, argv in writes:
            code, out, err, _via = self.svc.bd(argv, {"BEADS_ACTOR": "codex"})
            self.assertEqual(code, 0, "%s: %s" % (what, err))
            before = len(self.runs)
            self.check(what)
            full = [r for r in self.runs[before:] if r in (["export"], B.SNAP_FULL)]
            self.assertEqual(full, [], "%s read the whole board again" % what)
        self.assertEqual(self.svc.stats["snap_loads"], loads)
        # a write it cannot follow by id: the next read takes the whole board again, and is right
        code, _o, err, _v = self.svc.bd(["delete", self.ids[3], "--force"])
        self.assertEqual(code, 0, err)
        self.check("a delete")
        self.assertGreater(self.svc.stats["snap_loads"], loads)

    def test_a_comment_written_through_the_service_needs_no_read(self):
        self.check("nothing")
        for tid in self.ids:
            code, out, _err, _via = self.svc.bd(["comments", "add", tid, "a note on " + tid])
            self.assertEqual((code, out), (0, "Comment added to %s\n" % tid))  # what bd says without --json
        before = len(self.runs)
        self.check("comments on every issue")
        later = self.runs[before:]
        self.assertFalse([r for r in later if r[0] in ("comments", "export")], later)
        self.assertEqual(self.svc.stats["snap_comments_said"], len(self.ids))

    def test_comments_on_many_issues_read_the_export_again_whole(self):
        self.check("nothing")
        for tid in self.ids:  # the caller asked for JSON itself: the service does not keep what it said
            self.assertEqual(self.svc.bd(["comments", "add", tid, "a note on " + tid, "--json"])[0], 0)
        before = len(self.runs)
        self.check("comments on every issue")
        later = self.runs[before:]
        self.assertIn(["export"], later)
        self.assertFalse([r for r in later if r[0] == "comments"], later)

    def test_a_change_made_outside_is_read_whole(self):
        self.check("nothing")
        self.raw("update", self.ids[0], "--title", "Changed by hand")
        self.svc.forget("outside")  # what the file watch does when the database changed and not by the service
        self.check("a change by hand")
        self.assertIn("Changed by hand", self.svc.bd(["list", "--all", "-n", "0", "--json"])[1])
