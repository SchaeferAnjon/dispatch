import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board_export as B


class BoardExport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.board = self.home / "board"
        self.board.mkdir()
        self.state = self.home / "state"
        self.root = self.board / "embeddeddolt" / "task"
        self.noms = self.root / ".dolt" / "noms"
        self.noms.mkdir(parents=True)
        (self.noms / "manifest").write_text("manifest-1")
        (self.noms / B.JOURNAL).write_text("journal-1")
        (self.root / ".dolt/repo_state.json").write_text('{"head":"main"}')
        self.metadata(mode="embedded")
        self.calls = self.home / "calls"
        self.data = self.home / "data"
        self.data.write_text('noise\n[]\n{"_type":"config","id":"config"}\n{"id":"task-ab","title":"one"}\n')
        self.fake = self.home / "bd.py"
        self.fake.write_text("""import os, sys, time
from pathlib import Path
home = Path(sys.argv[1])
assert sys.argv[2:] == ['export'], sys.argv
with (home / 'calls').open('a') as f: f.write('export\\n')
time.sleep(0.15)
if (home / 'fail').exists(): sys.exit(1)
if (home / 'mutate').exists():
    journal = Path((home / 'mutate').read_text())
    with journal.open('a') as f: f.write('new write')
print((home / 'data').read_text())
""")
        self.kw = dict(beads_dir=str(self.board), dispatch_dir=str(self.state), home=str(self.home))
        env = patch.dict(os.environ, {k: "" for k in os.environ if k.startswith("BEADS_")})
        env.start()
        self.addCleanup(env.stop)

    def metadata(self, **kw):
        obj = {"backend": "dolt", "dolt_database": "task", **{"dolt_" + k: v for k, v in kw.items()}}
        (self.board / "metadata.json").write_text(json.dumps(obj))

    def run_bd(self, args, timeout):
        self.assertEqual(args, ["bd", "export"])
        r = subprocess.run([sys.executable, str(self.fake), str(self.home), *args[1:]],
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr

    def read(self):
        return B.export_issues(self.run_bd, **self.kw)

    def count(self):
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0

    def test_hit_parses_only_issues_and_returns_independent_rows(self):
        rows = self.read()
        self.assertEqual(rows, [{"id": "task-ab", "title": "one"}])
        rows[0]["title"] = "mutated by caller"
        self.assertEqual(self.read()[0]["title"], "one")
        self.assertEqual(self.count(), 1)

    def test_journal_append_invalidates_even_when_manifest_stays_the_same(self):
        self.read()
        with (self.noms / B.JOURNAL).open("a") as f:
            f.write("write")
        self.data.write_text('{"id":"task-ab","title":"two"}\n')
        self.assertEqual(self.read()[0]["title"], "two")
        self.assertEqual(self.count(), 2)

    def test_same_size_journal_rewrite_invalidates(self):
        self.read()
        (self.noms / B.JOURNAL).write_text("journal-2")
        self.read()
        self.assertEqual(self.count(), 2)

    def test_manifest_and_repo_state_changes_invalidate(self):
        self.read()
        (self.noms / "manifest").write_text("manifest-2")
        self.read()
        (self.root / ".dolt/repo_state.json").write_text('{"head":"other"}')
        self.read()
        self.assertEqual(self.count(), 3)

    def test_shared_server_uses_its_own_database_directory(self):
        shared = self.home / ".beads/shared-server"
        target = shared / "dolt/task"
        target.parent.mkdir(parents=True)
        self.root.rename(target)
        (shared / "dolt-server.port").write_text("3308\n")
        (self.board / "config.yaml").write_text("dolt:\n  mode: server\n  shared-server: true\n  host: 127.0.0.1\n  port: 3308\n")
        self.metadata(mode="server")
        self.assertEqual(B.local_store(str(self.board), str(self.home)), target.resolve())
        self.read(); self.read()
        self.assertEqual(self.count(), 1)
        with (target / ".dolt/noms" / B.JOURNAL).open("a") as f:
            f.write("shared write")
        self.read()
        self.assertEqual(self.count(), 2)
        (self.board / "config.yaml").write_text("dolt.host: 127.0.0.1\ndolt.port: 3309\ndolt.shared-server: true\n")
        self.read(); self.read()
        self.assertEqual(self.count(), 4)

    def test_remote_hosts_never_use_a_local_copy(self):
        for field in ("config", "metadata", "env"):
            with self.subTest(field=field):
                (self.board / "config.yaml").write_text("dolt.host: remote.example\n" if field == "config" else "")
                self.metadata(mode="embedded", **({"server_host": "remote.example"} if field == "metadata" else {}))
                with patch.dict(os.environ, {"BEADS_DOLT_SERVER_HOST": "remote.example" if field == "env" else ""}):
                    self.read(); self.read()
        self.assertEqual(self.count(), 6)

    def test_missing_data_and_unreadable_fingerprint_fall_back(self):
        (self.noms / "manifest").rename(self.noms / "old-manifest")
        self.read(); self.read()
        self.root.rename(self.root.with_name("other"))
        self.read(); self.read()
        self.assertEqual(self.count(), 4)

    def test_failed_export_is_not_cached(self):
        (self.home / "fail").touch()
        self.assertEqual(self.read(), [])
        self.assertEqual(self.read(), [])
        self.assertEqual(self.count(), 2)

    def test_concurrent_write_does_not_cache_the_older_export(self):
        (self.home / "mutate").write_text(str(self.noms / B.JOURNAL))
        self.read(); self.read()
        self.assertEqual(self.count(), 2)
        self.assertEqual(list(self.state.glob("board-export/*.json")), [])

    def test_corrupt_cache_recovers(self):
        self.read()
        next(self.state.glob("board-export/*.json")).write_text("broken")
        self.read(); self.read()
        self.assertEqual(self.count(), 2)

    def test_processes_export_only_once(self):
        script = """import json, subprocess, sys
sys.path.insert(0, sys.argv[1])
from board_export import export_issues
def run(args, timeout):
    r = subprocess.run([sys.executable, sys.argv[2], sys.argv[3], *args[1:]], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr
print(json.dumps(export_issues(run, **json.loads(sys.argv[4]))))
"""
        argv = [sys.executable, "-c", script, os.path.dirname(B.__file__), str(self.fake), str(self.home), json.dumps(self.kw)]
        processes = [subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(6)]
        for p in processes:
            out, err = p.communicate(timeout=15)
            self.assertEqual(p.returncode, 0, err)
            self.assertEqual(json.loads(out)[0]["title"], "one")
        self.assertEqual(self.count(), 1)

    def test_tasks_lineage_docs_ownership_thread_share_the_cache(self):
        import tasks_view as T
        import lineage as L
        import docs_view as V
        import ownership as O
        import thread as TH
        d = SimpleNamespace(BEADS_DIR=str(self.board), DISPATCH_DIR=str(self.state), HOME=str(self.home),
                            sh=self.run_bd, docs_list=lambda *args: [])
        with patch.object(T, "D", d), patch.object(L, "D", d), patch.object(V, "D", d):
            self.assertEqual(len(T.board_export()), 1)
            self.assertEqual(len(L.board_export()), 1)
            V.list_view("kanban", [])
            O.board_rows(T)
            TH.line_issues(L.board_export())
        self.assertEqual(self.count(), 1)


if __name__ == "__main__":
    unittest.main()
