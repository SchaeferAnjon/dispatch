# -*- coding: utf-8 -*-
"""OpenCode as Dispatch's third engine (opencode_engine.py): what its Customizations page and the account
menus read, and Dispatch's OpenCode plugin."""
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

import engines
import opencode_engine as O


class Home(unittest.TestCase):
    """A fake home: OpenCode's config, data and cache folders through the XDG variables."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.env = {"XDG_CONFIG_HOME": os.path.join(self.tmp, "config"), "XDG_DATA_HOME": os.path.join(self.tmp, "data"),
                    "XDG_CACHE_HOME": os.path.join(self.tmp, "cache")}
        self.paths = O.paths(self.env)
        for d in self.paths.values():
            os.makedirs(d, exist_ok=True)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, path, value):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(value if isinstance(value, str) else json.dumps(value))
        return path

    def catalog(self):
        self.write(os.path.join(self.paths["cache"], "models.json"), {
            "deepseek": {"name": "DeepSeek", "env": ["DEEPSEEK_API_KEY"]},
            "zhipuai-coding-plan": {"name": "Zhipu AI Coding Plan", "env": ["ZHIPU_API_KEY"]},
            "zai-coding-plan": {"name": "Z.AI Coding Plan", "env": ["ZHIPU_API_KEY"]},
            "anthropic": {"name": "Anthropic", "env": ["ANTHROPIC_API_KEY"]},
            "opencode": {"name": "OpenCode Zen", "env": ["OPENCODE_API_KEY"]},
        })


class Config(Home):
    def test_jsonc_comments_and_trailing_commas(self):
        text = '{\n  // the model\n  "model": "deepseek/deepseek-chat", /* why */\n  "url": "http://x//y",\n}\n'
        self.assertEqual(json.loads(O.strip_jsonc(text)), {"model": "deepseek/deepseek-chat", "url": "http://x//y"})

    def test_the_file_the_page_writes_is_the_one_there(self):
        d = self.paths["config"]
        self.assertEqual(O.config_file(self.env), os.path.join(d, "opencode.json"))
        self.write(os.path.join(d, "config.json"), {})
        self.assertEqual(O.config_file(self.env), os.path.join(d, "config.json"))
        self.write(os.path.join(d, "opencode.jsonc"), "{}")
        self.assertEqual(O.config_file(self.env), os.path.join(d, "opencode.jsonc"))

    def test_later_files_and_inline_content_win(self):
        d = self.paths["config"]
        self.write(os.path.join(d, "config.json"), {"model": "a/old", "provider": {"x": {"name": "X"}}})
        self.write(os.path.join(d, "opencode.json"), '{"model": "b/new", // comment\n "provider": {"y": {"name": "Y"}}}')
        cfg = O.merged_config(self.env)
        self.assertEqual(cfg["model"], "b/new")
        self.assertEqual(sorted(cfg["provider"]), ["x", "y"])
        cfg = O.merged_config({**self.env, "OPENCODE_CONFIG_CONTENT": '{"model": "c/inline"}'})
        self.assertEqual(cfg["model"], "c/inline")


class Providers(Home):
    def test_where_each_key_comes_from_never_the_key(self):
        self.catalog()
        self.write(os.path.join(self.paths["data"], "auth.json"), {
            "deepseek": {"type": "api", "key": "sk-secret-1"}, "anthropic": {"type": "oauth", "access": "tok", "refresh": "r"}})
        self.write(os.path.join(self.paths["config"], "opencode.json"), {"provider": {"local": {"name": "My LM Studio", "options": {"apiKey": "k"}}}})
        env = {**self.env, "ZHIPU_API_KEY": "zk", "DEEPSEEK_API_KEY": "dk"}
        rows = O.providers(env)
        by = {r["id"]: r for r in rows}
        self.assertEqual([r["name"] for r in rows], sorted([r["name"] for r in rows], key=str.lower))
        self.assertEqual(by["deepseek"]["sources"], [{"kind": "api", "detail": "auth.json"}, {"kind": "env", "detail": "DEEPSEEK_API_KEY"}])
        self.assertEqual(by["anthropic"]["sources"], [{"kind": "oauth", "detail": "auth.json"}])
        self.assertEqual(by["zhipuai-coding-plan"]["sources"], [{"kind": "env", "detail": "ZHIPU_API_KEY"}])
        self.assertEqual(by["local"], {"id": "local", "name": "My LM Studio", "sources": [{"kind": "config", "detail": "opencode.json"}]})
        self.assertEqual(by["opencode"]["sources"], [{"kind": "free", "detail": ""}])
        self.assertNotIn("sk-secret-1", json.dumps(rows))
        self.assertNotIn("zk", json.dumps([s for r in rows for s in r["sources"]]))

    def test_zen_with_a_key_is_not_free(self):
        self.catalog()
        rows = {r["id"]: r for r in O.providers({**self.env, "OPENCODE_API_KEY": "z"})}
        self.assertEqual(rows["opencode"]["sources"], [{"kind": "env", "detail": "OPENCODE_API_KEY"}])


    def test_agents_page_counts_what_the_account_menu_counts(self):
        # task-eibd9: Settings › Agents said "2 providers set up" (auth.json only) while the account menu said
        # "3 providers" (every row, OpenCode Zen's free one too). Both count the providers with a key or a sign-in.
        self.catalog()
        eng = engines.get("opencode")
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "", "ZHIPU_API_KEY": "", "OPENCODE_API_KEY": "", "ANTHROPIC_API_KEY": ""}):
            self.assertEqual(eng.sign_in_status("", self.env), "No provider set up")
            self.write(os.path.join(self.paths["data"], "auth.json"), {"deepseek": {"type": "api", "key": "k"}})
            self.assertEqual(eng.sign_in_status("", {**self.env, "ZHIPU_API_KEY": "zk"}), "3 providers set up")  # DeepSeek, both Zhipu plans
            self.assertEqual(eng.sign_in_status("", self.env), "1 provider set up")
            rows = O.providers(self.env)
            self.assertEqual(len(rows), 2, "Zen's free row is listed, not counted")


class Allowance(Home):
    def test_deepseek_balance(self):
        data = {"is_available": True, "balance_infos": [{"currency": "CNY", "total_balance": "45.15", "granted_balance": "0.00"},
                                                        {"currency": "USD", "total_balance": "0.00"}]}
        self.assertEqual(O.deepseek_balance(data), [{"kind": "balance", "label": "Balance", "amount": 45.15, "currency": "CNY"}])
        self.assertEqual(O.deepseek_balance({"balance_infos": [{"currency": "CNY", "total_balance": "0"}]})[0]["amount"], 0.0)

    def test_zhipu_windows(self):
        data = {"code": 200, "data": {"level": "lite", "limits": [
            {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 3, "nextResetTime": 1790559026000},
            {"type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 90, "nextResetTime": 1790778744000},
            {"type": "TIME_LIMIT", "unit": 99, "number": 1, "percentage": 10}]}}
        self.assertEqual(O.zhipu_limits(data), [
            {"kind": "window", "label": "5-hour", "used_percent": 3, "resets_at": 1790559026, "plan": "lite"},
            {"kind": "window", "label": "weekly", "used_percent": 90, "resets_at": 1790778744, "plan": "lite"}])

    def test_asks_each_provider_its_own_way_and_caches_five_minutes(self):
        self.catalog()
        self.write(os.path.join(self.paths["data"], "auth.json"), {"deepseek": {"type": "api", "key": "sk-1"}})
        env = {**self.env, "ZHIPU_API_KEY": "zk"}
        calls = []

        def get(url, headers, timeout=10):
            calls.append((url, headers))
            if "deepseek" in url:
                return {"balance_infos": [{"currency": "CNY", "total_balance": "12.50"}]}
            return {"data": {"level": "lite", "limits": [{"unit": 6, "number": 1, "percentage": 40, "nextResetTime": 1790778744000}]}}

        with mock.patch.object(engines, "DISPATCH_DIR", self.tmp):
            q = O.quota(["deepseek", "zhipuai-coding-plan", "anthropic"], env, now=1000.0, get=get)
            self.assertEqual(q["deepseek"][0]["amount"], 12.5)
            self.assertEqual(q["zhipuai-coding-plan"][0]["used_percent"], 40)
            self.assertNotIn("anthropic", q)
            self.assertEqual(calls[0], ("https://api.deepseek.com/user/balance", {"Authorization": "Bearer sk-1"}))
            self.assertEqual(calls[1], ("https://open.bigmodel.cn/api/monitor/usage/quota/limit", {"Authorization": "zk"}))
            O.quota(["deepseek"], env, now=1000.0 + O.QUOTA_TTL - 1, get=get)
            self.assertEqual(len(calls), 2)  # cached
            O.quota(["deepseek"], env, now=1000.0 + O.QUOTA_TTL + 1, get=get)
            self.assertEqual(len(calls), 3)
            O.quota(["deepseek"], env, now=1000.0 + O.QUOTA_TTL + 2, refresh=True, get=get)
            self.assertEqual(len(calls), 4)
            with open(os.path.join(self.tmp, "opencode-quota.json")) as f:
                self.assertNotIn("sk-1", f.read())

    def test_offline_keeps_the_last_answer(self):
        self.write(os.path.join(self.paths["data"], "auth.json"), {"deepseek": {"type": "api", "key": "sk-1"}})

        def down(url, headers, timeout=10):
            raise OSError("offline")

        with mock.patch.object(engines, "DISPATCH_DIR", self.tmp):
            self.write(os.path.join(self.tmp, "opencode-quota.json"), {"deepseek": {"at": 0, "rows": [{"kind": "balance", "label": "Balance", "amount": 1.0, "currency": "CNY"}]}})
            self.assertEqual(O.quota(["deepseek"], self.env, now=10_000.0, get=down)["deepseek"][0]["amount"], 1.0)

    def test_two_keys_of_one_account_show_once(self):
        window = [{"kind": "window", "label": "weekly", "used_percent": 90, "resets_at": 1790778744, "plan": "lite"}]
        provs = [
            {"id": "zai-coding-plan", "name": "Z.AI Coding Plan", "sources": [{"kind": "env", "detail": "ZHIPU_API_KEY"}], "quota": list(window)},
            {"id": "zhipuai-coding-plan", "name": "Zhipu AI Coding Plan", "sources": [{"kind": "api", "detail": "auth.json"}], "quota": list(window)},
            {"id": "deepseek", "name": "DeepSeek", "sources": [{"kind": "api", "detail": "auth.json"}], "quota": [{"kind": "balance", "amount": 1.0}]},
            {"id": "anthropic", "name": "Anthropic", "sources": [{"kind": "oauth", "detail": "auth.json"}], "quota": []},
        ]
        O.mark_shared_quota(provs)
        by = {p["id"]: p for p in provs}
        # the one logged in through OpenCode stands for the account
        self.assertEqual(by["zai-coding-plan"].get("same_quota_as"), "zhipuai-coding-plan")
        self.assertNotIn("same_quota_as", by["zhipuai-coding-plan"])
        self.assertNotIn("same_quota_as", by["deepseek"])
        self.assertNotIn("same_quota_as", by["anthropic"])


class Plugin(Home):
    def setUp(self):
        super().setUp()
        self.source = self.write(os.path.join(self.tmp, "ship", "dispatch.js"), "export const DispatchPlugin = async () => ({})\n")
        self.target = O.plugin_path(self.env)

    def test_links_to_the_shipped_file_and_says_so(self):
        r = O.install_plugin(source=self.source, env=self.env)
        self.assertEqual(r["path"], self.target)
        self.assertTrue(r["link"])
        self.assertEqual(os.path.realpath(self.target), os.path.realpath(self.source))
        self.assertTrue(O.install_plugin(source=self.source, env=self.env)["unchanged"])
        with mock.patch.object(O, "PLUGIN_SOURCE", self.source):
            self.assertEqual(O.plugin_state(self.env), {"installed": True, "current": True, "path": self.target})

    def test_keeps_someone_elses_file_in_backups(self):
        import backups
        self.write(self.target, "// mine\n")
        r = O.install_plugin(source=self.source, env=self.env)
        self.assertTrue(r["backup"].startswith(backups.root() + os.sep), r["backup"])
        self.assertFalse(os.path.lexists(self.target + ".bak"))
        with open(r["backup"]) as f:
            self.assertEqual(f.read(), "// mine\n")

    def test_copies_where_links_are_not_possible(self):
        r = O.install_plugin(source=self.source, env=self.env, link=False)
        self.assertFalse(r["link"])
        self.assertFalse(os.path.islink(self.target))
        with mock.patch.object(O, "PLUGIN_SOURCE", self.source):
            self.assertTrue(O.plugin_state(self.env)["current"])
        self.write(self.source, "// newer\n")
        with mock.patch.object(O, "PLUGIN_SOURCE", self.source):
            self.assertEqual(O.plugin_state(self.env), {"installed": True, "current": False, "path": self.target})

    def test_no_opencode_config_folder_no_install(self):
        shutil.rmtree(self.paths["config"])
        r = O.install_plugin(source=self.source, env=self.env)
        self.assertIn("skipped", r)
        self.assertFalse(os.path.lexists(self.target))

    def test_the_shipped_plugin_is_in_the_repository(self):
        self.assertTrue(O.PLUGIN_SOURCE.endswith(os.path.join("agent", "opencode", "dispatch.js")))
        with open(O.PLUGIN_SOURCE, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("todowrite", text)
        self.assertIn("DISPATCH_SESSION_ID", text)
        self.assertIn('"experimental.chat.system.transform"', text)

    def test_install_and_uninstall_keep_config_and_other_plugins(self):
        config = self.write(os.path.join(self.paths["config"], "opencode.json"), '{"model":"mine/model","plugin":["mine"]}\n')
        sibling = self.write(os.path.join(os.path.dirname(self.target), "mine.js"), "// another plugin\n")
        for link in (True, False):
            with self.subTest(link=link):
                O.install_plugin(source=self.source, env=self.env, link=link)
                r = O.uninstall_plugin(source=self.source, env=self.env)
                self.assertTrue(r["removed"])
                self.assertFalse(os.path.lexists(self.target))
                self.assertTrue(os.path.lexists(r["backup"]))
                self.assertTrue(O.uninstall_plugin(source=self.source, env=self.env)["unchanged"])
        with open(config) as f:
            self.assertEqual(f.read(), '{"model":"mine/model","plugin":["mine"]}\n')
        with open(sibling) as f:
            self.assertEqual(f.read(), "// another plugin\n")

    def test_backups_do_not_overwrite_earlier_backups_or_symlink_targets(self):
        user_file = self.write(os.path.join(self.tmp, "mine.js"), "// my plugin\n")
        os.makedirs(os.path.dirname(self.target), exist_ok=True)
        os.symlink(user_file, self.target)
        r = O.install_plugin(source=self.source, env=self.env)
        self.assertTrue(os.path.islink(r["backup"]))
        self.assertEqual(os.path.realpath(r["backup"]), os.path.realpath(user_file))
        O.uninstall_plugin(source=self.source, env=self.env)
        self.write(self.target, "// another revision\n")
        second = O.install_plugin(source=self.source, env=self.env)
        self.assertNotEqual(second["backup"], r["backup"])
        with open(user_file) as f:
            self.assertEqual(f.read(), "// my plugin\n")
        with open(second["backup"]) as f:
            self.assertEqual(f.read(), "// another revision\n")

    def test_uninstall_refuses_an_unmanaged_file(self):
        self.write(self.target, "// mine\n")
        self.assertIn("skipped", O.uninstall_plugin(source=self.source, env=self.env))
        with open(self.target) as f:
            self.assertEqual(f.read(), "// mine\n")

    def test_uninstall_recognizes_an_older_shipped_copy(self):
        self.write(self.target, "// Dispatch integration for OpenCode\n// an older version\n")
        self.assertTrue(O.uninstall_plugin(source=self.source, env=self.env)["removed"])


class Status(Home):
    def test_what_the_page_reads(self):
        self.catalog()
        self.write(os.path.join(self.paths["config"], "opencode.json"), {"model": "deepseek/deepseek-chat"})
        self.write(os.path.join(self.paths["data"], "auth.json"), {"deepseek": {"type": "api", "key": "sk-1"}})
        row = {"installed": True, "path": "/x/opencode", "version": "1.18.32"}

        def get(url, headers, timeout=10):
            return {"balance_infos": [{"currency": "CNY", "total_balance": "45.15"}]}

        with mock.patch.object(engines, "DISPATCH_DIR", self.tmp):
            s = O.status(env=self.env, row=row, get=get)
        self.assertEqual(s["version"], "1.18.32")
        self.assertEqual(s["default_model"], "deepseek/deepseek-chat")
        self.assertEqual(s["default_provider"], "deepseek")
        self.assertEqual(s["config"], {"path": os.path.join(self.paths["config"], "opencode.json"), "exists": True, "dir": self.paths["config"]})
        self.assertEqual(s["auth_path"], os.path.join(self.paths["data"], "auth.json"))
        deepseek = next(p for p in s["providers"] if p["id"] == "deepseek")
        self.assertEqual(deepseek["quota"][0]["amount"], 45.15)
        self.assertEqual(set(s["plugin"]), {"installed", "current", "path"})
        self.assertNotIn("sk-1", json.dumps(s))
        self.assertIn("DeepSeek", O.status_text(s))

    def test_not_installed_asks_nobody(self):
        def get(url, headers, timeout=10):
            raise AssertionError("no quota calls without OpenCode")

        with mock.patch.object(engines, "DISPATCH_DIR", self.tmp):
            s = O.status(env=self.env, row={"installed": False}, get=get)
        self.assertFalse(s["installed"])


if __name__ == "__main__":
    unittest.main()


class ProtectedFolders(Home):
    """A file OpenCode's config names in Desktop, Documents, Downloads or iCloud Drive can stop OpenCode at start (macOS
    privacy settings); Dispatch says which and what to do instead of only showing OpenCode as unavailable."""

    def mac(self):
        return {**self.env, "DISPATCH_PLATFORM": "darwin"}

    def test_finds_plugin_instruction_and_file_key_in_guarded_folders(self):
        home = self.tmp
        os.makedirs(os.path.join(home, "Documents"), exist_ok=True)
        self.write(os.path.join(home, "Documents", "rules.md"), "be nice")
        self.write(os.path.join(self.paths["config"], "opencode.json"), {
            "plugin": [f"file://{home}/Desktop/old/plugin.js", "oh-my-openagent"],
            "instructions": ["~/Documents/rules.md", "~/.config/opencode/AGENTS.md"],
            "provider": {"x": {"options": {"apiKey": "{file:~/Library/Mobile Documents/com~apple~CloudDocs/key.txt}"}}},
        })
        refs = O.protected_refs(env=self.mac(), home=home)
        self.assertEqual([(r["folder"], r["exists"]) for r in refs], [("Desktop", False), ("Documents", True), ("iCloud Drive", False)])
        text = O.protected_text(refs, home=home)
        self.assertIn("~/Desktop/old/plugin.js (and 2 more), in your Desktop folder", text)
        self.assertIn("not there any more", text)
        self.assertIn("Move the file out of Desktop", text)

    def test_nothing_to_say_for_ordinary_paths_or_off_macos(self):
        self.write(os.path.join(self.paths["config"], "opencode.json"), {"plugin": [f"file://{self.tmp}/Desktop/p.js"], "instructions": ["~/.config/opencode/AGENTS.md"]})
        self.assertEqual(O.protected_refs(env={**self.env, "DISPATCH_PLATFORM": "linux"}, home=self.tmp), [])
        self.write(os.path.join(self.paths["config"], "opencode.json"), {"instructions": ["~/.config/opencode/AGENTS.md", "~/Desktopish/x.md"]})
        self.assertEqual(O.protected_refs(env=self.mac(), home=self.tmp), [])
        self.assertEqual(O.protected_text([]), "")

    def test_status_carries_the_warning(self):
        self.write(os.path.join(self.paths["config"], "opencode.json"), {"plugin": ["file://" + os.path.expanduser("~/Desktop/p.js")]})
        s = O.status(env=self.mac(), row={"installed": True, "version": "1.18.0"}, get=lambda *a, **k: {})
        self.assertEqual(s["protected"][0]["folder"], "Desktop")
        self.assertIn("in your Desktop folder", s["protected_text"])
        self.assertIn("warning: ", O.status_text(s))
