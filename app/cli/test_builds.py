"""dispatch build (builds.py): the queue, reuse of a built commit, the failure summary, results onto the task,
development builds, and the MacBook → mini path (through a fake ssh that runs the "remote" commands here)."""
import argparse, io, json, os, shutil, stat, subprocess, sys, tempfile, time, unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import builds as B
B.LSREGISTER = "/nonexistent/lsregister"  # never the real LaunchServices database from a test (LaunchServicesCopies)
import tasks_view as T
from test_tasks_view import FakeBoard, issue

# ide/remote-build.sh as far as the service sees it. --here: name on stdout, a detached "build" that writes
# build.log, then status and the app ($B/outcome: ok or failed). --dev-run: a development build in the foreground,
# its app a tree in $B/devtree. Every call is appended to $B/calls.
STUB = r'''#!/bin/bash
B="${DISPATCH_BUILDS_DIR:?}"
if [ "$1" = --dev-run ]; then
  d="$B/$3"; mkdir -p "$d" "$B/devtree"; echo "dev $3" >>"$B/calls"
  { echo "commit $2 the change"; echo "dev build"; } >"$d/build.log"
  if [ "$(cat "$B/outcome" 2>/dev/null || echo ok)" = ok ]; then
    printf '{"app": "%s", "build_seconds": 2, "dev": true}' "$B/devtree" >"$d/info.json"; echo "ok 2" >"$d/status"
  else echo "failed 1 2" >"$d/status"; fi
  exit 0
fi
[ "$1" = --here ] || exit 2; shift
sha=$1; shift; min=""; rebuild=""
while [ $# -gt 0 ]; do case "$1" in --min) min=1; shift;; --rebuild) rebuild=1; shift;; *) shift;; esac; done
name="${sha:0:12}${min:+-min}"; d="$B/$name"; mkdir -p "$d"
echo "$name" >>"$B/calls"
if [ -z "$rebuild" ] && grep -q '^ok' "$d/status" 2>/dev/null && [ -d "$d/Dispatch IDE.app" ]; then echo "name: $name"; echo "already built"; exit 0; fi
rm -f "$d/status"
outcome="$(cat "$B/outcome" 2>/dev/null || echo ok)"
nohup bash -c "echo 'commit $sha the change'; for i in \$(seq 1 80); do echo line \$i; done; sleep 0.3; if [ '$outcome' = ok ]; then mkdir -p '$d/Dispatch IDE.app'; echo 'ok 1' >'$d/status'; else echo 'failed 2 1' >'$d/status'; fi" >"$d/build.log" 2>&1 </dev/null &
echo $! >"$d/pid"
echo "name: $name"; echo "started (pid $!)"
'''

# ssh as far as the service uses it: options, the host, then a command for a shell in $HOME
FAKE_SSH = r'''#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o|-p|-l|-i) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "$HOME" && exec bash -c "$*"
'''

SHA = "a" * 40
NAME = B.build_name(SHA)


def script(path, text):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


def sleeper():
    return subprocess.Popen(["sleep", "30"])


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="builds-test-")
        self.bdir = os.path.join(self.tmp, "builds")
        os.makedirs(self.bdir)
        self.env = {"DISPATCH_BUILDS_DIR": self.bdir, "DISPATCH_BUILD_STATE": os.path.join(self.tmp, "state"),
                    "DISPATCH_BUILD_STAGING": os.path.join(self.tmp, "staging"), "DISPATCH_BUILD_POLL": "0.2",
                    "DISPATCH_BUILD_SELF": "mini", "DISPATCH_BIN": os.path.join(self.tmp, "no-dispatch")}
        self.p = patch.dict(os.environ, self.env)
        self.p.start()
        self.procs = []
        self.rb = script(os.path.join(self.tmp, "remote-build.sh"), STUB)

    def tearDown(self):
        self.p.stop()
        for p in self.procs:
            p.terminate()
            p.wait()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def live(self):
        p = sleeper()
        self.procs.append(p)
        return p.pid

    def build_dir(self, name, status=None, app=False, pid=None, log=""):
        d = os.path.join(self.bdir, name)
        os.makedirs(d, exist_ok=True)
        if status:
            open(os.path.join(d, "status"), "w").write(status + "\n")
        if app:
            os.makedirs(os.path.join(d, B.APP_NAME), exist_ok=True)
        if pid:
            open(os.path.join(d, "pid"), "w").write(str(pid))
        with open(os.path.join(d, "build.log"), "w") as f:
            f.write(log)
        return d

    def wait_result(self, name, rid, timeout=20):
        path = os.path.join(self.bdir, name, "requests", rid, "result.json")
        t0 = time.time()
        while time.time() - t0 < timeout:
            if os.path.exists(path):
                return json.loads(B.read(path))
            time.sleep(0.1)
        self.fail(f"no result for {rid}: {B.read(os.path.join(self.bdir, name, 'requests', rid, 'job.log'))}")


class Queue(Env):
    def test_building_and_places_in_line(self):
        first, second, third = self.live(), self.live(), self.live()
        self.build_dir("one", pid=first)
        self.build_dir("two", pid=second)
        self.build_dir("three", pid=third)
        open(os.path.join(self.bdir, ".lock.name"), "w").write("one\n")
        q = os.path.join(self.bdir, ".queue")
        os.makedirs(q)
        # a ticket of a build that is gone does not hold anyone up; order is by time, not by name
        for t in (f"100-{third}", f"50-{second}", "10-999999"):
            open(os.path.join(q, t), "w").write("x")
        states = {n: B.build_state(self.bdir, n) for n in ("one", "two", "three")}
        self.assertEqual(states["one"]["state"], "building")
        self.assertEqual((states["two"]["state"], states["two"]["position"]), ("queued", 1))
        self.assertEqual((states["three"]["state"], states["three"]["position"]), ("queued", 2))
        self.assertEqual(B.state_word(dict(states["three"], requests=[])), "queued #2")
        self.assertEqual(B.host_list(self.bdir)["queue"], 2)

    def test_final_states_and_a_vanished_build(self):
        self.build_dir("good", status="ok 233", app=True)
        self.build_dir("bad", status="failed 2 50")
        self.build_dir("gone", pid=999999)  # no status, process gone
        self.assertEqual(B.build_state(self.bdir, "good")["state"], "ok")
        bad = B.build_state(self.bdir, "bad")
        self.assertEqual((bad["state"], bad["rc"], bad["seconds"]), ("failed", 2, 50))
        gone = B.build_state(self.bdir, "gone")
        self.assertEqual((gone["state"], gone.get("gone")), ("failed", True))
        self.assertEqual(B.build_state(self.bdir, "never")["state"], "none")


