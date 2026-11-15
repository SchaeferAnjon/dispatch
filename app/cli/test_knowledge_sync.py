# -*- coding: utf-8 -*-
"""knowledge_sync.py: the user's knowledge in ~/.dispatch, committed after writes and pulled from the
other Macs. Two Macs are two temp folders; the other Mac's repository is reached by path."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dispatch as D  # noqa: E402
import doctor  # noqa: E402
import knowledge_sync as K  # noqa: E402

WINDOWS_READY = False


def write(root, rel, text, mode="w"):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode, encoding=None if "b" in mode else "utf-8") as f:
        f.write(text)
    return p


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


class Mac:
    """One Mac: its ~/.dispatch and its runtime folder; `with mac:` makes it the current one."""

    def __init__(self, base, name):
        self.name = name
        self.home = os.path.join(base, name, ".dispatch")
        self.run = os.path.join(base, name, "run")
        os.makedirs(self.home)
        os.makedirs(self.run)
        self.peers = []

    def __enter__(self):
        self._env = mock.patch.dict(os.environ, {"DISPATCH_HOME": self.home, "DISPATCH_DIR": self.run})
        self._env.start()
        self._host = mock.patch.object(K, "host_name", lambda: self.name)
        self._host.start()
        self._peers = mock.patch.object(K, "peers", lambda: list(self.peers))
        self._peers.start()
        return self

    def __exit__(self, *exc):
        self._peers.stop()
        self._host.stop()
        self._env.stop()

    def entry(self):
        return {"id": self.name, "name": self.name, "ssh": f"u@{self.name}", "knowledge_url": os.path.join(self.home, K.GIT_DIR_NAME)}

    def git(self, *args):
        with self:
            return K.git(*args).stdout

    def tracked(self):
        return sorted(p for p in self.git("ls-files", "-z").split("\0") if p)

    def notes(self):
        d = os.path.join(self.run, "notifications")
        try:
            return [json.load(open(os.path.join(d, n))) for n in sorted(os.listdir(d)) if n.endswith(".json")]
        except OSError:
            return []

    def commit(self):
        with self:
            return K.commit_now("test")

    def sync(self, **kw):
        with self:
            return K.sync_all(after_rules=kw.get("after_rules", lambda: None))


class Base(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="dtest-know-")
        self.addCleanup(shutil.rmtree, self.base, True)
        self.a = Mac(self.base, "macbook")
        self.b = Mac(self.base, "mini")
        self.a.peers = [self.b.entry()]
        self.b.peers = [self.a.entry()]

    def seed(self, mac):
        with mac:
            K.ensure_repo()


class Whitelist(Base):
    def test_only_the_knowledge_is_tracked(self):
        h = self.a.home
        for rel in ("preferences.jsonl", "preferences/evidence/pref-1/shot.png", "wiki/pit-x.md", "rules/GLOBAL.md", "rules/FACTS.md",
                    "rules/PROFILE.md", "rules/artifact.md", "skills/demo/SKILL.md", "skills/demo/run.py", "agents/designer.md",
                    # never tracked:
                    "rules/dispatch.md", "rules/FACTS.md.hub.bak", "rules/PROFILE.md.bak-20260928", "state/builds/x.json", "chats/c1/notes.md",
                    "backups/preferences/1.jsonl", "machine-id", "config.json", "README.md", "preferences/imports.json",
                    "preferences/pending-import.json", "preferences/.lock", "skills/.DS_Store", "skills/demo/__pycache__/run.cpython-39.pyc",
                    "ssh/config", "skills/demo/node_modules/x/index.js", "rules/FACTS.md.conflict-mini"):
            write(h, rel, "x\n")
        with self.a:
            K.commit_now("test")
        self.assertEqual(self.a.tracked(), ["agents/designer.md", "preferences.jsonl", "preferences/evidence/pref-1/shot.png",
                                            "rules/FACTS.md", "rules/GLOBAL.md", "rules/PROFILE.md", "rules/artifact.md",
                                            "skills/demo/SKILL.md", "skills/demo/run.py", "wiki/pit-x.md"])
        # nothing git-shaped inside ~/.dispatch but the hidden git dir, so no tool mistakes it for a project
        self.assertFalse(os.path.exists(os.path.join(h, ".git")))
        self.assertFalse(os.path.exists(os.path.join(h, ".gitignore")))
        chat = os.path.join(h, "chats", "c1")
        r = subprocess.run(["git", "-C", chat, "rev-parse", "--git-dir"], capture_output=True, text=True,
                           env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")})
        self.assertNotEqual(r.returncode, 0, "a chat folder must not be inside a repository")

    def test_links_out_of_the_pool_are_listed_not_tracked(self):
        outside = os.path.join(self.base, "kanban", "agent", "skills", "task-board")
        write(outside, "SKILL.md", "task board\n")
        os.makedirs(os.path.join(self.a.home, "skills"))
        os.symlink(outside, os.path.join(self.a.home, "skills", "task-board"))
        nested = os.path.join(self.a.home, "skills", "course")
        write(nested, "SKILL.md", "course\n")
        subprocess.run(["git", "init", "-q", nested], check=True)
        subprocess.run(["git", "-C", nested, "remote", "add", "origin", "https://github.com/x/course.git"], check=True)
        write(self.a.home, "skills/own/SKILL.md", "own\n")
        os.symlink("SKILL.md", os.path.join(self.a.home, "skills", "own", "README.md"))  # inside the pool: tracked as a link
        with self.a:
            K.commit_now("test")
        self.assertEqual(self.a.tracked(), ["skills/.dispatch-links.json", "skills/own/README.md", "skills/own/SKILL.md"])
        m = json.loads(read(self.a.home, "skills/.dispatch-links.json"))
        self.assertEqual(m["course"], {"repo": "https://github.com/x/course.git"})
        self.assertEqual(os.path.expanduser(m["task-board"]["link"]) if m["task-board"]["link"].startswith("~") else m["task-board"]["link"], outside)
        # the other Mac makes the link where the target exists (clones stay off in a test)
        self.seed(self.b)
        with mock.patch.object(K, "apply_links_manifest", lambda clone=True, _f=K.apply_links_manifest: _f(clone=False)):
            self.b.sync()
        self.assertTrue(os.path.islink(os.path.join(self.b.home, "skills", "task-board")))
        self.assertEqual(os.path.realpath(os.path.join(self.b.home, "skills", "task-board")), os.path.realpath(outside))
        self.assertFalse(os.path.exists(os.path.join(self.b.home, "skills", "course")))
        self.assertEqual(read(self.b.home, "skills/own/SKILL.md"), "own\n")


class Commits(Base):
    def test_writes_close_together_become_one_commit_with_commands_and_mac(self):
        spawned = []
        with self.a:
            K.ensure_repo()
            write(self.a.home, "preferences.jsonl", '{"id":"pref-1","text":"square toggles"}\n')
            self.assertTrue(K.schedule_commit("dispatch prefs add", spawn=lambda args: spawned.append(args) or types.SimpleNamespace(pid=os.getpid()), now=100))
            write(self.a.home, "wiki/pit-a.md", "【坑】a\n")
            self.assertFalse(K.schedule_commit("dispatch wiki add", spawn=lambda args: spawned.append(args), now=102))
            self.assertEqual(spawned, [["knowledge", "commit", "--settle", str(K.SETTLE)]])
            clock = iter([103, 107.5, 108])
            slept = []
            sha = K.settle_and_commit(settle=5, sleep=slept.append, clock=lambda: next(clock))
            self.assertTrue(sha)
            self.assertEqual(len(slept), 1)
            msg = K.git("log", "-1", "--format=%B").stdout
            self.assertIn("dispatch prefs add; dispatch wiki add (on macbook)", msg)
            self.assertIn("Mac: macbook", msg)
            self.assertEqual(K.git("log", "--format=%s").stdout.count("\n"), 2)   # start + this one
            self.assertFalse(os.path.exists(K.pending_path()))
            self.assertEqual(K.commit_now("again"), "")  # nothing changed: no empty commit

    def test_only_writing_commands_schedule(self):
        calls = []
        with self.a, mock.patch.object(K, "schedule_commit", lambda why, **kw: calls.append(why) or True), \
                mock.patch.dict(os.environ, {"DISPATCH_KNOWLEDGE_AUTOCOMMIT": "1"}):
            ns = types.SimpleNamespace
            self.assertFalse(K.after_command(["wiki", "search", "x"], ns(cmd="wiki", op="list")))
            self.assertFalse(K.after_command(["prefs", "list"], ns(cmd="prefs", op="list")))
            self.assertFalse(K.after_command(["task", "show"], ns(cmd="task", op="show")))
            self.assertFalse(K.after_command(["done", "t"], ns(cmd="done", retro=None)))
            self.assertTrue(K.after_command(["prefs", "add"], ns(cmd="prefs", op="add")))
            self.assertTrue(K.after_command(["wiki", "migrate"], ns(cmd="wiki", op="migrate")))
            self.assertTrue(K.after_command(["done", "t"], ns(cmd="done", retro="went fine")))
            self.assertTrue(K.after_command(["facts", "write"], ns(cmd="facts", op="write")))
        self.assertEqual(calls, ["dispatch prefs add", "dispatch wiki migrate", "dispatch done", "dispatch facts write"])
        with mock.patch.dict(os.environ, {"DISPATCH_KNOWLEDGE_AUTOCOMMIT": "0"}):
            self.assertFalse(K.after_command(["prefs", "add"], types.SimpleNamespace(cmd="prefs", op="add")))


FACTS = "# Facts\n\n## Machines\n- MacBook: M3\n- mini: M4\n\n## Accounts\n- GitHub: me\n- Apple: me\n"


class TwoMacs(Base):
    def start_both(self):
        """B starts from A's knowledge (the normal case after the first contact)."""
        write(self.a.home, "rules/FACTS.md", FACTS)
        write(self.a.home, "preferences.jsonl", '{"id":"pref-1","text":"square toggles","used":1}\n')
        with self.a:
            K.commit_now("seed")
        self.seed(self.b)
        self.b.sync()
        self.assertEqual(read(self.b.home, "rules/FACTS.md"), FACTS)

    def same(self):
        self.assertEqual(self.a.git("rev-parse", "HEAD^{tree}"), self.b.git("rev-parse", "HEAD^{tree}"))

    def test_different_edits_on_both_macs_end_up_on_both(self):
        self.start_both()
        # A: a preference; B: a wiki entry; both: FACTS.md, different lines
        write(self.a.home, "preferences.jsonl", '{"id":"pref-2","text":"no dashes"}\n', "a")
        write(self.a.home, "rules/FACTS.md", FACTS.replace("- MacBook: M3", "- MacBook: M3 Pro"))
        write(self.b.home, "wiki/pit-ssh.md", "【坑】ssh hangs 【解法】BatchMode\n")
        write(self.b.home, "rules/FACTS.md", FACTS.replace("- Apple: me", "- Apple: me@icloud"))
        self.a.sync()
        self.b.sync()
        self.a.sync()
        self.same()
        for mac in (self.a, self.b):
            facts = read(mac.home, "rules/FACTS.md")
            self.assertIn("- MacBook: M3 Pro\n", facts)
            self.assertIn("- Apple: me@icloud\n", facts)
            self.assertNotIn("- MacBook: M3\n", facts)
            self.assertEqual(read(mac.home, "wiki/pit-ssh.md"), "【坑】ssh hangs 【解法】BatchMode\n")
            ids = [json.loads(l)["id"] for l in read(mac.home, "preferences.jsonl").splitlines()]
            self.assertEqual(ids, ["pref-1", "pref-2"])
            self.assertEqual(mac.notes(), [])
        st = json.load(open(os.path.join(self.a.run, "knowledge-sync.json")))
        self.assertTrue(st["hosts"]["mini"]["last_ok"])

    def test_same_line_changed_on_both_keeps_both_and_notifies(self):
        self.start_both()
        write(self.a.home, "rules/FACTS.md", FACTS.replace("- mini: M4", "- mini: M4 Pro, 64 GB"))
        write(self.b.home, "rules/FACTS.md", FACTS.replace("- mini: M4", "- mini: M4, builds only"))
        self.b.commit()
        rows = self.a.sync()
        self.assertEqual([c["path"] for c in rows[0]["conflicts"]], ["rules/FACTS.md"])
        self.b.sync()
        self.a.sync()
        self.same()
        for mac in (self.a, self.b):
            facts = read(mac.home, "rules/FACTS.md")
            self.assertIn("- mini: M4 Pro, 64 GB\n", facts)
            self.assertIn("- mini: M4, builds only\n", facts)
            self.assertNotIn("<<<<<<<", facts)
            notes = mac.notes()
            self.assertEqual(len(notes), 1, mac.name)
            self.assertEqual(notes[0]["event"], "knowledge")
            self.assertIn("rules/FACTS.md", notes[0]["text"])
        # the notification reads like the other ones (wake.render), without a task
        import wake
        text, _ = wake.render(self.a.notes())
        self.assertIn("Knowledge sync with mini", text)
        self.assertNotIn("无任务", text)

    def test_a_file_that_cannot_be_merged_keeps_both_versions(self):
        write(self.a.home, "skills/demo/icon.png", b"\x89PNG-base\x00", "wb")
        with self.a:
            K.commit_now("seed")
        self.seed(self.b)
        self.b.sync()
        write(self.a.home, "skills/demo/icon.png", b"\x89PNG-from-a\x00", "wb")
        write(self.b.home, "skills/demo/icon.png", b"\x89PNG-from-b\x00", "wb")
        self.b.commit()
        rows = self.a.sync()
        self.assertEqual(rows[0]["conflicts"][0]["path"], "skills/demo/icon.png")
        with open(os.path.join(self.a.home, "skills/demo/icon.png"), "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG-from-a\x00")
        with open(os.path.join(self.a.home, "skills/demo/icon.png.conflict-mini"), "rb") as f:
            self.assertEqual(f.read(), b"\x89PNG-from-b\x00")
        self.assertEqual(len(self.a.notes()), 1)
        self.assertNotIn("skills/demo/icon.png.conflict-mini", self.a.tracked())

    def test_preferences_merge_entry_by_entry(self):
        self.start_both()
        base = {"id": "pref-1", "text": "square toggles", "used": 1}
        a = dict(base, used=3, last_used="2026-09-29T10:00:00+02:00", history=[{"at": "2026-09-29T10:00:00+02:00", "event": "used"}])
        b = dict(base, used=2, last_used="2026-09-29T11:00:00+02:00", history=[{"at": "2026-09-29T11:00:00+02:00", "event": "used"}])
        write(self.a.home, "preferences.jsonl", json.dumps(a) + "\n")
        write(self.b.home, "preferences.jsonl", json.dumps(b) + "\n")
        self.b.commit()
        rows = self.a.sync()
        self.assertEqual(rows[0]["conflicts"], [])
        e = json.loads(read(self.a.home, "preferences.jsonl"))
        self.assertEqual(e["used"], 4)   # 1 + 2 here + 1 there
        self.assertEqual(e["last_used"], "2026-09-29T11:00:00+02:00")
        self.assertEqual(len(e["history"]), 2)
        # the sentence itself changed on both: a real conflict, the later edit wins, a notification
        self.b.sync()
        write(self.a.home, "preferences.jsonl", json.dumps(dict(e, text="square toggles, 4px radius", history=e["history"] + [{"at": "2026-09-29T12:00:00+02:00", "event": "edit"}])) + "\n")
        write(self.b.home, "preferences.jsonl", json.dumps(dict(e, text="square toggles, no radius", history=e["history"] + [{"at": "2026-09-29T13:00:00+02:00", "event": "edit"}])) + "\n")
        self.b.commit()
        rows = self.a.sync()
        self.assertEqual(rows[0]["conflicts"][0]["path"], "preferences.jsonl")
        self.assertIn("pref-1 (text)", rows[0]["conflicts"][0]["detail"])
        e = json.loads(read(self.a.home, "preferences.jsonl"))
        self.assertEqual(e["text"], "square toggles, no radius")
        self.assertEqual(len(read(self.a.home, "preferences.jsonl").splitlines()), 1)

    def test_offline_mac_is_skipped_and_others_still_sync(self):
        self.start_both()
        gone = {"id": "old", "name": "old", "ssh": "u@old", "knowledge_url": os.path.join(self.base, "nowhere", K.GIT_DIR_NAME)}
        self.a.peers = [gone, self.b.entry()]
        write(self.b.home, "agents/new.md", "a sub-agent\n")
        self.b.commit()
        rows = self.a.sync()
        self.assertTrue(rows[0]["skipped"])
        self.assertTrue(rows[1]["ok"])
        self.assertEqual(read(self.a.home, "agents/new.md"), "a sub-agent\n")
        st = json.load(open(os.path.join(self.a.run, "knowledge-sync.json")))
        self.assertNotIn("last_ok", st["hosts"]["old"])
        self.assertTrue(st["hosts"]["old"]["error"])
        self.assertTrue(st["hosts"]["mini"]["last_ok"])

    def test_first_contact_without_shared_history_is_one_union(self):
        write(self.a.home, "rules/GLOBAL.md", "# Rules\n- short sentences\n")
        write(self.a.home, "wiki/pit-a.md", "【坑】a\n")
        write(self.b.home, "rules/GLOBAL.md", "# Rules\n- no dashes\n")
        write(self.b.home, "skills/b/SKILL.md", "b\n")
        for m in (self.a, self.b):
            with m:
                K.commit_now("own")
        refreshed = []
        self.a.sync(after_rules=lambda: refreshed.append(1))
        g = read(self.a.home, "rules/GLOBAL.md")
        self.assertIn("- short sentences", g)
        self.assertIn("- no dashes", g)
        self.assertEqual(read(self.a.home, "skills/b/SKILL.md"), "b\n")
        self.assertEqual(refreshed, [1])  # GLOBAL.md changed: the agents' pasted copies are refreshed
        self.b.sync()
        self.same()

    def test_new_mac_with_nothing_takes_everything(self):
        self.start_both()
        self.assertEqual(self.b.tracked(), self.a.tracked())
        self.assertEqual(self.b.notes(), [])


