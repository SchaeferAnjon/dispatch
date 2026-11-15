"""`dispatch env` remembers each change (env_changes.py): Undo puts back exactly what was there, the events file the
IDE's "Key saved" toast reads carries no value, and the agent that saved a key is told what to call it."""
import contextlib
import glob
import io
import json
import os
import tempfile
import types
import unittest
from unittest import mock

import dispatch
import env_changes as C

FAKE = "fake-test-value-0123456789"
FAKE2 = "fake-test-value-second-987"


def ns(op, name=None, value=None, **kw):
    base = dict(op=op, name=name, value=value, note=None, project=None, stdin=False, fish=False, json=True, by="settings")
    base.update(kw)
    return types.SimpleNamespace(**base)


class EnvChanges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dhome = os.path.join(self.tmp, "dhome")
        env = mock.patch.dict(os.environ, {"DISPATCH_HOME": self.dhome})
        env.start()
        self.addCleanup(env.stop)
        d = os.path.join(self.tmp, "config")
        for name, value in (("ENV_DIR", d), ("ENV_FILE", os.path.join(d, "env")), ("ENV_FISH", os.path.join(d, "env.fish")), ("ENV_SH", os.path.join(d, "env.sh"))):
            p = mock.patch.object(dispatch, name, value)
            p.start()
            self.addCleanup(p.stop)

    def run_env(self, *args, **kw):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), mock.patch("sys.stdin", io.StringIO("")):
            dispatch.cmd_env(ns(*args, **kw))
        return json.loads(buf.getvalue())

    def events(self):
        with open(C.events_path(), encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()]

    def store(self):
        return {it["name"]: it for it in dispatch.env_read()}

    def test_set_tells_the_agent_what_to_call_it_and_the_event_has_no_value(self):
        r = self.run_env("set", "FAKE_DEMO_KEY", FAKE, note="Demo service")
        self.assertTrue(r["ok"] and r["created"])
        self.assertIn("FAKE_DEMO_KEY", r["say"])
        self.assertIn("Demo service", r["say"])
        self.assertIn("Key saved: FAKE_DEMO_KEY", r["say"])
        self.assertNotIn(FAKE, json.dumps(r))
        ev = self.events()[-1]
        self.assertEqual((ev["op"], ev["name"], ev["note"], ev["by"], ev["created"], ev["id"]), ("set", "FAKE_DEMO_KEY", "Demo service", "settings", True, r["change"]))
        with open(C.events_path(), encoding="utf-8") as f:
            self.assertNotIn(FAKE, f.read())
        if os.name != "nt":
            self.assertEqual(os.stat(C.events_path()).st_mode & 0o777, 0o600)
            rec = glob.glob(os.path.join(self.dhome, "backups", "*", "env-changes", r["change"] + ".json"))[0]
            self.assertEqual(os.stat(rec).st_mode & 0o777, 0o600)

    def test_undo_a_new_key_removes_it_and_a_changed_one_gets_its_old_value(self):
        new = self.run_env("set", "FAKE_A", FAKE, note="A")
        changed = self.run_env("set", "FAKE_A", FAKE2, note="A, renewed")
        self.assertFalse(changed["created"])
        self.assertEqual(self.store()["FAKE_A"]["value"], FAKE2)
        self.assertEqual(self.run_env("undo", changed["change"])["restored"], "value")
        self.assertEqual((self.store()["FAKE_A"]["value"], self.store()["FAKE_A"]["note"]), (FAKE, "A"))
        self.assertEqual(self.run_env("undo", new["change"])["restored"], "removed")
        self.assertNotIn("FAKE_A", self.store())
        again = self.run_env("undo", new["change"])
        self.assertFalse(again["ok"])
        self.assertIn("already undone", again["error"])

    def test_undo_never_overwrites_a_newer_value(self):
        first = self.run_env("set", "FAKE_B", FAKE)
        self.run_env("set", "FAKE_B", FAKE2)
        r = self.run_env("undo", first["change"])
        self.assertFalse(r["ok"])
        self.assertIn("changed again since", r["error"])
        self.assertEqual(self.store()["FAKE_B"]["value"], FAKE2)

    def test_purpose_only_edit_keeps_the_value(self):
        self.run_env("set", "FAKE_C", FAKE, note="old purpose", project="")
        r = self.run_env("set", "FAKE_C", None, note="new purpose", project="kanban")
        self.assertTrue(r["changed"])
        it = self.store()["FAKE_C"]
        self.assertEqual((it["value"], it["note"], it["project"]), (FAKE, "new purpose", "kanban"))
        self.assertEqual(self.events()[-1]["op"], "edit")
        self.run_env("undo", r["change"])
        it = self.store()["FAKE_C"]
        self.assertEqual((it["value"], it["note"], it["project"]), (FAKE, "old purpose", ""))
        same = self.run_env("set", "FAKE_C", None, note="old purpose")
        self.assertFalse(same["changed"])

    def test_unset_keeps_a_copy_and_undo_puts_it_back_in_its_place(self):
        for n in ("FAKE_1", "FAKE_2", "FAKE_3"):
            self.run_env("set", n, FAKE + n, note=n.lower())
        gone = self.run_env("unset", "FAKE_2")
        self.assertEqual(list(self.store()), ["FAKE_1", "FAKE_3"])
        kept = glob.glob(os.path.join(self.dhome, "backups", "*", "**", "env"), recursive=True)
        self.assertTrue(kept, "the store before the delete is kept in ~/.dispatch/backups/<date>/")
        self.assertEqual(self.events()[-1]["op"], "unset")
        self.run_env("undo", gone["change"])
        self.assertEqual(list(self.store()), ["FAKE_1", "FAKE_2", "FAKE_3"])
        self.assertEqual(self.store()["FAKE_2"]["value"], FAKE + "FAKE_2")

    def test_text_output_names_the_key_not_the_value(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), mock.patch("sys.stdin", io.StringIO("")), mock.patch.dict(os.environ, {"CLAUDECODE": "1"}):
            dispatch.cmd_env(ns("set", "FAKE_D", FAKE, json=False, by=None, note="Demo"))
        text = buf.getvalue()
        self.assertNotIn(FAKE, text)
        self.assertIn("FAKE_D", text)
        self.assertEqual(self.events()[-1]["by"], "agent")
        self.assertNotIn(FAKE[:3] + FAKE[-3:], text)

    def test_short_values_are_never_shown_whole(self):
        self.assertEqual(dispatch.env_mask("abc"), "…")
        self.assertEqual(dispatch.env_mask("abcd1234"), "…")
        self.assertEqual(dispatch.env_mask("abc123def456"), "abc…456")


if __name__ == "__main__":
    unittest.main()