class Reuse(Env):
    def test_a_built_commit_is_reused_without_building(self):
        self.build_dir(NAME, status="ok 200", app=True, log=f"commit {SHA} x\n")
        r = B.host_start(self.bdir, SHA, "r1", {"by": "agent-a"}, self.rb)
        self.assertTrue(r["reused"])
        self.assertFalse(os.path.exists(os.path.join(self.bdir, "calls")))
        res = self.wait_result(NAME, "r1")
        self.assertEqual((res["state"], res["reused"]), ("ok", True))

    def test_a_pruned_app_is_built_again(self):
        self.build_dir(NAME, status="ok 200", app=False)
        r = B.host_start(self.bdir, SHA, "r1", {}, self.rb)
        self.assertFalse(r["reused"])
        self.assertEqual(B.read(os.path.join(self.bdir, "calls")).split(), [NAME])
        self.assertEqual(self.wait_result(NAME, "r1")["state"], "ok")

    def test_a_second_request_joins_the_running_build(self):
        B.host_start(self.bdir, SHA, "r1", {"by": "a"}, self.rb)
        r2 = B.host_start(self.bdir, SHA, "r2", {"by": "b"}, self.rb)
        self.assertTrue(r2["joined"] or r2["reused"])
        self.assertEqual(B.read(os.path.join(self.bdir, "calls")).split(), [NAME])
        self.assertEqual(self.wait_result(NAME, "r1")["state"], "ok")
        self.assertEqual(self.wait_result(NAME, "r2")["state"], "ok")
        reqs = B.host_show(self.bdir, NAME)["requests"]
        self.assertEqual([(x["rid"], x["request"]["by"]) for x in reqs], [("r1", "a"), ("r2", "b")])


class Failure(Env):
    def test_the_last_60_lines_go_into_the_result(self):
        open(os.path.join(self.bdir, "outcome"), "w").write("failed")
        B.host_start(self.bdir, SHA, "r1", {}, self.rb)
        res = self.wait_result(NAME, "r1")
        self.assertEqual((res["state"], res["stage"], res["rc"]), ("failed", "build", 2))
        lines = res["tail"].splitlines()
        self.assertEqual(len(lines), 60)
        self.assertEqual(lines[-1], "line 80")
        self.assertEqual(res["commits"]["commit"], {"sha": SHA, "subject": "the change"})
        md = B.read(os.path.join(self.bdir, NAME, "requests", "r1", "result.md"))
        self.assertIn("## Last 60 lines of the build log", md)
        self.assertIn("line 80", md)
        shown = B.host_show(self.bdir, NAME)
        self.assertEqual(shown["state"], "failed")
        self.assertIn("line 21", shown["tail"])
        self.assertNotIn("line 20\n", shown["tail"] + "\n")


FAKE_DISPATCH = r'''#!/bin/bash
# `dispatch ide instance|e2e` as G's commands are named: record the call, make screenshots on e2e run
echo "$*" >>"$(dirname "$0")/dispatch-calls"
case "$1 $2 $3" in
  "ide e2e --help"|"ide instance --help") exit 0 ;;
  "ide instance start"|"ide instance stop") exit 0 ;;
  "ide e2e run")
    out=""; prev=""; for a in "$@"; do [ "$prev" = --out ] && out="$a"; prev="$a"; done
    case "$4" in *codex*) echo '{"scenario": "codex", "status": "skipped", "reason": "codex: not signed in"}'; exit 0;; esac
    mkdir -p "$out"; printf 'png' >"$out/01-open.png"
    case "$4" in *broken*) echo "click: no element"; echo '{"status": "failed", "error": "click: no element"}'; exit 1;; esac
    echo '{"status": "passed", "steps": 3}'; exit 0 ;;
  "ide e2e annotate") printf 'png' >"$4/00-where-is-what.png"; echo "# where" >"$4/README.md"; exit 0 ;;
esac
exit 3
'''


class E2E(Env):
    def request_with(self, *scenarios):
        self.build_dir(NAME, status="ok 200", app=True)
        sc = os.path.join(self.bdir, NAME, "requests", "r1", "scenarios")
        os.makedirs(sc)
        for s in scenarios:
            open(os.path.join(sc, s), "w").write("export default async (h) => {}")
        return B.host_start(self.bdir, SHA, "r1", {}, self.rb)

    def test_skipped_with_the_reason_while_the_commands_are_missing(self):
        os.environ["DISPATCH_BIN"] = script(os.path.join(self.tmp, "old-dispatch"), "#!/bin/bash\necho 'invalid choice: e2e' >&2; exit 2\n")
        self.request_with("waiting.mjs")
        res = self.wait_result(NAME, "r1")
        self.assertEqual(res["state"], "ok")
        self.assertEqual(res["e2e"]["state"], "skipped")
        self.assertIn("not in this machine's dispatch yet", res["e2e"]["reason"])

    def test_runs_every_scenario_in_an_instance_started_as_it_asks(self):
        fake = script(os.path.join(self.tmp, "fake-dispatch"), FAKE_DISPATCH)
        os.environ["DISPATCH_BIN"] = fake
        self.request_with("waiting.mjs", "broken.mjs", "needs-codex.mjs")
        res = self.wait_result(NAME, "r1")
        self.assertEqual((res["state"], res["stage"]), ("failed", "e2e"))
        runs = {r["scenario"]: r for r in res["e2e"]["runs"]}
        self.assertEqual(runs["waiting.mjs"]["status"], "ok")
        self.assertTrue(runs["waiting.mjs"]["annotated"].endswith("e2e/waiting/00-where-is-what.png"))
        self.assertEqual([os.path.basename(p) for p in runs["waiting.mjs"]["shots"]], ["01-open.png"])
        self.assertEqual(runs["broken.mjs"]["status"], "failed")
        self.assertIn("click: no element", res["tail"])
        # a scenario this Mac cannot run is skipped with why, not failed, and not annotated
        self.assertEqual((runs["needs-codex.mjs"]["status"], runs["needs-codex.mjs"]["reason"]), ("skipped", "codex: not signed in"))
        calls = B.read(os.path.join(self.tmp, "dispatch-calls")).splitlines()
        app = os.path.join(self.bdir, NAME, B.APP_NAME)
        runs_called = [c for c in calls if c.startswith("ide e2e run ")]
        self.assertEqual(len(runs_called), 3)
        for c in runs_called:  # each starts its own instance the way its meta asks (--fresh) and stops it
            self.assertIn(f" --fresh --app {app} --instance build-r1 --out ", c)
        self.assertFalse([c for c in calls if c.startswith(("ide instance start", "ide instance stop"))])
        self.assertFalse([c for c in calls if c.startswith("ide e2e annotate") and "needs-codex" in c])


