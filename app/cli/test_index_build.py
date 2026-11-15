"""First-build progress, streaming correctness and incremental cache isolation."""
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import dispatch as D
import projects_view as PV


def line(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


class IndexBuild(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.state = self.home / "state"
        self.state.mkdir()
        values = dict(HOME=str(self.home), DISPATCH_DIR=str(self.state),
                      BEADS_DIR=str(self.home / "board"), INDEX_FILE=str(self.state / "index.json"),
                      INDEX_PROGRESS_FILE=str(self.state / "index-progress.json"),
                      INDEX_LOCK_FILE=str(self.state / "index.lock"),
                      INDEX_START_LOCK_FILE=str(self.state / "index-start.lock"))
        for key, value in values.items():
            self.stack.enter_context(patch.object(D, key, value))
        self.stack.enter_context(patch.dict(os.environ, {"CODEX_HOME": str(self.home / ".codex"), "DISPATCH_SESSION_ROOT": ""}))
        self.stack.enter_context(patch.object(D, "zcode_query", return_value=[]))
        self.stack.enter_context(patch.object(__import__("engines.hermes", fromlist=["x"]), "query", return_value=[]))
        self.stack.enter_context(patch.object(__import__("engines.gemini", fromlist=["x"]), "index"))

    def transcript(self, name="a", text="Fix task-ab12"):
        p = self.home / ".claude" / "projects" / "demo" / (name + ".jsonl")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(line({"type": "user", "cwd": str(self.home / "Projects/demo"),
                           "timestamp": "2026-09-29T00:00:00Z", "message": {"content": text}}))
        return p

    def test_chunk_boundaries_tokens_claims_and_utf8(self):
        p = self.transcript(text="修复 task-ab12 " + "中文" * 1000)
        with p.open("a") as f:
            f.write(line({"type": "assistant", "timestamp": "2026-09-29T00:01:00Z", "requestId": "r1",
                          "message": {"model": "fixture", "usage": {"input_tokens": 10, "output_tokens": 3},
                                      "content": [{"type": "tool_use", "id": "t", "name": "Bash",
                                                   "input": {"command": "dispatch log task-ab12 fixed"}}]}}))
            f.write(line({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t",
                                                                   "content": "dispatch claim task-fake"}]}}))
        with patch.object(D, "INDEX_CHUNK", 31):
            e = D.refresh_index()[str(p)]
        self.assertEqual(e["claims"], ["task-ab12"])
        self.assertEqual(e["tasks"], {"task-ab12": 2, "task-fake": 1})
        self.assertEqual(e["tokens"]["in"], 10)
        self.assertEqual(e["tokens"]["out"], 3)
        self.assertEqual(e["user_msgs"], 2)
        self.assertEqual(e["assistant_msgs"], 1)
        self.assertTrue(e["first_prompt"].startswith("修复 task-ab12"))
        self.assertEqual(e["off"], p.stat().st_size)
        with patch.object(D, "_index_read_file", side_effect=AssertionError("cached transcript reread")):
            self.assertEqual(D.refresh_index()[str(p)], e)

    def test_partial_live_record_is_read_once_after_append(self):
        p = self.transcript()
        off = p.stat().st_size
        row = line({"type": "user", "message": {"content": "中文 task-cd34"}}).encode()
        with p.open("ab") as f:
            f.write(row[:-5])
        e = D.refresh_index()[str(p)]
        self.assertEqual(e["off"], off)
        self.assertEqual(e["user_msgs"], 1)
        with p.open("ab") as f:
            f.write(row[-5:])
        e = D.refresh_index()[str(p)]
        self.assertEqual(e["user_msgs"], 2)
        self.assertEqual(e["tasks"], {"task-ab12": 1, "task-cd34": 1})

    def test_truncated_transcript_discards_old_title_and_statistics(self):
        p = self.transcript(text="old title " * 100)
        D.refresh_index()
        p.write_text(line({"type": "user", "cwd": "/new", "message": {"content": "new title"}}))
        e = D.refresh_index()[str(p)]
        self.assertEqual((e["cwd"], e["first_prompt"], e["user_msgs"]), ("/new", "new title", 1))

    def test_partial_index_progress_and_final_counts(self):
        for i in range(30):
            self.transcript(str(i))
        seen = []
        save = D.save_index

        def capture(idx):
            save(idx)
            seen.append((len(idx), D.index_progress()))

        with patch.object(D, "INDEX_SAVE_EVERY", 0), patch.object(D, "save_index", side_effect=capture):
            idx = D.refresh_index()
        self.assertEqual(len(idx), 30)
        self.assertTrue(any(0 < n < 30 and p["state"] == "running" for n, p in seen))
        self.assertEqual({k: D.index_progress()[k] for k in ("state", "done", "total")},
                         {"state": "done", "done": 30, "total": 30})

    def test_parallel_worker_matches_sequential(self):
        paths = [self.transcript(str(i)) for i in range(4)]
        rx = D._index_rx("task")
        rows = [(str(p), "claude-code", {**D._index_row_new(str(p), "claude-code"),
                                        "stats_v": D.STATS_V, **D.stats_fields()}) for p in paths]
        result = {}
        failed = D._index_parallel(rows, "task", 2, lambda p, row: result.update({p: row}))
        self.assertEqual(failed, [])
        for p, agent, row in rows:
            self.assertEqual(result[p], D._index_read_file(p, agent, row, rx))

    def test_background_empty_build_finishes_and_does_not_loop(self):
        env = {**os.environ, "HOME": str(self.home), "CODEX_HOME": str(self.home / ".codex"),
               "DISPATCH_DIR": str(self.state), "BEADS_DIR": str(self.home / "board"),
               "HERMES_HOME": str(self.home / ".hermes"), "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run([sys.executable, D.__file__, "index", "--background", "--json"],
                                env=env, capture_output=True, text=True, check=True, timeout=10)
        first = json.loads(result.stdout)
        self.assertIn(first["state"], ("running", "done"))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and D.index_progress()["state"] == "running":
            time.sleep(.05)
        self.assertEqual(D.index_progress()["state"], "done")
        self.assertEqual(D.index_progress()["total"], 0)
        # The actual CLI uses the default filename in this isolated state directory.
        self.assertTrue((self.state / "transcript-index.json").exists())
        with patch.object(D, "INDEX_FILE", str(self.state / "transcript-index.json")), patch.object(D, "index_start_background") as start:
            self.assertIsNone(D.index_ensure())
            start.assert_not_called()

    def test_running_builder_is_reused_and_interruption_visible(self):
        rec = {"state": "running", "pid": os.getpid(), "done": 12, "total": 30, "updated_at": time.time()}
        D._index_progress_write(rec)
        with patch.object(D.P, "spawn_detached") as spawn:
            self.assertEqual(D.index_start_background()["done"], 12)
            spawn.assert_not_called()
        rec["pid"] = 99999999
        D._index_progress_write(rec)
        self.assertEqual(D.index_ensure()["state"], "interrupted")

    def test_projects_exposes_progress_without_waiting_for_builder(self):
        with patch.object(PV, "D", D), patch.object(D, "index_ensure", return_value={"state": "running", "done": 1200, "total": 2535}):
            self.assertEqual(PV.index_building(), {"state": "running", "done": 1200, "total": 2535})


if __name__ == "__main__":
    unittest.main()
