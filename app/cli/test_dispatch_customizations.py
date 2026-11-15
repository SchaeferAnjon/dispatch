"""Customizations controls preserve unrelated settings and reject stale Undo."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import customizations as C


class Customizations(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.data = self.root / "dispatch"
        self.addCleanup(patch.stopall)
        patch.object(C, "home", return_value=self.home).start()
        patch.object(C.DD, "root", return_value=str(self.data)).start()
        # OpenCode's plugin is looked for in its config folder: this test's own, never the person's ~/.config
        patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.root / "xdg")}).start()
        self.path = C.hook_paths()["claude"]
        self.original = {"permissions": {"allow": ["Read"]}, "env": {"CUSTOM": "kept"}, "hooks": {
            "SessionStart": [{"matcher": "startup", "timeout": 10, "hooks": [
                {"type": "command", "command": "beads prime"},
                {"type": "command", "command": "dispatch prime --hook-json # dispatch-prime", "timeout": 45},
            ]}],
            "PostToolUse": [{"matcher": "Read", "hooks": [{"type": "command", "command": "my-hook"}]}],
        }}
        C.write_json(self.path, self.original)

    def test_a_group_the_engine_has_no_hook_for_is_not_offered(self):
        groups = {g["id"]: g for g in C.hooks_list()["groups"]}
        self.assertFalse(groups["edit-guard"]["agents"]["codex"]["supported"])
        self.assertTrue(groups["edit-guard"]["agents"]["claude"]["supported"])
        self.assertTrue(groups["plan"]["agents"]["codex"]["supported"])
        with self.assertRaises(ValueError):
            C.toggle_hook("edit-guard", "codex", True)

    def test_opencode_is_listed_with_the_features_its_plugin_has(self):
        # Hooks listed only Claude Code and Codex; OpenCode's Dispatch plugin asks the same entry (task-lj06.32)
        import engines
        groups = {g["id"]: g for g in C.hooks_list()["groups"]}
        oc = {g: groups[g]["agents"]["opencode"] for g in groups}
        self.assertTrue(oc["prime"]["supported"])
        self.assertTrue(oc["plan"]["supported"])
        self.assertFalse(oc["edit-guard"]["supported"])
        state = {"installed": True, "current": True, "path": str(self.root / "dispatch.js")}
        with patch.object(engines.get("opencode"), "plugin_state", return_value=state):
            row = C.hooks_list()["groups"][0]["agents"]["opencode"]
            self.assertEqual((row["enabled"], row["available"], row["events"]), (True, True, ["SessionStart"]))
            C.toggle_hook("prime", "opencode", False)
            self.assertFalse(C.hooks_list()["groups"][0]["agents"]["opencode"]["enabled"])
            C.toggle_hook("prime", "opencode", True)
            self.assertTrue(C.hooks_list()["groups"][0]["agents"]["opencode"]["enabled"])
        with self.assertRaises(ValueError):
            C.toggle_hook("edit-guard", "opencode", True)

    def entry(self):
        import engines
        res = engines.get("claude").install_hooks()
        self.assertFalse(res.get("skipped"), res)
        return res

    def test_a_switch_turns_a_feature_off_without_touching_the_agents_file(self):
        import hook
        self.entry()
        before = self.path.read_bytes()
        self.assertTrue(C.hooks_list()["groups"][0]["agents"]["claude"]["enabled"])
        C.toggle_hook("prime", "claude", False)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(hook.switches("claude-code", str(self.data / "config.json"))["prime"])
        row = C.hooks_list()["groups"][0]["agents"]["claude"]
        self.assertEqual((row["enabled"], row["available"], row["count"]), (False, True, 0))
        self.assertEqual(C.toggle_hook("prime", "claude", False), {"ok": True, "unchanged": True})
        C.toggle_hook("prime", "claude", True)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(hook.switches("claude-code", str(self.data / "config.json"))["prime"])
        self.assertEqual(C.hooks_list()["groups"][0]["agents"]["claude"]["events"], ["SessionStart"])

    def test_the_entry_replaces_the_older_prime_and_keeps_everything_else(self):
        res = self.entry()
        self.assertEqual(res["migrated"], ["prime"])
        now = json.loads(self.path.read_text())
        self.assertEqual(now["permissions"], self.original["permissions"])
        self.assertEqual(now["env"], self.original["env"])
        start = now["hooks"]["SessionStart"]
        self.assertEqual(start[0]["hooks"], [{"type": "command", "command": "beads prime"}], "their own hook stays, in its own group")
        self.assertEqual((start[0]["matcher"], start[0]["timeout"]), ("startup", 10))
        self.assertIn("# dispatch-hook", start[1]["hooks"][0]["command"])
        self.assertIn({"type": "command", "command": "my-hook"}, now["hooks"]["PostToolUse"][0]["hooks"])
        self.assertNotIn("dispatch prime --hook-json", self.path.read_text())

    def test_install_keeps_a_symlinked_settings_file_and_its_mode(self):
        target = self.root / "settings.json"
        self.path.rename(target)
        self.path.symlink_to(target)
        target.chmod(0o640)
        self.entry()
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        self.assertIn("# dispatch-hook", target.read_text())

    def test_malformed_configuration_is_not_replaced(self):
        for raw in ('{"hooks": []}', '{"hooks":{"SessionStart": {}}}', '{bad'):
            self.path.write_text(raw)
            with self.assertRaises(ValueError):
                C.toggle_hook("edit-guard", "claude", True)
            self.assertEqual(self.path.read_text(), raw)

    def test_marker_does_not_match_someone_elses_name(self):
        import hooks_setup
        self.assertIsNone(hooks_setup.kind("echo '# dispatch-prime-other'"))
        self.assertIsNone(hooks_setup.kind("echo '# dispatch-hooky'"))
        with self.assertRaises(ValueError):
            C.toggle_hook("unknown", "claude", False)
        with self.assertRaises(ValueError):
            C.toggle_hook("prime", "unknown", False)

    def test_turning_on_a_group_where_the_entry_never_was_puts_the_entry_in(self):
        (self.home / ".codex").mkdir()
        trusted = []
        with patch("engines.codex.trust_hook", lambda path, command, before=None, env=None: trusted.append(path) or {"ok": True}):
            C.toggle_hook("plan", "codex", True)
        codex = json.loads((self.home / ".codex" / "hooks.json").read_text())
        self.assertEqual(set(codex["hooks"]), {"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"})
        self.assertEqual(trusted, [str(self.home / ".codex" / "hooks.json")], "Codex is asked to trust it")
        self.assertTrue(C.hooks_list()["groups"][2]["agents"]["codex"]["enabled"])
        C.toggle_hook("edit-guard", "claude", True)
        claude = json.loads(self.path.read_text())
        self.assertEqual(claude["permissions"], self.original["permissions"])
        self.assertIn({"type": "command", "command": "my-hook"}, claude["hooks"]["PostToolUse"][0]["hooks"])
        guard = next(g for g in C.hooks_list()["groups"] if g["id"] == "edit-guard")["agents"]["claude"]
        self.assertEqual((guard["enabled"], guard["events"]), (True, ["PostToolUse", "PreToolUse"]))
        with self.assertRaisesRegex(ValueError, "Choose"):
            C.toggle_hook("plan", "nobody", True)

    def test_an_import_row_for_a_feature_turns_it_off_on_undo(self):
        import prefs
        self.entry()
        with patch.object(C, "rules_status", return_value={"targets": []}), patch.object(C.DD, "legacy_places", return_value=[]), \
                patch.object(prefs, "imports_path", return_value=str(self.root / "none")), patch.object(C, "setup_receipts", return_value=[]):
            row = next(r for r in C.imports_list() if r["kind"] == "hooks" and r["group"] == "presence" and r["agent"] == "claude")
            C.undo_import(row["id"])
            self.assertFalse(C.hooks_list()["groups"][1]["agents"]["claude"]["enabled"])
            with self.assertRaises(ValueError):
                C.undo_import(row["id"])

    def test_concurrent_file_change_is_rejected(self):
        before = self.path.read_bytes()
        self.path.write_text("changed")
        with self.assertRaises(ValueError):
            C.write_bytes(self.path, b"replacement", before)
        self.assertEqual(self.path.read_text(), "changed")

    def import_rows(self):
        import prefs
        return contextlib.ExitStack(), prefs

    def test_rules_undo_keeps_unmanaged_text(self):
        import prefs
        p = self.home / "AGENTS.md"
        p.write_text("before\n" + C.D.RULES_BEGIN + " hash:123 -->\nmanaged\n" + C.D.RULES_END + "\nafter\n")
        with patch.object(C, "rules_status", return_value={"targets": [{"path": str(p), "agent": "codex"}]}), \
                patch.object(C.DD, "legacy_places", return_value=[]), patch.object(prefs, "imports_path", return_value=str(self.root / "none")):
            row = next(r for r in C.imports_list() if r["kind"] == "rules")
            C.undo_import(row["id"])
            self.assertEqual(p.read_text(), "before\nafter\n")
            self.assertTrue(any(r.get("undone") for r in C.imports_list()))
            with self.assertRaises(ValueError):
                C.undo_import(row["id"])

    def test_stale_rules_receipt_cannot_remove_a_new_block(self):
        import prefs
        p = self.home / "AGENTS.md"
        p.write_text(C.D.RULES_BEGIN + "\nold\n" + C.D.RULES_END)
        with patch.object(C, "rules_status", return_value={"targets": [{"path": str(p), "agent": "codex"}]}), \
                patch.object(C.DD, "legacy_places", return_value=[]), patch.object(prefs, "imports_path", return_value=str(self.root / "none")):
            key = next(r["id"] for r in C.imports_list() if r["kind"] == "rules")
            p.write_text(p.read_text().replace("old", "new"))
            with self.assertRaises(ValueError):
                C.undo_import(key)
            self.assertIn("new", p.read_text())

    def test_directory_undo_preserves_both_copies(self):
        import prefs
        old = self.home / "skills"
        new = self.data / "skills"
        new.mkdir(parents=True)
        (new / "latest.txt").write_text("new edits")
        backup = Path(str(old) + ".pre-dispatch")
        backup.mkdir()
        (backup / "original.txt").write_text("original")
        old.symlink_to(new)
        with patch.object(C.DD, "legacy_places", return_value=[("skills", str(old), str(new))]), \
                patch.object(C, "scoped", side_effect=Path), patch.object(C, "rules_status", return_value={"targets": []}), \
                patch.object(prefs, "imports_path", return_value=str(self.root / "none")):
            row = next(r for r in C.imports_list() if r["kind"] == "directory")
            position = next(i for i, r in enumerate(C.imports_list()) if r["id"] == row["id"])
            C.undo_import(row["id"])
            self.assertEqual(next(i for i, r in enumerate(C.imports_list()) if r["id"] == row["id"]), position)
            self.assertFalse(old.is_symlink())
            self.assertEqual((old / "original.txt").read_text(), "original")
            self.assertEqual((new / "latest.txt").read_text(), "new edits")

    def test_a_link_made_where_there_was_no_folder_is_not_a_missing_backup(self):
        # task-4o71: a new Mac has no ~/.claude/agents; the link Dispatch made there read "The original folder backup is missing."
        import prefs
        old = self.home / "agents"
        new = self.data / "agents"
        new.mkdir(parents=True)
        old.symlink_to(new)
        with patch.object(C.DD, "legacy_places", return_value=[("agents", str(old), str(new))]), \
                patch.object(C, "scoped", side_effect=Path), patch.object(C, "rules_status", return_value={"targets": []}), \
                patch.object(prefs, "imports_path", return_value=str(self.root / "none")):
            row = next(r for r in C.imports_list() if r["kind"] == "directory")
        self.assertEqual(row["reason"], "")
        self.assertFalse(row["can_undo"])
        self.assertIn("no folder here before", row["detail"])
        self.assertNotIn("missing", row["detail"] + row["reason"])

    def test_skill_adoption_is_reversible_without_losing_later_edits(self):
        import prefs
        old = self.home / "review"
        old.mkdir()
        (old / "SKILL.md").write_text("---\nname: review\n---\nReview")
        pool = self.data / "skills"
        row = {"name": "review", "path": str(old), "builtin": False, "in_pool": False}
        with patch.object(C, "skills_list", return_value=[row]), patch.object(C.D, "POOL", str(pool)), \
                patch.object(C.DD, "legacy_places", return_value=[]), patch.object(C, "rules_status", return_value={"targets": []}), \
                patch.object(prefs, "imports_path", return_value=str(self.root / "none")):
            C.skill_change("review", adopt=True)
            self.assertTrue(old.is_symlink())
            (pool / "review" / "later.md").write_text("new")
            rec = next(r for r in C.imports_list() if r["name"] == "review")
            C.undo_import(rec["id"])
            self.assertFalse(old.is_symlink())
            self.assertTrue((old / "SKILL.md").is_file())
            self.assertEqual((pool / "review" / "later.md").read_text(), "new")

    def test_builtin_changes_are_rejected(self):
        with patch.object(C, "skills_list", return_value=[{"name": "task-board", "builtin": True}]):
            with self.assertRaisesRegex(ValueError, "read-only"):
                C.skill_change("task-board", "codex", False)
            with self.assertRaisesRegex(ValueError, "read-only"):
                C.skill_change("task-board", adopt=True)

    def test_sync_rejects_an_incomplete_block_before_any_write(self):
        p = self.home / "AGENTS.md"
        p.write_text("keep\n" + C.D.RULES_BEGIN + "\nmy later instructions\n")
        with patch.object(C, "rules_status", return_value={"targets": [{"path": str(p)}]}), patch.object(C.D, "cmd_rules") as sync:
            with self.assertRaisesRegex(ValueError, "incomplete"):
                C.sync_rules()
            sync.assert_not_called()
            self.assertIn("my later instructions", p.read_text())

    def test_builtin_identity_uses_origin_not_just_name(self):
        p = C.shipped_skill("task-board")
        self.assertTrue(C.is_builtin_skill("task-board", str(p)))
        self.assertFalse(C.is_builtin_skill("task-board", str(self.home / "task-board")))

    def test_an_instance_on_its_own_fixture_home_uses_that_home(self):
        patch.stopall()
        with tempfile.TemporaryDirectory() as t:
            fixture = os.path.join(t, "home")
            os.makedirs(fixture)
            with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": t}), patch.object(C.D, "HOME", fixture):
                self.assertEqual(C.home(), Path(fixture))
            with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": t}), patch.object(C.D, "HOME", "/Users/someone"):
                self.assertEqual(C.home(), Path(t, "customizations-home"))  # the person's real HOME is never edited
            with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": ""}), patch.object(C.D, "HOME", "/Users/someone"):
                self.assertEqual(C.home(), Path("/Users/someone"))

    def test_a_copied_builtin_is_builtin_by_name_and_content(self):
        import shutil
        copy = self.home / "pool" / "task-board"
        shutil.copytree(C.shipped_skill("task-board"), copy)
        self.assertTrue(C.is_builtin_skill("task-board", str(copy)))  # not a second "User" task-board
        (copy / "SKILL.md").write_text("---\nname: task-board\n---\nmy own board notes\n")
        self.assertFalse(C.is_builtin_skill("task-board", str(copy)))


if __name__ == "__main__":
    unittest.main()