class Attach(Env):
    def result(self, **kw):
        d = os.path.join(self.bdir, NAME)
        os.makedirs(os.path.join(d, "requests", "r1"), exist_ok=True)
        res = {"rid": "r1", "name": NAME, "commit": SHA, "kanban": SHA, "host": "Mac", "dir": d, "log": os.path.join(d, "build.log"),
               "state": "ok", "app": os.path.join(d, B.APP_NAME), "seconds": 250, "commits": {}}
        res.update(kw)
        return res

    def test_a_build_lands_on_the_task_and_task_show_has_it(self):
        board = FakeBoard([issue("task-b1", "Make it", "2026-09-27T10:00:00Z", meta={"deliverables": [
            {"kind": "commit", "ref": "abc1234", "label": "feat: x", "repo": "/r", "at": 1}]})])
        shot = os.path.join(self.bdir, NAME, "requests", "r1", "e2e", "waiting", "00-where-is-what.png")
        res = self.result(e2e={"state": "ok", "runs": [{"scenario": "waiting.mjs", "status": "ok", "shots": ["/x/01.png"], "annotated": shot}]})
        rec = {"rid": "r1", "name": NAME, "host": "mini", "task": "task-b1", "attached": False}
        with patch.object(T, "_sh", board), patch.object(T, "D", None):
            B.attach(rec, res)
            # the same build again (a rebuild, a second request) replaces its entry instead of adding one
            B.attach(dict(rec, attached=False), self.result(state="failed", stage="build", tail="boom", app=""))
            buf = io.StringIO()
            with redirect_stdout(buf):
                T.command(SimpleNamespace(op="show", task="task-b1", json=True, brief=True))
        row = json.loads(buf.getvalue())
        kinds = [d["kind"] for d in row["deliverables"]]
        self.assertEqual(kinds, ["commit", "file", "build"])
        b = row["deliverables"][-1]
        self.assertEqual((b["ref"], b["status"], b["stage"], b["tail"], b["host"]), (NAME, "failed", "build", "boom", "mini"))
        self.assertEqual((b["commit"], b["seconds"]), (SHA, 250))
        self.assertTrue(b["summary"].endswith("requests/r1/result.md") and os.path.exists(b["summary"]))
        self.assertTrue(b["label"].startswith("Build failed: commit aaaaaaa on mini"))
        self.assertEqual(row["deliverables"][1]["ref"], shot)
        self.assertTrue(B.read_json(B.record_path("r1"))["attached"])

    def test_unknown_fields_of_other_kinds_are_still_dropped(self):
        got = T.clean_deliverables([{"kind": "url", "ref": "https://x", "status": "ok"},
                                    {"kind": "build", "ref": NAME, "status": "ok", "e2e": [{"scenario": "a"}], "seconds": 3.7, "junk": 1}])
        self.assertNotIn("status", got[0])
        self.assertEqual(got[1], {"kind": "build", "ref": NAME, "label": "", "status": "ok", "seconds": 3, "e2e": [{"scenario": "a"}]})


