# -*- coding: utf-8 -*-
"""The engine registry (engines/): one file per engine, the rest of Dispatch asks it instead of branching on names."""
import os
import shutil
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import engines as E  # noqa: E402
from engines import catalog  # noqa: E402

WINDOWS_READY = True


class Registry(unittest.TestCase):
    def test_every_name_of_an_engine_finds_it(self):
        self.assertEqual(E.get("claude").id, "claude")
        self.assertEqual(E.get("claude-code").id, "claude")
        self.assertEqual(E.get("copilotcli").id, "copilot")
        self.assertEqual(E.get("cursor-agent").id, "cursor")
        self.assertEqual(E.agent_of("claude"), "claude-code")
        self.assertEqual(E.id_of("claude-code"), "claude")
        self.assertEqual(E.provider_of("copilot"), "copilotcli")
        self.assertEqual(E.provider_of("gemini"), "gemini")  # no window provider: the name stays

    def test_a_name_nobody_knows_supports_nothing(self):
        self.assertIsNone(E.find("nobody"))
        e = E.get("nobody")
        self.assertEqual((e.id, e.agent, e.name, e.short_name), ("nobody", "nobody", "nobody", "nobody"))
        self.assertFalse(e.runnable)
        self.assertFalse(e.package)
        self.assertEqual(E.agent_of("nobody"), "nobody")

    def test_ids_and_names_are_unique_and_lists_follow_the_catalog_order(self):
        ids = [e.id for e in E.known()]
        self.assertEqual(len(ids), len(set(ids)))
        ranked = [i for i in ids if i in catalog.ORDER]
        self.assertEqual(ranked, [i for i in catalog.ORDER if i in ids])
        self.assertEqual(ids[:len(ranked)], ranked)  # an adapter the order does not name comes after all of these
        self.assertEqual([e.id for e in E.runnable()], ["claude", "codex", "opencode"])
        self.assertEqual([e.id for e in E.managed()], ["claude", "codex", "opencode"])

    def test_adapters_carry_their_own_row_and_leave_the_catalog(self):
        rows = {r["id"] for r in catalog.AGENTS}
        for e in E.adapters():
            self.assertNotIn(e.id, rows, e.id)
            self.assertTrue(e.name and e.about and e.bins, e.id)

    def test_a_row_names_only_fields_of_the_interface(self):
        with self.assertRaises(TypeError):
            E.Engine(id="x", not_a_field=1)

    def test_supports_tells_a_method_an_adapter_has_from_the_default(self):
        class Small(E.Engine):
            id = "small"

            def native_install(self, real_path):
                return True
        self.assertTrue(Small().supports("native_install"))
        self.assertFalse(E.Engine(id="plain").supports("native_install"))
        self.assertTrue(E.get("opencode").supports("min_version"))
        self.assertFalse(E.get("claude").supports("min_version"))

    def test_a_process_is_known_by_its_command_package_or_own_folder(self):
        self.assertEqual(E.by_process("claude", "/usr/local/bin/claude").id, "claude")
        self.assertEqual(E.by_process("2.1.290", "/Users/a/.local/share/claude/versions/2.1.290").id, "claude")
        self.assertEqual(E.by_process("codex-aarch64-apple-darwin", "/x/node_modules/@openai/codex/vendor/codex-aarch64-apple-darwin").id, "codex")
        self.assertEqual(E.by_process("cursor-agent", "/x/cursor-agent").agent, "cursor")
        self.assertIsNone(E.by_process("zsh", "/bin/zsh"))
        self.assertIsNone(E.by_process("muse", "/x/muse"))  # a name other tools use too: not enough on its own


class OneFileAddsAnEngine(unittest.TestCase):
    """Adding an agent is adding one file to engines/: the registry finds it, every list has it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        with open(os.path.join(self.tmp, "newagent.py"), "w") as f:
            f.write(textwrap.dedent('''
                from engines.base import Engine

                class NewAgent(Engine):
                    id = "newagent"
                    name = "New Agent"
                    about = "A test agent."
                    bins = ("newagent",)
                    terminal_recipe = {"resume": "--continue"}

                ENGINE = NewAgent()
            '''))
        self.path = list(E.__path__)
        E.__path__.append(self.tmp)
        E._REGISTRY = None
        self.addCleanup(self.restore)

    def restore(self):
        E.__path__[:] = self.path
        sys.modules.pop("engines.newagent", None)
        E._REGISTRY = None
        if getattr(self, "reload_catalog", False):
            import importlib
            import agents_catalog
            importlib.reload(agents_catalog)  # back to the real registry

    def test_the_new_file_is_in_the_registry_and_the_catalog(self):
        import agents_catalog as AC
        import importlib
        self.assertEqual(E.get("newagent").name, "New Agent")
        self.assertEqual(E.known()[-1].id, "newagent")  # not in the catalog's order: last
        rows = [e.catalog_row() for e in E.known()]
        self.assertIn({"id": "newagent", "name": "New Agent", "about": "A test agent.", "bins": ("newagent",)}, rows)
        import terminal_agents as T
        self.assertEqual(T.recipe("newagent", "/x/newagent")["resume"], "/x/newagent --continue")
        self.reload_catalog = True
        importlib.reload(AC)  # its CATALOG is read once at import
        self.assertIn("newagent", AC.BY_ID)


if __name__ == "__main__":
    unittest.main()
