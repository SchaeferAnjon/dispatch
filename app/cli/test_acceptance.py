"""Checklist updates and task completion stay local to the completing agent."""
import contextlib
import io
import json
import types
import unittest
from unittest.mock import patch

import acceptance as A
from test_dispatch import FakeBoard, dispatch


def args(**kw):
    return types.SimpleNamespace(**dict(dict(task="task-t1", items="", claim=None,
                                            tick=False, untick=False, status=False, json=True), **kw))


class Checklist(unittest.TestCase):
    def run_check(self, board, **kw):
        output = io.StringIO()
        with board.patches({"BEADS_ACTOR": "codex"}), patch.object(dispatch, "link_session"), contextlib.redirect_stdout(output):
            dispatch.cmd_check(args(**kw))
        return json.loads(output.getvalue())

    def test_numbering_and_notes_are_preserved(self):
        text = "Heading\n- [ ] one\n  note\n* [ ] two\n"
        self.assertEqual([i["text"] for i in A.parse_items(text)], ["one", "two"])
        board = FakeBoard(text)
        self.run_check(board, items="2", claim="npm test: 12 passed")
        self.assertEqual(board.issue["acceptance_criteria"], "Heading\n- [ ] one\n  note\n- [x] two @codex")
        self.assertIn("npm test: 12 passed", board.comments[-1]["text"])

    def test_old_pending_and_failed_items_can_be_completed_directly(self):
        for tag in ("claimed:pi", "failed:dispatch-checker", "ask:dispatch-checker"):
            with self.subTest(tag=tag):
                board = FakeBoard(f"- [ ] fixed #{tag}", mode="manual")
                result = self.run_check(board, items="1", claim="src/app.py:10, pytest 4 passed")
                self.assertEqual(result["checked"], [1])
                self.assertEqual(board.issue["acceptance_criteria"], "- [x] fixed @codex")

    def test_status_counts_unsigned_and_old_signed_ticks(self):
        board = FakeBoard("- [x] a @codex\n- [x] b @dispatch-checker #sig:abcd1234\n- [x] c @me #waived\n- [ ] d #failed:dispatch-checker")
        result = self.run_check(board, status=True)
        self.assertEqual(result["progress"], {"done": 3, "todo": 1})
        self.assertEqual([r["text"] for r in result["items"]], ["a", "b", "c", "d"])
        self.assertFalse(any(c[0] == "bd_json" and c[1][0] != "show" for c in board.calls))

    def test_plain_check_reads_without_starting_a_model(self):
        board = FakeBoard("- [ ] a")
        with patch.object(dispatch, "headless_call") as model, patch.object(dispatch.P, "spawn_detached") as spawn:
            self.assertEqual(self.run_check(board)["items"][0]["state"], "todo")
        model.assert_not_called()
        spawn.assert_not_called()

    def test_claim_evidence_round_trips(self):
        board = FakeBoard("- [ ] a")
        self.run_check(board, items="1", claim="npm test: 12 passed")
        row = self.run_check(board, status=True)["items"][0]
        self.assertEqual((row["state"], row["by"], row["evidence"]), ("done", "codex", "npm test: 12 passed"))

    def test_invalid_or_empty_claim_changes_nothing(self):
        for kw in ({"items": "1", "claim": " "}, {"items": "8", "claim": "evidence"}, {"items": "missing", "claim": "evidence"}):
            board = FakeBoard("- [ ] a")
            with self.assertRaises(SystemExit):
                self.run_check(board, **kw)
            self.assertEqual(board.issue["acceptance_criteria"], "- [ ] a")
            self.assertEqual(board.comments, [])

    def test_comment_failure_does_not_tick_the_item(self):
        board = FakeBoard("- [ ] a")
        with board.patches(), patch.object(dispatch, "sh", return_value=(1, "", "write failed")), self.assertRaises(SystemExit):
            dispatch.cmd_check(args(items="1", claim="npm test passed"))
        self.assertEqual(board.issue["acceptance_criteria"], "- [ ] a")

    def test_log_claim_is_the_same_self_check(self):
        board = FakeBoard("- [ ] a\n- [ ] b")
        with board.patches({"BEADS_ACTOR": "codex"}), patch.object(dispatch, "link_session"), contextlib.redirect_stdout(io.StringIO()):
            dispatch.cmd_log(types.SimpleNamespace(task="task-t1", text="pytest 2 passed", claim="1,2", tick=None))
        self.assertTrue(all(i["done"] for i in A.parse_items(board.issue["acceptance_criteria"])))
        self.assertEqual(len(board.comments), 1)

    def test_untick_and_mentions(self):
        board = FakeBoard("- [x] a @codex\n- [ ] notify @someone")
        self.run_check(board, items="1", untick=True)
        self.assertEqual(board.issue["acceptance_criteria"], "- [ ] a\n- [ ] notify @someone")


class DirectCompletion(unittest.TestCase):
    def test_unchecked_and_old_failed_items_never_gate_done(self):
        for mode in ("", "independent", "manual", "self"):
            for verified in (False, True):
                with self.subTest(mode=mode, verified=verified):
                    text = "- [ ] a\n- [ ] b #failed:dispatch-checker\n- [ ] c #ask:dispatch-checker\n- [x] d"
                    board = FakeBoard(text, mode=mode)
                    with board.patches({"BEADS_ACTOR": "codex"}), patch.object(dispatch, "link_session"), patch.object(dispatch, "git_root_of", return_value=""), \
                         patch.object(dispatch._mod("ownership"), "forget"), patch.object(dispatch, "headless_call") as model, patch.object(dispatch.P, "spawn_detached") as spawn, contextlib.redirect_stdout(io.StringIO()):
                        dispatch.cmd_done(types.SimpleNamespace(task="task-t1", reason="npm test: 12 passed", verified=verified, next=[], retro=None, json=True, review_by=None))
                    self.assertEqual(board.issue["status"], "closed")
                    self.assertEqual(board.issue["acceptance_criteria"], text)
                    model.assert_not_called()
                    spawn.assert_not_called()

    def test_parent_completion_does_not_wait_for_manual_check(self):
        parent = {"id": "task-parent", "status": "in_progress", "acceptance_criteria": "- [ ] a", "dependents": [{"id": "task-t1", "status": "closed"}]}
        child = {"dependencies": [{"id": "task-parent", "dependency_type": "parent-child"}]}
        with patch.object(dispatch, "bd_json", return_value=parent) as bd:
            dispatch.parent_autoclose("task-t1", child)
        self.assertEqual(bd.call_args.args[0][:2], ["close", "task-parent"])


class RetiredSettings(unittest.TestCase):
    def test_old_settings_are_ignored_and_removed_on_save(self):
        for mode in ("independent", "manual", "self", "unknown"):
            board = FakeBoard("", mode=mode)
            board.settings.update(check_model="claude:sonnet", gate_sig="obsolete", future_option="keep", summary_uses={"check": 1, "session": 0})
            with board.patches():
                settings = dispatch.settings_load()
                self.assertNotIn("check_mode", settings)
                self.assertNotIn("check_model", settings)
                self.assertEqual(settings["summary_uses"], {"session": 0})
                dispatch.settings_write({"home_expanded": 5, "check_mode": "manual"})
            self.assertEqual(board.settings["home_expanded"], 5)
            self.assertEqual(board.settings["future_option"], "keep")
            for key in ("check_mode", "check_model", "gate_sig"):
                self.assertNotIn(key, board.settings)
            self.assertNotIn("check", board.settings["summary_uses"])


if __name__ == "__main__":
    unittest.main()