def git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True,
                   env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t"))
    return subprocess.run(["git", "-C", cwd, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()


class FromTheMacBook(Env):
    """start on the MacBook: push, ship the service, start on the mini, attach the result when it is in."""
    def repo(self):
        repo = os.path.join(self.tmp, "kanban")
        os.makedirs(os.path.join(repo, "ide"))
        git(repo, "init", "-q", "-b", "main")
        shutil.copy(self.rb, os.path.join(repo, "ide", "remote-build.sh"))
        open(os.path.join(repo, "f"), "w").write("1")
        git(repo, "add", "-A")
        return repo, git(repo, "commit", "-qm", "the change")

    def test_start_on_the_mini_and_attach(self):
        home = self.tmp
        repo, sha = self.repo()
        mini_repo = os.path.join(home, "mini-kanban.git")
        subprocess.run(["git", "init", "-q", "--bare", mini_repo], check=True)
        mini_builds = os.path.join(home, "mini-builds")
        os.environ.update({"DISPATCH_BUILD_SELF": "other", "DISPATCH_BUILD_SSH": script(os.path.join(home, "fake-ssh"), FAKE_SSH),
                           "DISPATCH_MINI": "apple@mini.test", "DISPATCH_MINI_BUILDS_DIR": mini_builds,
                           "DISPATCH_MINI_REPO": mini_repo, "DISPATCH_REPO": repo})
        a = SimpleNamespace(op="start", target="main", kanban="", dev=False, task="task-b1", e2e=[], on=None, min=False, rebuild=False, json=True)
        r = B.do_start(a)
        name = B.build_name(sha)
        self.assertEqual((r["name"], r["host"]), (name, "mini"))
        self.assertEqual(r["notes"], [])
        # the commit is on the mini, never checked out; the service went along
        self.assertEqual(subprocess.run(["git", "-C", mini_repo, "rev-parse", f"refs/builds/{sha}"], capture_output=True, text=True).stdout.strip(), sha)
        self.assertTrue(os.path.exists(os.path.join(mini_builds, ".service", "builds.py")))
        self.bdir = mini_builds
        self.wait_result(name, r["rid"])
        board = FakeBoard([issue("task-b1", "Make it", "2026-09-27T10:00:00Z")])
        rec = B.read_json(B.record_path(r["rid"]))
        self.assertEqual((rec["by"], rec["task"], rec["host"], rec["commit"]), (B.whoami(), "task-b1", "mini", sha))
        with patch.object(T, "_sh", board), patch.object(T, "D", None):
            self.assertTrue(B.settle(rec))
        d = board.issues["task-b1"]["metadata"]["deliverables"][0]
        staged = os.path.join(home, "staging", name)
        self.assertEqual((d["kind"], d["status"], d["host"], d["commit"]), ("build", "ok", "mini", sha))
        self.assertEqual(d["log"], os.path.join(staged, "build.log"))  # the log came along; the app stays until get
        self.assertTrue(os.path.exists(d["log"]))
        self.assertEqual(d["app"], os.path.join(mini_builds, name, B.APP_NAME))
        self.assertIn("dispatch build get", B.read(d["summary"]))
        self.assertIn(f"- commit `{sha[:12]}` the change", B.read(d["summary"]))
        # list from the MacBook shows it with who asked and for which task
        rows = B.all_builds()["rows"]
        mine = [b for b in rows if b["name"] == name]
        self.assertEqual((mine[0]["host"], mine[0]["state"]), ("mini", "ok"))
        self.assertIn("task-b1", B.list_text({"rows": mine, "notes": []}))
        # get copies the app once
        g = B.do_get(SimpleNamespace(target=name[:8], on=None))
        self.assertTrue(g["copied"] and os.path.isdir(g["app"]))
        self.assertFalse(B.do_get(SimpleNamespace(target=name, on=None))["copied"])
        # a copy cut off half way (status came along, the app's files did not): fetched again, not "already here"
        os.remove(os.path.join(staged, "fetched"))
        self.assertTrue(B.do_get(SimpleNamespace(target=name, on=None))["copied"])
        self.assertTrue(os.path.exists(os.path.join(staged, "fetched")))

    def test_a_kanban_ref_is_refused_with_why(self):
        repo, _ = self.repo()
        os.environ.update({"DISPATCH_REPO": repo})
        with self.assertRaisesRegex(ValueError, "takes one commit now"):
            B.do_start(SimpleNamespace(op="start", target="main", kanban="main", dev=False, task="", e2e=[], on="local", min=False, rebuild=False, json=True))

    def test_the_mini_out_of_reach_builds_here(self):
        os.environ.update({"DISPATCH_MINI": "apple@mini.test", "DISPATCH_BUILD_SELF": "other", "DISPATCH_BUILD_SSH": script(os.path.join(self.tmp, "dead-ssh"), "#!/bin/bash\necho 'ssh: connect to host mini port 22: Operation timed out' >&2; exit 255\n")})
        repo, sha = self.repo()
        os.environ.update({"DISPATCH_REPO": repo})
        with patch.object(B, "free_memory_percent", return_value=80):  # this Mac's real memory is not the test's business
            r = B.do_start(SimpleNamespace(op="start", target="", kanban="", dev=False, task="", e2e=[], on=None, min=False, rebuild=False, json=True))
        self.assertEqual(r["host"], "local")
        self.assertIn("the mini is not reachable (ssh: connect to host mini port 22: Operation timed out); building on this Mac instead", r["notes"])
        self.assertEqual(self.wait_result(B.build_name(sha), r["rid"])["state"], "ok")

    def test_without_a_build_mac_it_builds_here_and_asks_no_one(self):
        """No DISPATCH_MINI: no default address, nothing goes over ssh; --on mini says what to set."""
        os.environ.pop("DISPATCH_MINI", None)
        os.environ.pop("DISPATCH_BUILD_SELF", None)
        os.environ.update({"DISPATCH_BUILD_SSH": script(os.path.join(self.tmp, "no-ssh"), "#!/bin/bash\necho asked >&2; exit 99\n")})
        repo, sha = self.repo()
        os.environ.update({"DISPATCH_REPO": repo})
        self.assertEqual((B.has_mini(), B.self_is_mini(), B.this_host_label()), (False, False, "local"))
        with patch.object(B, "free_memory_percent", return_value=80):
            r = B.do_start(SimpleNamespace(op="start", target="", kanban="", dev=False, task="", e2e=[], on=None, min=False, rebuild=False, json=True))
            with self.assertRaisesRegex(ValueError, "DISPATCH_MINI=user@host"):
                B.do_start(SimpleNamespace(op="start", target="", kanban="", dev=False, task="", e2e=[], on="mini", min=False, rebuild=False, json=True))
        self.assertEqual((r["host"], r["notes"]), ("local", []))
        self.assertEqual(self.wait_result(B.build_name(sha), r["rid"])["state"], "ok")
        self.assertEqual([b["host"] for b in B.all_builds()["rows"]], ["local"])

    def test_no_default_repository(self):
        os.environ.pop("DISPATCH_REPO", None)
        os.environ.pop("DISPATCH_MINI_REPO", None)
        with self.assertRaisesRegex(ValueError, "set DISPATCH_REPO"):
            B.kanban_repo()
        with self.assertRaisesRegex(ValueError, "set DISPATCH_MINI_REPO"):
            B.remote_repo()


class Dev(Env):
    """--dev: the request's job holds the dev tree, builds there (remote-build.sh --dev-run) and tests the tree."""
    def test_every_request_builds_and_its_app_is_the_tree(self):
        r = B.host_start(self.bdir, SHA, "r1", {"by": "a"}, self.rb, dev=True)
        name = B.build_name(SHA, dev=True)
        self.assertEqual((r["name"], r["reused"], r["joined"]), (name, False, False))
        res = self.wait_result(name, "r1")
        self.assertEqual((res["state"], res["dev"], res["app"]), ("ok", True, os.path.join(self.bdir, "devtree")))
        self.assertEqual(res["commits"]["commit"]["sha"], SHA)
        self.assertIn("# Development build", B.read(os.path.join(self.bdir, name, "requests", "r1", "result.md")))
        # the same commit again builds again (only what changed, in the tree): the tree may have moved on meanwhile
        B.host_start(self.bdir, SHA, "r2", {"by": "b"}, self.rb, dev=True)
        self.assertEqual(self.wait_result(name, "r2")["state"], "ok")
        self.assertEqual(B.read(os.path.join(self.bdir, "calls")).split("\n")[:2], [f"dev {name}", f"dev {name}"])
        self.assertFalse(os.path.exists(os.path.join(self.bdir, ".dev.lock.name")))  # the tree is free again

    def test_a_failed_development_build(self):
        open(os.path.join(self.bdir, "outcome"), "w").write("failed")
        B.host_start(self.bdir, SHA, "r1", {}, self.rb, dev=True)
        res = self.wait_result(B.build_name(SHA, dev=True), "r1")
        self.assertEqual((res["state"], res["stage"]), ("failed", "build"))
        self.assertIn("dev build", res["tail"])

    def test_waiting_for_the_tree_and_building_in_it(self):
        name = B.build_name(SHA, dev=True)
        self.build_dir(name, pid=self.live())
        self.assertEqual(B.build_state(self.bdir, name)["state"], "queued")
        open(os.path.join(self.bdir, ".dev.lock.name"), "w").write(name + "\n")
        self.assertEqual(B.build_state(self.bdir, name)["state"], "building")

    def test_nothing_to_get(self):
        name = B.build_name(SHA, dev=True)
        with patch.object(B, "find", lambda n, on=None: ("mini", name)):
            with self.assertRaisesRegex(ValueError, "development build"):
                B.do_get(SimpleNamespace(target=name, on=None))

    def test_min_and_dev_do_not_go_together(self):
        with self.assertRaisesRegex(ValueError, "never minified"):
            B.do_start(SimpleNamespace(op="start", target="main", kanban="", dev=True, task="", e2e=[], on="local", min=True, rebuild=False, json=True))


class Install(Env):
    def test_refuses_while_the_installed_copy_runs(self):
        d = self.build_dir(NAME, status="ok 1", app=True)
        B.write_json(os.path.join(d, "signed.json"), {"identity": "Developer ID Application: T", "notarized": True})
        with patch.object(B, "find", lambda n, on=None: ("mini", NAME)), patch.object(B, "running_from", lambda dst: True):
            with self.assertRaises(ValueError) as e:
                B.do_install(SimpleNamespace(target=NAME, on=None, unsigned=False, no_open=True))
        self.assertIn("quit it (⌘Q)", str(e.exception))

    def test_needs_a_signature_first(self):
        self.build_dir(NAME, status="ok 1", app=True)
        with patch.object(B, "find", lambda n, on=None: ("mini", NAME)):
            with self.assertRaises(ValueError) as e:
                B.do_install(SimpleNamespace(target=NAME, on=None, unsigned=False, no_open=True))
        self.assertIn(f"dispatch build sign {NAME}", str(e.exception))

    def test_failed_signing_record_is_not_installable(self):
        d = self.build_dir(NAME, status="ok 1", app=True)
        B.write_json(os.path.join(d, "signed.json"), {"signed": False, "notarized": False})
        with patch.object(B, "find", lambda n, on=None: ("mini", NAME)):
            with self.assertRaisesRegex(ValueError, "not signed yet"):
                B.do_install(SimpleNamespace(target=NAME, on=None, unsigned=False, no_open=True))


class InstallWhenQuit(Env):
    """task-fuqs8: with Dispatch IDE open, the install waits for the person to quit it, then goes in by itself."""

    def test_open_ide_schedules_instead_of_refusing(self):
        d = self.build_dir(NAME, status="ok 1", app=True)
        B.write_json(os.path.join(d, "signed.json"), {"identity": "Developer ID Application: T", "notarized": True})
        spawned = []
        with patch.object(B, "find", lambda n, on=None: ("mini", NAME)), patch.object(B, "running_from", lambda dst: True), \
             patch.object(B.subprocess, "Popen", lambda argv, **kw: spawned.append((argv, kw)) or SimpleNamespace(pid=4242)):
            r = B.do_install(SimpleNamespace(target=NAME, on=None, unsigned=False, no_open=False, when_quit=True))
        self.assertTrue(r["scheduled"])
        self.assertEqual(spawned[0][0][-2:], ["_installwait", NAME])
        self.assertTrue(spawned[0][1]["start_new_session"])  # it outlives the command and the window
        self.assertEqual(B.read_json(B.pending_install_path())["name"], NAME)

    def test_waits_for_the_quit_then_installs(self):
        B.write_json(B.pending_install_path(), {"name": NAME, "pid": 1})
        states = iter([True, True, False])
        installed, notes = [], []
        with patch.object(B, "running_from", lambda dst: next(states)), \
             patch.object(B, "do_install", lambda a: installed.append(a.target) or {"name": a.target, "installed": "/Applications/Dispatch IDE.app"}), \
             patch.object(B, "notify", lambda t, x: notes.append(t)):
            self.assertEqual(B.do_install_wait(NAME, sleep=lambda s: None), 0)
        self.assertEqual(installed, [NAME])
        self.assertEqual(notes, ["Dispatch IDE updated"])
        self.assertFalse(os.path.exists(B.pending_install_path()))

    def test_a_newer_schedule_wins(self):
        B.write_json(B.pending_install_path(), {"name": "newer-build", "pid": 1})
        installed = []
        with patch.object(B, "running_from", lambda dst: False), patch.object(B, "do_install", lambda a: installed.append(a.target)):
            self.assertEqual(B.do_install_wait(NAME, sleep=lambda s: None), 0)
        self.assertEqual(installed, [])


class Sign(Env):
    def setUp(self):
        super().setUp()
        self.ide = os.path.join(self.tmp, "kanban", "ide")
        os.makedirs(self.ide)
        # sign.sh as the service calls it: the app, the identity and DISPATCH_NOTARIZE from the environment
        script(os.path.join(self.ide, "sign.sh"), '''#!/bin/bash
echo "$1|$DISPATCH_SIGNING_IDENTITY|${DISPATCH_NOTARIZE:-0}" >>"$(dirname "$0")/sign-calls"
python3 - <<'PY'
import json, os, pathlib, sys
control = pathlib.Path(os.environ['DISPATCH_REPO']) / 'ide' / 'sign-control.json'
c = json.loads(control.read_text()) if control.exists() else {}
notarize = os.environ['DISPATCH_NOTARIZE'] == '1'
result = c.get('result', {'signed': True, 'status': 'Accepted' if notarize else 'Not requested',
                        'id': 'submission-1' if notarize else '', 'stapled': notarize})
if result is not None:
    pathlib.Path(os.environ['DISPATCH_NOTARY_RESULT']).write_text(json.dumps(result))
sys.exit(c.get('exit', 0))
PY
''')
        os.environ["DISPATCH_REPO"] = os.path.dirname(self.ide)
        script(os.path.join(self.ide, "install.sh"), "#!/bin/bash\nexit 0\n")
        self.d = self.build_dir(NAME, status="ok 1", app=True)
        self.ident = "Developer ID Application: T (X)"

    def sign(self, **kw):
        a = SimpleNamespace(target=NAME, on=None, no_notarize=False, force=False)
        a.__dict__.update(kw)
        return B.do_sign(a)

    def result(self, status="Invalid", rc=0, **kw):
        result = dict(signed=True, status=status, id="submission-2", stapled=False, **kw)
        B.write_json(os.path.join(self.ide, "sign-control.json"), {"result": result, "exit": rc})

    def with_identity(self):
        self.enterContext(patch.object(B, "developer_id", lambda: self.ident))
        self.enterContext(patch.object(B, "signature", lambda app: {"adhoc": False, "authority": self.ident}))

    def test_developer_id_and_notarize_once(self):
        ident = "Developer ID Application: T (X)"
        with patch.object(B, "developer_id", lambda: ident), patch.object(B, "signature", lambda app: {"adhoc": False, "authority": ident}):
            r = self.sign()
            self.assertFalse(r["skipped"])
            self.assertTrue(self.sign()["skipped"])  # signed and notarized: nothing to do
            self.assertFalse(self.sign(force=True)["skipped"])
        app = os.path.join(self.d, B.APP_NAME)
        self.assertEqual(B.read(os.path.join(self.ide, "sign-calls")).splitlines(), [f"{app}|{ident}|1"] * 2)
        self.assertEqual(B.read_json(os.path.join(self.d, "signed.json"))["notarized"], True)

    def test_invalid_is_saved_even_when_sign_script_returns_zero(self):
        self.with_identity()
        self.result(log="/tmp/notary.log.json")
        r = self.sign()
        self.assertIn("not notarized: notarization Invalid, submission submission-2", r["notary_warning"])
        info = B.read_json(os.path.join(self.d, "signed.json"))
        self.assertFalse(info["notarized"])
        self.assertTrue(info["signed"])
        self.assertEqual(info["notary_submission"], "submission-2")
        self.assertEqual(info["notary_log"], "/tmp/notary.log.json")

    def test_failed_resign_replaces_old_accepted_record(self):
        self.with_identity()
        self.sign()
        self.result(rc=1)
        self.assertTrue(self.sign(force=True)["signed"])
        info = B.read_json(os.path.join(self.d, "signed.json"))
        self.assertFalse(info["notarized"])
        self.assertEqual(info["notary_submission"], "submission-2")

    def test_timeout_keeps_submission_and_does_not_claim_success(self):
        """Apple slow: the signature counts (signed true, notarized false), install lets it in with a note."""
        self.with_identity()
        self.result(status="In Progress", rc=0)
        r = self.sign()
        self.assertEqual((r["signed"], r["notarized"]), (True, False))
        self.assertIn("In Progress, submission submission-2", r["notary_warning"])
        self.assertFalse(B.read_json(os.path.join(self.d, "signed.json"))["notarized"])
        self.assertEqual(B.read(os.path.join(self.ide, "sign-calls")).count("|1"), 1)
        self.assertFalse(self.sign()["skipped"])  # the next sign tries notarization again
        installed = []
        with patch.object(B, "find", lambda n, on=None: ("mini", NAME)), patch.object(B, "running_from", lambda dst: False), \
             patch.object(B, "read", lambda path: "DISPATCH_IDE_SRC"), \
             patch.object(B.subprocess, "run", lambda *a, **k: installed.append(a) or SimpleNamespace(returncode=0)):
            done = B.do_install(SimpleNamespace(target=NAME, on=None, unsigned=False, no_open=True))
        self.assertTrue(installed)
        self.assertIn("not notarized", done["note"])

    def test_signing_failure_still_fails(self):
        self.with_identity()
        B.write_json(os.path.join(self.ide, "sign-control.json"), {"result": {"signed": False, "status": "Not submitted"}, "exit": 1})
        with self.assertRaisesRegex(ValueError, "sign.sh exited 1"):
            self.sign()
        self.assertFalse(B.read_json(os.path.join(self.d, "signed.json"))["signed"])

    def test_no_notarize_explicitly_disables_inherited_request(self):
        self.with_identity()
        with patch.dict(os.environ, DISPATCH_NOTARIZE="1", DISPATCH_NOTARIZE_REQUIRED="1"):
            info = self.sign(no_notarize=True)
        self.assertFalse(info["notarized"])
        self.assertTrue(info["signed"])
        self.assertEqual(info["notary_status"], "Not requested")
        self.assertTrue(B.read(os.path.join(self.ide, "sign-calls")).strip().endswith("|0"))
        self.assertTrue(self.sign(no_notarize=True)["skipped"])
        self.assertFalse(self.sign()["skipped"])

    def test_missing_result_cannot_reuse_an_old_ticket(self):
        self.with_identity()
        self.sign()
        B.write_json(os.path.join(self.ide, "sign-control.json"), {"result": None})
        with self.assertRaisesRegex(ValueError, "did not confirm"):
            self.sign(force=True)
        info = B.read_json(os.path.join(self.d, "signed.json"))
        self.assertFalse(info["notarized"])
        self.assertFalse(info["signed"])
        self.assertEqual(info["notary_submission"], "")

    def test_accepted_without_staple_is_recorded_but_must_retry(self):
        self.with_identity()
        self.result(status="Accepted", rc=1)
        self.assertIn("not stapled", self.sign()["notary_warning"])
        info = B.read_json(os.path.join(self.d, "signed.json"))
        self.assertTrue(info["notarized"])
        self.assertFalse(info["stapled"])
        self.assertFalse(self.sign()["skipped"])
        self.assertEqual(len(B.read(os.path.join(self.ide, "sign-calls")).splitlines()), 2)

    def test_old_notarized_boolean_alone_is_not_trusted(self):
        self.with_identity()
        B.write_json(os.path.join(self.d, "signed.json"), {"identity": self.ident, "notarized": True})
        self.assertFalse(self.sign()["skipped"])

    def test_unreadable_signature_is_not_skipped(self):
        self.with_identity()
        self.sign()
        with patch.object(B, "signature", lambda app: {}):
            with self.assertRaisesRegex(ValueError, "did not confirm"):
                self.sign()

    def test_no_certificate_no_signing(self):
        with patch.object(B, "developer_id", lambda: ""), patch.object(B, "signature", lambda app: {"adhoc": True}):
            with self.assertRaises(ValueError) as e:
                self.sign()
        self.assertIn("sign on the MacBook", str(e.exception))
        self.assertFalse(os.path.exists(os.path.join(self.ide, "sign-calls")))


class Cli(unittest.TestCase):
    def test_argparse_reaches_builds(self):
        import dispatch
        seen = {}

        def fake_run(a, d):
            seen.update(op=a.op, target=a.target, dev=a.dev, task=a.task, e2e=a.e2e, on=a.on)
            return 0
        argv = ["dispatch", "build", "start", "mini/build", "--dev", "--task", "task-a1", "--e2e", "a.mjs", "b.mjs", "--on", "local"]
        with patch.object(sys, "argv", argv), patch.object(B, "run", fake_run), self.assertRaises(SystemExit) as e:
            dispatch._main()
        self.assertEqual(e.exception.code, 0)
        self.assertEqual(seen, {"op": "start", "target": "mini/build", "dev": True, "task": "task-a1", "e2e": ["a.mjs", "b.mjs"], "on": "local"})



class TailWithoutColours(unittest.TestCase):
    def test_build_log_tail_drops_terminal_colour_codes(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
            f.write("[00:12:33] Finished \x1b[36mcompile\x1b[39m after \x1b[35m0 ms\x1b[39m\nok\x07\n")
        self.assertEqual(B.tail(f.name), "[00:12:33] Finished compile after 0 ms\nok")
        os.remove(f.name)



class E2eUsesTheBuildsCheckout(unittest.TestCase):
    def test_prefers_the_packaging_checkout_with_the_runner(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"DISPATCH_BIN": ""}):
            cli = os.path.join(d, "work", "dispatch", "app", "cli")
            e2e = os.path.join(d, "work", "dispatch", "app", "scripts", "ide-e2e")
            os.makedirs(cli); os.makedirs(e2e)
            open(os.path.join(cli, "dispatch.py"), "w").close()
            self.assertNotIn(os.path.join(cli, "dispatch.py"), B.dispatch_bin(d))  # no runner yet: the installed one
            open(os.path.join(e2e, "runner.mjs"), "w").close()
            self.assertEqual(B.dispatch_bin(d)[-1], os.path.join(cli, "dispatch.py"))

    def test_uses_the_builds_own_commit_when_work_has_moved_on(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"DISPATCH_BIN": ""}):
            src = os.path.join(d, "work", "dispatch")
            os.makedirs(os.path.join(src, "app", "cli")); os.makedirs(os.path.join(src, "app", "scripts", "ide-e2e"))
            os.makedirs(os.path.join(src, "app", "node_modules"))
            g = ["git", "-C", src, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
            subprocess.run(["git", "init", "-q", src], check=True)
            open(os.path.join(src, "app", "scripts", "ide-e2e", "runner.mjs"), "w").close()
            os.makedirs(os.path.join(src, "agent", "skills", "task-board"))
            open(os.path.join(src, "agent", "skills", "task-board", "SKILL.md"), "w").close()
            subprocess.run(g + ["add", "-A", "agent"], check=True)
            for word in ("built", "later"):
                with open(os.path.join(src, "app", "cli", "dispatch.py"), "w") as f:
                    f.write(word)
                subprocess.run(g + ["add", "-A", "app/cli", "app/scripts"], check=True)
                subprocess.run(g + ["commit", "-qm", word], check=True)
                if word == "built":
                    sha = subprocess.run(["git", "-C", src, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            rd = os.path.join(d, "b", "requests", "r1")
            os.makedirs(rd)
            cli = B.dispatch_bin(d, rd, sha)[-1]
            self.assertEqual(cli, os.path.join(rd, "kanban", "app", "cli", "dispatch.py"))
            with open(cli) as f:
                self.assertEqual(f.read(), "built")
            self.assertTrue(os.path.islink(os.path.join(rd, "kanban", "app", "node_modules")))
            # the skills the CLI ships come along (Customizations' Built-in group lists them)
            self.assertTrue(os.path.exists(os.path.join(rd, "kanban", "agent", "skills", "task-board", "SKILL.md")))


class LocalBuildNeedsFreeMemory(unittest.TestCase):
    def test_refuses_a_local_build_when_memory_is_short(self):
        import argparse
        a = argparse.Namespace(target="main", kanban="", dev=False, e2e=None, task=None, on="local", min=False, rebuild=False)
        with patch.object(B, "resolve", return_value=("a" * 40, None, None)), patch.object(B, "self_is_mini", return_value=False), \
             patch.object(B, "free_memory_percent", return_value=20), patch.dict(os.environ, {"DISPATCH_REPO": "/r", "DISPATCH_MINI": "me@mini"}):
            with self.assertRaises(ValueError) as e:
                B.do_start(a)
            self.assertIn("--on mini", str(e.exception))
            os.environ.pop("DISPATCH_MINI")
            with self.assertRaises(ValueError) as e:
                B.do_start(a)
            self.assertNotIn("--on mini", str(e.exception))

    def test_reads_the_percentage(self):
        fake = subprocess.CompletedProcess([], 0, stdout="The system has 17179869184 (1048576 pages)\nSystem-wide memory free percentage: 63%\n")
        with patch.object(B.subprocess, "run", return_value=fake):
            self.assertEqual(B.free_memory_percent(), 63)



class QueueUnused(unittest.TestCase):
    """A Mac that never used the build service: the bottom bar's queue is empty and nobody is asked (task-20vu)."""

    def test_no_builds_no_records_no_mini_asks_no_one(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DISPATCH_BUILDS_DIR": os.path.join(tmp, "none"),
                                                                       "DISPATCH_BUILD_STATE": os.path.join(tmp, "state")}):
            os.environ.pop("DISPATCH_MINI", None)
            with patch.object(B, "mini_host", side_effect=AssertionError("asked the mini")), \
                    patch.object(B, "all_builds", side_effect=AssertionError("listed builds")):
                self.assertFalse(B.build_service_used())
                q = B.do_queue(argparse.Namespace(on=None))
            self.assertEqual((q["building"], q["waiting"], q["failed"], q["unused"]), ([], [], [], True))
            # a record of a build started here, or the builds folder, or a named mini: the service is in use
            os.makedirs(os.path.join(tmp, "state"))
            open(os.path.join(tmp, "state", "r1.json"), "w").write("{}")
            self.assertTrue(B.build_service_used())
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DISPATCH_BUILDS_DIR": tmp, "DISPATCH_BUILD_STATE": os.path.join(tmp, "s")}):
            self.assertTrue(B.build_service_used())
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DISPATCH_BUILDS_DIR": os.path.join(tmp, "x"), "DISPATCH_BUILD_STATE": os.path.join(tmp, "s"), "DISPATCH_MINI": "me@mini"}):
            self.assertTrue(B.build_service_used())


class QueueSummary(unittest.TestCase):
    """`dispatch build queue`: the bottom bar's view of the queue, from `all_builds()` rows."""
    NOW = 1_800_000_000

    def row(self, name, state, started, host="mini", seconds=None, position=None, task="", ref="", since=None, finished=None, req_state=None, stage=None):
        req = {"task": task, "ref": ref}
        result = {"finished": finished, "state": req_state or ("ok" if state == "ok" else "failed")} if finished else None
        if stage:
            result["stage"] = stage
        rq = {"rid": name, "request": req, "result": result, "state": req_state or (result or {}).get("state") or state}
        b = {"name": name, "host": host, "state": state, "started": started, "seconds": seconds, "position": position, "requests": [rq]}
        if since:
            b["building_since"] = since
        if state == "ok" and seconds:
            b["build_seconds"] = seconds
        return b

    def test_building_waiting_and_order(self):
        n = self.NOW
        rows = [
            self.row("aaaa-1", "queued", n - 600, position=2, task="task-a"),
            self.row("bbbb-1", "queued", n - 900, position=1, ref="gx/bars"),
            self.row("cccc-1", "building", n - 1200, since=n - 300, ref="main"),
            self.row("dddd-1", "ok", n - 5000, seconds=400, finished=n - 4600),
            self.row("eeee-1", "ok", n - 6000, seconds=600, finished=n - 5400),
        ]
        q = B.queue_summary(rows, self.NOW, titles={"task-a": "Bars at the bottom"})
        self.assertEqual([b["label"] for b in q["building"]], ["main"])
        self.assertEqual(q["building"][0]["seconds"], 300)
        self.assertEqual(q["estimate"], 600)  # the median of what built
        self.assertEqual([w["label"] for w in q["waiting"]], ["gx/bars", "Bars at the bottom"])
        self.assertEqual(q["waiting"][1]["task"], "task-a")
        self.assertEqual(q["waiting"][0]["waited"], 900)
        self.assertEqual(q["recent"]["built"], 2)
        self.assertEqual(q["failed"], [])
        self.assertEqual(q["done"], [])

    def test_just_built_and_fresh_failures(self):
        n = self.NOW
        rows = [
            self.row("aaaa-1", "ok", n - 500, seconds=440, finished=n - 30, ref="gx/a"),
            self.row("bbbb-1", "failed", n - 900, seconds=100, ref="gx/b"),
            self.row("cccc-1", "ok", n - 900, seconds=300, finished=n - 400, req_state="failed", stage="e2e", task="task-c"),
            self.row("dddd-1", "failed", n - 4 * 3600, seconds=100, ref="gx/old"),
        ]
        q = B.queue_summary(rows, self.NOW, titles={})
        self.assertEqual([d["label"] for d in q["done"]], ["gx/a"])
        self.assertEqual([(f["label"], f["stage"]) for f in q["failed"]], [("cccc", "checks"), ("gx/b", "build")])
        self.assertEqual(q["recent"], {"built": 1, "failed": 2, "checks_failed": 1})

    def test_a_failure_tried_again_is_not_news(self):
        n = self.NOW
        rows = [
            self.row("aaaa-1", "failed", n - 900, seconds=100, task="task-x"),
            self.row("bbbb-1", "queued", n - 100, position=1, task="task-x"),
        ]
        q = B.queue_summary(rows, self.NOW, titles={"task-x": "X"})
        self.assertEqual(q["failed"], [])
        self.assertEqual([w["label"] for w in q["waiting"]], ["X"])

    def test_nothing(self):
        q = B.queue_summary([], self.NOW)
        self.assertEqual((q["building"], q["waiting"], q["failed"], q["done"]), ([], [], [], []))
        self.assertEqual(q["estimate"], B.QUEUE_DEFAULT_ESTIMATE)
        self.assertIn("Nothing is building", B.queue_text(dict(q, notes=[])))

    def test_agents_test_builds_are_apart_and_never_count_as_yours(self):
        """task-7ve7v: development builds and packages built only for their checks fail quietly, under "agents"."""
        n = self.NOW
        dev_failed = self.row("1111aaaa2222-dev", "failed", n - 900, seconds=40, task="task-d1")
        dev_e2e = self.row("3333bbbb4444-dev", "ok", n - 800, seconds=60, finished=n - 300, req_state="failed", stage="e2e", task="task-d2")
        checks_only = self.row("5555cccc6666", "failed", n - 700, seconds=90, task="task-d3")
        checks_only["requests"][0]["request"]["e2e"] = ["motion.mjs"]
        dev_running = self.row("7777dddd8888-dev", "building", n - 200, since=n - 120, task="task-d4")
        mine = self.row("9999eeeeffff", "failed", n - 600, seconds=300)
        mine["requests"] = []  # dispatch-update: remote-build.sh straight, no request
        mine["dir"] = "/Users/apple/dispatch-builds/9999eeeeffff"
        mine["log"] = "/Users/apple/dispatch-builds/9999eeeeffff/build.log"
        mine["failure"] = {"step": "build", "why": "error TS2322: Type 'x' is not assignable"}
        q = B.queue_summary([dev_failed, dev_e2e, checks_only, dev_running, mine], n, titles={})
        self.assertEqual([f["name"] for f in q["failed"]], ["9999eeeeffff"])
        f = q["failed"][0]
        self.assertEqual((f["kind"], f["step"], f["log"], f["retry"]), ("yours", "build", mine["log"], "dispatch build start 9999eeeeffff --rebuild"))
        self.assertIn("TS2322", f["why"])
        self.assertEqual(q["recent"], {"built": 0, "failed": 1, "checks_failed": 0})
        self.assertEqual(q["building"], [])
        a = q["agents"]
        self.assertEqual(sorted(x["name"] for x in a["failed"]), ["1111aaaa2222-dev", "3333bbbb4444-dev", "5555cccc6666"])
        self.assertTrue(all("retry" not in x and x["kind"] == "agents" for x in a["failed"]))
        self.assertEqual([x["name"] for x in a["building"]], ["7777dddd8888-dev"])
        self.assertEqual(a["recent"]["checks_failed"], 1)
        text = B.queue_text(dict(q, notes=[]))
        self.assertIn("agents' test builds:", text)
        self.assertIn("retry: dispatch build start 9999eeeeffff --rebuild", text)

    def test_a_package_someone_asked_for_without_checks_is_yours(self):
        n = self.NOW
        b = self.row("aaaabbbbcccc-min", "ok", n - 900, seconds=300, finished=n - 400, req_state="failed", stage="e2e")
        b["requests"][0]["request"]["e2e"] = ["first-run.mjs"]
        b["requests"].insert(0, {"rid": "r0", "request": {"ref": "main", "e2e": []}, "result": None, "state": "ok"})
        b["requests"][-1]["result"]["e2e"] = {"log": "/x/e2e.log", "runs": [{"scenario": "first-run.mjs", "status": "failed"}, {"scenario": "bars.mjs", "status": "ok"}]}
        q = B.queue_summary([b], n)
        f = q["failed"][0]
        self.assertEqual((f["stage"], f["step"], f["why"], f["log"], f["retry"]),
                         ("checks", "checks", "first-run.mjs", "/x/e2e.log", "dispatch build start aaaabbbbcccc --rebuild --min"))
        self.assertEqual(B.build_kind({"name": "aaaabbbbcccc", "requests": []}), "yours")
        self.assertEqual(B.retry_command({"name": "aaaabbbbcccc-1111aaaa2222"}), "")

    def test_where_a_failed_build_stopped(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "build.log")
            with open(log, "w") as f:
                f.write("== 9999 on mini: build\ncommit 9999 x\n== checkout\n== ide/build.sh\n\x1b[31mcompiling\x1b[0m\n"
                        "src/a.ts(3,1): error TS2304: Cannot find name 'foo'.\n\n== FAILED: build.sh exited 1 after 4m2s\n")
            self.assertEqual(B.failure_of(log), {"step": "build", "why": "src/a.ts(3,1): error TS2304: Cannot find name 'foo'."})
            with open(log, "w") as f:
                f.write("== 9999 on mini: build\n== checkout\nfatal: not a git repository\n")
            self.assertEqual(B.failure_of(log)["step"], "checkout")
            self.assertEqual(B.failure_of(os.path.join(d, "none.log")), {"step": "start", "why": ""})

    def test_titles_ask_the_board_once_and_survive_its_absence(self):
        with patch.object(B.subprocess, "run", return_value=SimpleNamespace(stdout='noise [{"id": "task-a", "title": "A"}]', returncode=0)) as run:
            self.assertEqual(B.task_titles(["task-a", "task-a", "", "bad id;rm"]), {"task-a": "A"})
            self.assertEqual(run.call_args[0][0], ["bd", "show", "task-a", "--json"])
        with patch.object(B.subprocess, "run", side_effect=OSError("no bd")):
            self.assertEqual(B.task_titles(["task-a"]), {})
        self.assertEqual(B.task_titles([]), {})


class LaunchServicesCopies(unittest.TestCase):
    """10-09: only /Applications' Dispatch IDE.app stays in LaunchServices; a fetched or signed build is forgotten."""

    def test_a_fetched_build_is_unregistered_and_stays_on_disk(self):
        with tempfile.TemporaryDirectory() as d:
            calls = os.path.join(d, "calls")
            ls = os.path.join(d, "lsregister")
            with open(ls, "w") as f:
                f.write(f'#!/bin/sh\necho "$@" >> "{calls}"\nexit 1\n')  # "not registered": still fine
            os.chmod(ls, 0o755)
            app = os.path.join(d, "staging", "aaaabbbbcccc", B.APP_NAME)
            os.makedirs(app)
            with patch.object(B, "LSREGISTER", ls):
                self.assertTrue(B.forget_app(app))
                self.assertFalse(B.forget_app(os.path.join(d, "gone.app")))
                with patch.object(B, "get_build", return_value={"name": "aaaabbbbcccc", "app": app}):
                    self.assertEqual(B.do_get(SimpleNamespace(target="aaaabbbbcccc", on=None))["app"], app)
            self.assertEqual(open(calls).read().splitlines(), [f"-u {app}", f"-u {app}"])
            self.assertTrue(os.path.isdir(app))
        self.assertFalse(B.forget_app("/Applications"))  # no lsregister in tests: nothing asked


class StagingIsPruned(unittest.TestCase):
    def test_keeps_the_newest_and_signed_and_drops_old_apps_only(self):
        import tempfile, time
        with tempfile.TemporaryDirectory() as d, patch.object(B, "staging_dir", return_value=d):
            for i in range(5):
                os.makedirs(os.path.join(d, f"b{i}", B.APP_NAME))
                open(os.path.join(d, f"b{i}", "build.log"), "w").close()
                t = time.time() - 100 + i
                os.utime(os.path.join(d, f"b{i}"), (t, t))
            open(os.path.join(d, "b0", "signed.json"), "w").close()
            os.utime(os.path.join(d, "b0"), (time.time() - 100, time.time() - 100))
            gone = B.prune_staging(keep="b1", limit=2)
            self.assertEqual(sorted(gone), ["b2"])
            self.assertFalse(os.path.exists(os.path.join(d, "b2", B.APP_NAME)))
            self.assertTrue(os.path.exists(os.path.join(d, "b2", "build.log")))
            for n in ("b0", "b1", "b3", "b4"):
                self.assertTrue(os.path.exists(os.path.join(d, n, B.APP_NAME)))


if __name__ == "__main__":
    unittest.main()


class FindByName(unittest.TestCase):
    """`dispatch build sign <commit>` after a development build of the same commit (task-7mmi3): the full package."""

    def test_the_full_package_wins_over_a_newer_development_build(self):
        recs = [{"rid": "1", "name": "6d02573ff7fa", "host": "mini", "created": 1},
                {"rid": "2", "name": "6d02573ff7fa-dev", "host": "mini", "created": 2}]
        with patch.object(B, "records", return_value=recs):
            self.assertEqual(B.find("6d02573ff7fa"), ("mini", "6d02573ff7fa"))
            self.assertEqual(B.find("6d02573ff7fa-dev"), ("mini", "6d02573ff7fa-dev"))
            self.assertEqual(B.find("6d02573"), ("mini", "6d02573ff7fa-dev"))
