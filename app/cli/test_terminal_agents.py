# -*- coding: utf-8 -*-
"""The agents a person can run in the Agents window's terminal. Everything lives in a temporary HOME."""
import json
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agents_catalog as AC
import engines as E
import terminal_agents as T
import terminal_cmd


def exe(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


class Rows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, ".local", "bin")
        self.env = {"PATH": "/usr/bin:/bin"}
        for p in (mock.patch.object(E, "HOME", self.tmp), mock.patch.object(AC, "home", lambda: self.tmp),
                  mock.patch.object(E, "search_path", lambda env=None: self.bin),
                  mock.patch.dict(os.environ, {"HOME": self.tmp, "DISPATCH_DIR": os.path.join(self.tmp, "state")})):
            p.start()
            self.addCleanup(p.stop)
        import autonomy
        autonomy.save("ask-every")  # the commands as typed by hand; Full auto's own arguments: test_the_level_*

    def ids(self):
        return [r["id"] for r in T.rows(self.env)]

    def test_only_agents_that_are_here_are_listed(self):
        self.assertEqual(self.ids(), [])
        exe(os.path.join(self.bin, "claude"), "echo claude")
        exe(os.path.join(self.bin, "gemini"), "echo gemini")
        self.assertEqual(self.ids(), ["claude", "gemini"])

    def test_the_command_is_the_full_path_so_a_short_search_path_still_starts_it(self):
        path = exe(os.path.join(self.bin, "claude"), "echo claude")
        row = T.rows(self.env)[0]
        self.assertEqual(row["command"].split(" --settings ")[0], path)
        self.assertEqual(row["name"], "Claude Code")
        self.assertTrue(row["about"])

    def test_a_path_with_a_space_is_quoted(self):
        self.assertTrue(T.launch_command("claude", "/Users/a b/bin/claude").startswith("'/Users/a b/bin/claude' "))

    def test_agents_that_need_an_argument_to_open_their_terminal_interface_get_it(self):
        self.assertEqual(T.launch_command("kiro", "/x/kiro-cli"), "/x/kiro-cli chat --tui")
        self.assertEqual(T.launch_command("hermes", "/x/hermes"), "/x/hermes --tui")
        self.assertEqual(T.launch_command("muse", "/x/muse"), "/x/muse --trust-workspace")
        self.assertEqual(T.launch_command("command-code", "/x/command-code"), "/x/command-code --trust")
        oc = T.launch_command("opencode", "/x/opencode")
        self.assertTrue(oc.startswith("OPENCODE_CONFIG_CONTENT="), oc)
        self.assertIn("opencode-turns.js", oc)
        self.assertTrue(oc.endswith(" /x/opencode"), oc)
        self.assertTrue(T.launch_command("codex", "/x/codex").startswith("/x/codex -c 'notify=["))

    def test_claude_and_codex_tell_dispatch_when_their_turn_ends(self):
        line = T.launch_command("claude", "/x/claude")
        settings = os.path.join(os.environ["DISPATCH_DIR"], "termd", "claude-settings.json")
        self.assertEqual(line, f"/x/claude --settings {settings}")
        with open(settings) as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(sorted(hooks), ["Notification", "Stop", "StopFailure", "UserPromptSubmit"])
        self.assertIn("dispatch-hook", hooks["Stop"][0]["hooks"][0]["command"])  # Dispatch's one hook entry (its stable entry, task-g7t62)
        self.assertTrue(hooks["Stop"][0]["hooks"][0]["command"].endswith(" claude-code --terminal"))
        notify = T.launch_command("codex", "/x/codex").split(" -c ", 1)[1]
        program = json.loads(notify.strip("'").split("=", 1)[1])
        self.assertTrue(program[1].endswith("hook.py"))
        self.assertEqual(program[-3:], ["codex", "--terminal", "notify"])

    def test_a_person_s_own_codex_notify_program_is_left_alone(self):
        os.makedirs(os.path.join(self.tmp, ".codex"))
        with open(os.path.join(self.tmp, ".codex", "config.toml"), "w") as f:
            f.write('model = "x"\nnotify = ["my-notifier"]\n')
        self.assertEqual(T.launch_command("codex", "/x/codex"), "/x/codex")

    def test_claude_gets_its_conversation_id_so_it_can_go_on_after_a_restart(self):
        exe(os.path.join(self.bin, "claude"), "echo '2.1.0 (Claude Code)'")
        row = next(r for r in T.rows(self.env) if r["id"] == "claude")
        self.assertEqual(row["start"], row["command"] + " --session-id {session}")
        self.assertEqual(row["resume"], row["command"] + " --resume {session}")
        self.assertIn("--fork-session --session-id {new}", row["fork"])

    def test_an_agent_without_a_way_to_go_on_has_empty_recipes(self):
        self.assertEqual(T.recipe("aider", "/x/aider"), {"start": "", "resume": "", "fork": ""})
        self.assertEqual(T.recipe("codex", "/x/codex")["resume"], "/x/codex resume --last")

    def test_the_level_chosen_for_new_sessions_starts_the_terminal_agent_too(self):
        """task-lj06.33: Settings said Full auto, the terminal's Claude Code said manual mode on."""
        import autonomy
        autonomy.save("auto")
        self.assertTrue(T.launch_command("claude", "/x/claude").startswith("/x/claude --permission-mode bypassPermissions --settings "))
        self.assertTrue(T.launch_command("codex", "/x/codex").startswith("/x/codex --dangerously-bypass-approvals-and-sandbox -c 'notify=["))
        self.assertNotIn("--permission", T.launch_command("gemini", "/x/gemini"))
        exe(os.path.join(self.bin, "claude"), "echo '2.1.0 (Claude Code)'")
        row = next(r for r in T.rows(self.env) if r["id"] == "claude")
        self.assertTrue(row["resume"].startswith("/x/claude".replace("/x/claude", row["path"]) + " --permission-mode bypassPermissions"))
        autonomy.save("ask-risky")
        self.assertTrue(T.launch_command("claude", "/x/claude").startswith("/x/claude --permission-mode acceptEdits --settings "))
        self.assertTrue(T.launch_command("codex", "/x/codex").startswith("/x/codex -c "))
        autonomy.save("ask-every")
        self.assertTrue(T.launch_command("claude", "/x/claude").startswith("/x/claude --settings "))

    def test_no_agent_starts_in_its_do_everything_mode(self):
        # by its terminal arguments alone: only the person's Full auto (above) adds that
        for eng in T.E.known():
            self.assertNotRegex(eng.terminal_args, r"yolo|dangerously|skip-permissions|bypass|auto-approve")

    def test_the_ones_in_use_come_first_and_the_default_is_first_among_them(self):
        for name in ("gemini", "codex", "claude", "opencode"):
            exe(os.path.join(self.bin, name), "echo " + name)
        self.assertEqual(self.ids(), ["claude", "codex", "opencode", "gemini"])
        rows = {r["id"]: r for r in T.rows(self.env)}
        self.assertTrue(rows["claude"]["is_default"] and rows["claude"]["enabled"] and rows["claude"]["runnable"])
        self.assertFalse(rows["gemini"]["enabled"])  # found, but not ticked in the wizard: still offered, after the others
        AC.save_choice(default="codex")
        self.assertEqual(self.ids()[0], "codex")
        AC.save_choice(on=["gemini"], off=["claude"])
        self.assertEqual(self.ids(), ["codex", "opencode", "gemini", "claude"])

    def test_a_short_name_another_tool_uses_must_answer_with_a_version(self):
        exe(os.path.join(self.bin, "muse"), "echo 'Muse is a music notation program'")
        self.assertEqual(self.ids(), [])
        exe(os.path.join(self.bin, "muse"), "echo 'muse 0.4.2'")
        self.assertEqual(self.ids(), ["muse"])

    def test_the_command_line_answers_json(self):
        exe(os.path.join(self.bin, "claude"), "echo claude")
        out = terminal_cmd.answer("agents")
        self.assertTrue(out["ok"])
        self.assertEqual(json.loads(json.dumps(out))["agents"][0]["id"], "claude")
        self.assertFalse(terminal_cmd.answer("nope")["ok"])


if __name__ == "__main__":
    unittest.main()
