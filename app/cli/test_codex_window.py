import json
import os
import tempfile
import unittest
from unittest.mock import patch
import codex_window as W
import engines


def home(config="", catalog=None):
    d = tempfile.mkdtemp()
    if config:
        with open(os.path.join(d, "config.toml"), "w") as f:
            f.write(config)
    if catalog is not None:
        with open(os.path.join(d, "models_cache.json"), "w") as f:
            json.dump({"models": catalog}, f)
    return d


class CodexWindow(unittest.TestCase):
    def test_known_models_get_their_maximum_and_others_nothing(self):
        h = home()
        self.assertEqual(W.window_for("gpt-6-astra", h), 872000)
        self.assertEqual(W.window_for("gpt-5.6-sol", h), 872000)
        self.assertEqual(W.window_for("gpt-daybreak-red-latest", h), 372000)
        self.assertIsNone(W.window_for("gpt-5.5", h))       # maximum equals the default: nothing to gain
        self.assertIsNone(W.window_for("some-future-model", h))
        self.assertEqual(W.config_args("gpt-6-astra", h), ["-c", "model_context_window=872000"])
        self.assertEqual(W.thread_config("gpt-6-astra", h), {"model_context_window": 872000})
        self.assertEqual((W.config_args("nope", h), W.thread_config("nope", h)), ([], {}))

    def test_the_users_own_window_wins_at_top_level_or_in_the_active_profile(self):
        self.assertIsNone(W.window_for("gpt-6-astra", home("model_context_window = 1000000\n")))
        self.assertIsNone(W.window_for("gpt-6-astra", home('profile = "big"\n[profiles.big]\nmodel_context_window = 500000\n')))
        # a key inside another table, or in an inactive profile, is not the user's setting for this run
        self.assertEqual(W.window_for("gpt-6-astra", home('[profiles.big]\nmodel_context_window = 500000\n')), 872000)
        self.assertEqual(W.window_for("gpt-6-astra", home('[projects."/x"]\nmodel_context_window = 5\n')), 872000)

    def test_the_catalog_codex_cached_beats_the_built_in_table(self):
        h = home(catalog=[{"slug": "gpt-7", "max_context_window": 2000000}, {"slug": "gpt-6-astra", "max_context_window": 900000}])
        self.assertEqual(W.window_for("gpt-7", h), 2000000)
        self.assertEqual(W.window_for("gpt-6-astra", h), 900000)

    def test_no_model_means_the_configured_default_or_the_largest_known(self):
        self.assertEqual(W.window_for("", home()), 872000)  # Codex clamps it to whatever model it picks
        self.assertEqual(W.window_for("", home('model = "gpt-daybreak-red-latest"\n')), 372000)
        self.assertIsNone(W.window_for("", home('model = "gpt-5.5"\n')))

    def test_codex_exec_workers_and_resumes_carry_it_and_other_engines_do_not(self):
        h = home()
        with patch.dict(os.environ, {"CODEX_HOME": h}):
            argv = engines.get("codex").headless_argv("gpt-6-astra", "go", "/w", effort="high")
            resumed = engines.get("codex").headless_argv("gpt-6-astra", "go", "/w", session="abc", resume=True)
            other = engines.get("codex").headless_argv("gpt-5.5", "go", "/w")
            claude = engines.get("claude").headless_argv("opus", "go", "/w")
        for a in (argv, resumed):
            self.assertIn("model_context_window=872000", a)
            self.assertEqual(a[a.index("model_context_window=872000") - 1], "-c")
        self.assertFalse([x for x in other + claude if "model_context_window" in x])
        with patch.dict(os.environ, {"CODEX_HOME": home("model_context_window = 1000000\n")}):
            self.assertFalse([x for x in engines.get("codex").headless_argv("gpt-6-astra", "go", "/w") if "model_context_window" in x])


if __name__ == "__main__":
    unittest.main()
