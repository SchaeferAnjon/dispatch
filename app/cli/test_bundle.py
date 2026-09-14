import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class Bundle(unittest.TestCase):
    def test_every_cli_module_ships_in_the_app(self):
        # The installed Dispatch.app runs the CLI from its bundle, which only contains the files
        # tauri.conf.json lists. A module missing there works from the repo and silently fails in the
        # app (rules_sync.py did: edits never synced from the installed app).
        conf = json.load(open(os.path.join(HERE, "..", "src-tauri", "tauri.conf.json")))
        resources = conf["bundle"]["resources"]
        listed = {os.path.basename(k) for k in (resources if isinstance(resources, dict) else {r: r for r in resources})}
        modules = {f for f in os.listdir(HERE) if f.endswith(".py") and not f.startswith("test_")}
        self.assertEqual(sorted(modules - listed), [])


if __name__ == "__main__":
    unittest.main()