class Wiki(unittest.TestCase):
    """The wiki moves from the board's memories to ~/.dispatch/wiki, one file an entry."""
    BOARD = {"schema_version": "1", "pit-ssh-hangs": "【坑】ssh hangs 【解法】BatchMode #project:kanban",
             "win-short": "【做对】short replies 【为什么】read faster", "plain-note": "a plain memory",
             "dispatch-settings": "{\"x\": 1}", "dispatch-docs-kanban": "[]"}

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dtest-wiki-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.board = dict(self.BOARD)
        self.calls = []
        env = mock.patch.dict(os.environ, {"DISPATCH_HOME": os.path.join(self.tmp, ".dispatch")})
        env.start()
        self.addCleanup(env.stop)
        sh = mock.patch.object(D, "sh", self.fake_sh)
        sh.start()
        self.addCleanup(sh.stop)
        dates = mock.patch.object(D, "WIKI_DATES_FILE", os.path.join(self.tmp, "wiki-dates.json"))
        dates.start()
        self.addCleanup(dates.stop)

    def fake_sh(self, args, **kw):
        self.calls.append(args)
        if args[:2] == ["bd", "memories"]:
            return 0, json.dumps(self.board), ""
        if args[:2] == ["bd", "remember"]:
            self.board[args[args.index("--key") + 1]] = args[2]
            return 0, "", ""
        if args[:2] == ["bd", "sql"]:
            return 0, json.dumps([{"key": "kv.memory.pit-ssh-hangs", "d": "2026-09-20T10:00:00Z"}]), ""
        return 1, "", "unexpected"

    def test_migrate_keeps_every_entry_the_same_and_leaves_the_board_alone(self):
        before = sorted(D.wiki_all(), key=lambda it: it["key"])
        self.assertFalse(D.wiki_files_on())
        r = D.wiki_migrate()
        self.assertEqual((r["copied"], r["total"]), (3, 3))
        after = sorted(D.wiki_all(), key=lambda it: it["key"])
        self.assertEqual(after, before)
        self.assertEqual(sorted(os.listdir(D.wiki_dir())), ["pit-ssh-hangs.md", "plain-note.md", "win-short.md"])
        with open(os.path.join(D.wiki_dir(), "pit-ssh-hangs.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), self.BOARD["pit-ssh-hangs"] + "\n")
        self.assertEqual(self.board, self.BOARD)           # nothing forgotten in the board
        self.assertFalse(any(c[:2] == ["bd", "forget"] for c in self.calls))
        self.assertEqual(D.wiki_dates(["pit-ssh-hangs"])["pit-ssh-hangs"], "2026-09-20T10:00:00Z")
        # again: nothing copied twice, a file changed since wins
        with open(os.path.join(D.wiki_dir(), "win-short.md"), "w", encoding="utf-8") as f:
            f.write("【做对】edited here\n")
        self.assertEqual(D.wiki_migrate()["copied"], 0)
        self.assertEqual(D.wiki_find(D.wiki_all(), "win-short")["text"], "edited here")

    def test_writes_go_to_files_and_bookkeeping_stays_in_the_board(self):
        D.wiki_store("pit-new", "【坑】new")            # first write migrates first
        self.assertTrue(os.path.exists(os.path.join(D.wiki_dir(), "pit-ssh-hangs.md")))
        self.assertTrue(os.path.exists(os.path.join(D.wiki_dir(), "pit-new.md")))
        self.assertNotIn("pit-new", self.board)
        D.wiki_store("dispatch-settings", "{\"x\": 2}")
        self.assertEqual(self.board["dispatch-settings"], "{\"x\": 2}")
        self.assertFalse(os.path.exists(D.wiki_file("dispatch-settings")))
        keys = {it["key"] for it in D.wiki_all()}
        self.assertEqual(keys, {"pit-ssh-hangs", "win-short", "plain-note", "pit-new"})

    def test_cli_add_edit_rm_and_migrate(self):
        base = dict(text=None, body=None, kind=None, semantic=False, limit=8, fix=None, why=None, tech=None, good=None, bad=None,
                    project=None, task=None, key=None, all=False, dated=False, json=True)
        out = []
        with mock.patch("builtins.print", lambda *a, **k: out.append(a[0] if a else "")):
            D.cmd_wiki(types.SimpleNamespace(**dict(base, op="migrate")))
            D.cmd_wiki(types.SimpleNamespace(**dict(base, op="add", text="dolt port busy", fix="restart")))
            D.cmd_wiki(types.SimpleNamespace(**dict(base, op="edit", text="pit-dolt-port-busy", fix="bd dolt start")))
            D.cmd_wiki(types.SimpleNamespace(**dict(base, op="rm", text="plain-note")))
        self.assertEqual(json.loads(out[0])["copied"], 3)
        with open(D.wiki_file("pit-dolt-port-busy"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "【坑】dolt port busy 【解法】bd dolt start\n")
        self.assertFalse(os.path.exists(D.wiki_file("plain-note")))
        self.assertIn("plain-note", self.board)   # the board's old copy stays

    def test_keys_with_odd_characters_round_trip(self):
        D.wiki_store("pit-a/b c", "【坑】odd")
        self.assertTrue(os.path.basename(D.wiki_file("pit-a/b c")).startswith("pit-a%2Fb%20c"))
        self.assertIn("pit-a/b c", {it["key"] for it in D.wiki_all()})


class Doctor(unittest.TestCase):
    def ctx(self, hosts, state, now=10 * 86400):
        tmp = tempfile.mkdtemp(prefix="dtest-kdoc-")
        self.addCleanup(shutil.rmtree, tmp, True)
        with open(os.path.join(tmp, "knowledge-sync.json"), "w") as f:
            json.dump({"hosts": state}, f)
        c = doctor.Ctx(home=tmp, dispatch_dir=tmp, clock=lambda: now)
        c.hosts = lambda: hosts
        return c

    def test_one_mac_is_fine(self):
        r = doctor.check_knowledge(self.ctx([], {}))
        self.assertEqual((r[0]["name"], r[0]["status"]), ("knowledge.sync", "ok"))

    def test_recent_ok_old_warns_never_warns(self):
        now = 10 * 86400
        r = doctor.check_knowledge(self.ctx([{"id": "mini", "name": "mini"}], {"mini": {"last_ok": now - 600}}, now))
        self.assertEqual(r[0]["status"], "ok")
        self.assertIn("mini: synced 10 min ago", r[0]["message"])
        r = doctor.check_knowledge(self.ctx([{"id": "mini", "name": "mini"}], {"mini": {"last_ok": now - 2 * 86400, "error": "no answer (offline?)"}}, now))
        self.assertEqual(r[0]["status"], "warn")
        self.assertIn("48 h ago", r[0]["message"])
        self.assertIn("offline", r[0]["message"])
        r = doctor.check_knowledge(self.ctx([{"id": "mini", "name": "mini"}], {}, now))
        self.assertEqual(r[0]["status"], "warn")
        self.assertIn("never synced", r[0]["message"])

    def test_is_part_of_the_run(self):
        self.assertIn("knowledge", [g for g, _ in doctor.GROUPS])


if __name__ == "__main__":
    unittest.main()
