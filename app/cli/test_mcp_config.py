# -*- coding: utf-8 -*-
"""dispatch mcp: one list over Claude Code, Codex and OpenCode; add / remove write each engine's own format."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import mcp_config as M
from engines import codex as CX

HERE = os.path.dirname(os.path.abspath(__file__))
CODEX = '''model = "gpt"
[mcp_servers.node_repl]
command = "/bin/node_repl"
args = []
[mcp_servers.node_repl.env]
SECRET_TOKEN = "s3cr3t"

# Compatibility for the history client.
[mcp_servers.history]
command = "python3"
args = ["/x/history.py"]

[[skills.config]]
path = "/x/SKILL.md"
enabled = false
'''


class Mcp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.env = {"HOME": self.home, "CODEX_HOME": os.path.join(self.home, ".codex"),
                    "XDG_CONFIG_HOME": os.path.join(self.home, ".config"), "CLAUDE_CONFIG_DIR": ""}
        p = patch.dict(os.environ, self.env)
        p.start(); self.addCleanup(p.stop)
        os.environ.pop("CLAUDE_CONFIG_DIR")
        os.environ.pop("DISPATCH_SESSION_ROOT", None)
        p = patch.object(M, "home", return_value=self.home)
        p.start(); self.addCleanup(p.stop)
        os.makedirs(os.path.join(self.home, ".codex"))
        os.makedirs(os.path.join(self.home, ".config", "opencode"))
        self.claude = os.path.join(self.home, ".claude.json")
        with open(self.claude, "w") as f:
            json.dump({"numStartups": 3, "mcpServers": {"harbor": {"type": "stdio", "command": "node", "args": ["a.mjs"], "env": {"TOKEN": "t"}}}}, f)
        self.codex = os.path.join(self.home, ".codex", "config.toml")
        with open(self.codex, "w") as f:
            f.write(CODEX)
        self.opencode = os.path.join(self.home, ".config", "opencode", "opencode.json")
        with open(self.opencode, "w") as f:
            json.dump({"$schema": "https://opencode.ai/config.json", "model": "zai/glm"}, f)
        self.gemini = os.path.join(self.home, ".gemini", "settings.json")
        os.makedirs(os.path.dirname(self.gemini))
        with open(self.gemini, "w") as f:
            json.dump({"theme": "Default"}, f)

    def test_gemini_cli_from_its_adapter_alone(self):
        """Gemini CLI's MCP servers come from engines/gemini.py only: listed, added in its own shape, copied out of it."""
        settings = self.gemini
        with open(settings, "w") as f:
            json.dump({"theme": "Default", "mcp": {"excluded": ["old"]}, "mcpServers": {
                "fetch": {"command": "uvx", "args": ["mcp-server-fetch"], "env": {"KEY": "k"}},
                "old": {"url": "https://old.example/sse", "headers": {"Authorization": "Bearer ${OLD_TOKEN}"}}}}, f)
        rows = {s["name"]: s for s in M.listing()["servers"] if s["engine"] == "gemini"}
        self.assertEqual((rows["fetch"]["transport"], rows["fetch"]["env"], rows["fetch"]["enabled"]), ("stdio", ["KEY"], True))
        self.assertEqual((rows["old"]["transport"], rows["old"]["enabled"]), ("sse", False))
        r = M.change("higgsfield", M.preset_spec("higgsfield"), ["gemini"])
        self.assertEqual([c["engine"] for c in r["changed"]], ["gemini"])
        d = json.load(open(settings))
        self.assertEqual((d["theme"], d["mcpServers"]["higgsfield"]), ("Default", {"httpUrl": "https://mcp.higgsfield.ai/mcp"}))
        self.assertIn("/mcp auth higgsfield", M.signin_of("higgsfield")["gemini"])
        spec = M.spec_from("gemini", "old")
        self.assertEqual((spec["url"], spec["transport"], spec["header_env"], spec["header_prefix"]),
                         ("https://old.example/sse", "sse", {"Authorization": "OLD_TOKEN"}, {"Authorization": "Bearer "}))
        M.change("fetch", M.spec_from("gemini", "fetch"), ["claude-code"])
        self.assertEqual(json.load(open(self.claude))["mcpServers"]["fetch"]["env"], {"KEY": "k"})

    def test_one_list_over_three_engines_without_values(self):
        r = M.listing()
        self.assertEqual(r["schema"], 1)
        self.assertEqual({(s["engine"], s["name"]) for s in r["servers"]},
                         {("claude-code", "harbor"), ("codex", "node_repl"), ("codex", "history")})
        text = json.dumps(r)
        self.assertNotIn("s3cr3t", text)
        self.assertNotIn('"t"', text)
        node = next(s for s in r["servers"] if s["name"] == "node_repl")
        self.assertEqual((node["transport"], node["env"], node["enabled"]), ("stdio", ["SECRET_TOKEN"], True))
        self.assertEqual([n["name"] for n in r["names"]], ["harbor", "history", "node_repl"])

    def test_fallback_toml_reader_matches_tomllib(self):
        real = CX.mcp_servers(CODEX)
        with patch.dict(sys.modules, {"tomllib": None}):
            fallback = CX.mcp_servers(CODEX)
        self.assertEqual(fallback, real)

    def test_add_and_remove_in_every_engine_with_backups(self):
        spec = {"url": "", "transport": "http", "command": "npx", "args": ["-y", "@x/server"], "env": {"API_KEY": "k"}, "headers": {}}
        r = M.change("demo-srv", spec, list(M.ENGINES))
        self.assertEqual(sorted(c["engine"] for c in r["changed"]), sorted(M.ENGINES), r)
        for c in r["changed"]:
            self.assertTrue(os.path.isfile(c["backup"]), c)
        claude = json.load(open(self.claude))
        self.assertEqual(claude["numStartups"], 3)  # the rest of the file stays
        self.assertEqual(claude["mcpServers"]["demo-srv"], {"type": "stdio", "command": "npx", "args": ["-y", "@x/server"], "env": {"API_KEY": "k"}})
        toml = open(self.codex).read()
        self.assertIn("[mcp_servers.demo-srv]\ncommand = \"npx\"\nargs = [\"-y\", \"@x/server\"]\n[mcp_servers.demo-srv.env]\nAPI_KEY = \"k\"", toml)
        self.assertTrue(toml.startswith(CODEX.rstrip("\n")))
        self.assertEqual(CX.mcp_servers(toml)["demo-srv"]["env"], {"API_KEY": "k"})
        oc = json.load(open(self.opencode))
        self.assertEqual(oc["mcp"]["demo-srv"], {"type": "local", "command": ["npx", "-y", "@x/server"], "enabled": True, "environment": {"API_KEY": "k"}})
        self.assertEqual(oc["model"], "zai/glm")
        again = M.change("demo-srv", spec, ["codex"])
        self.assertEqual(again["changed"], [])
        self.assertIn("--replace", again["skipped"][0]["reason"])
        gone = M.change("demo-srv", None, list(M.ENGINES))
        self.assertEqual(len(gone["changed"]), len(M.ENGINES))
        self.assertEqual(json.load(open(self.gemini)), {"theme": "Default", "mcpServers": {}})
        self.assertEqual(open(self.codex).read().rstrip("\n"), CODEX.rstrip("\n"))
        self.assertNotIn("demo-srv", json.load(open(self.claude))["mcpServers"])

    def test_removing_a_codex_server_keeps_the_next_tables_comment_and_array_tables(self):
        M.change("node_repl", None, ["codex"])
        toml = open(self.codex).read()
        self.assertNotIn("node_repl", toml)
        self.assertNotIn("SECRET_TOKEN", toml)
        self.assertIn("# Compatibility for the history client.\n[mcp_servers.history]", toml)
        self.assertIn("[[skills.config]]\npath = \"/x/SKILL.md\"", toml)
        M.change("history", None, ["codex"])
        self.assertIn("[[skills.config]]", open(self.codex).read())
        self.assertEqual(set(CX.mcp_servers(open(self.codex).read())), set())

    def test_remote_server_and_opencode_with_comments(self):
        spec = {"url": "https://mcp.example.com", "transport": "http", "command": "", "args": [], "env": {}, "headers": {"Authorization": "Bearer x"}}
        with open(self.opencode, "w") as f:
            f.write('{\n  // mine\n  "model": "zai/glm"\n}\n')
        r = M.change("remote", spec, list(M.ENGINES))
        self.assertEqual(sorted(c["engine"] for c in r["changed"]), ["claude-code", "codex", "gemini"])
        self.assertIn("comments", r["skipped"][0]["reason"])
        self.assertEqual(json.load(open(self.gemini))["mcpServers"]["remote"], {"httpUrl": "https://mcp.example.com", "headers": {"Authorization": "Bearer x"}})
        self.assertIn('// mine', open(self.opencode).read())
        self.assertIn('url = "https://mcp.example.com"\nhttp_headers = { Authorization = "Bearer x" }', open(self.codex).read())
        self.assertEqual(json.load(open(self.claude))["mcpServers"]["remote"], {"type": "http", "url": "https://mcp.example.com", "headers": {"Authorization": "Bearer x"}})
        row = next(s for s in M.listing()["servers"] if s["name"] == "remote" and s["engine"] == "codex")
        self.assertEqual((row["transport"], row["headers"]), ("http", ["Authorization"]))

    def test_copy_from_an_engine_carries_env_and_headers_without_printing_them(self):
        r = M.change("node_repl", M.spec_from("codex", "node_repl"), ["claude-code", "opencode"])
        self.assertEqual(len(r["changed"]), 2, r)
        self.assertNotIn("s3cr3t", json.dumps(r))
        self.assertEqual(json.load(open(self.claude))["mcpServers"]["node_repl"]["env"], {"SECRET_TOKEN": "s3cr3t"})
        self.assertEqual(json.load(open(self.opencode))["mcp"]["node_repl"]["environment"], {"SECRET_TOKEN": "s3cr3t"})
        # a header that names an environment variable stays a reference, in each engine's own syntax
        claude = json.load(open(self.claude))
        claude["mcpServers"]["api"] = {"type": "http", "url": "https://api.example.com/mcp",
                                       "headers": {"Authorization": "Bearer ${API_TOKEN}", "X-Team": "blue", "X-Key": "${TEAM_KEY}"}}
        with open(self.claude, "w") as f:
            json.dump(claude, f)
        r = M.change("api", M.spec_from("claude-code", "api"), ["codex", "opencode"])
        self.assertEqual(len(r["changed"]), 2, r)
        api = CX.mcp_servers(open(self.codex).read())["api"]
        self.assertEqual((api["bearer_token_env_var"], api["http_headers"], api["env_http_headers"]),
                         ("API_TOKEN", {"X-Team": "blue"}, {"X-Key": "TEAM_KEY"}))
        self.assertEqual(json.load(open(self.opencode))["mcp"]["api"]["headers"],
                         {"X-Team": "blue", "Authorization": "Bearer {env:API_TOKEN}", "X-Key": "{env:TEAM_KEY}"})
        back = M.spec_from("codex", "api")
        self.assertEqual(M.json_entry(back)["headers"], {"X-Team": "blue", "X-Key": "${TEAM_KEY}", "Authorization": "Bearer ${API_TOKEN}"})
        with self.assertRaisesRegex(ValueError, "not configured"):
            M.spec_from("opencode", "nope")

    def test_cli_copy_from(self):
        env = dict(os.environ, HOME=self.home, PYTHONDONTWRITEBYTECODE="1")
        out = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "add", "node_repl", "--from", "codex", "--engine", "opencode", "--json"],
                             capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
        self.assertNotIn("s3cr3t", out.stdout + out.stderr)
        self.assertEqual(json.load(open(self.opencode))["mcp"]["node_repl"]["environment"]["SECRET_TOKEN"], "s3cr3t")

    def test_a_test_instance_without_a_fixture_home_never_touches_the_real_files(self):
        root = os.path.join(self.home, "instance")
        os.makedirs(root)
        real = self.home
        import customizations
        with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": root}), patch.object(customizations.D, "HOME", "/Users/someone"), \
             patch.object(M, "home", return_value="/Users/someone"):
            p = M.paths()
        scratch = os.path.join(root, "customizations-home")
        self.assertEqual(p["claude-code"], os.path.join(scratch, ".claude.json"))
        self.assertTrue(p["codex"].startswith(scratch) and p["opencode"].startswith(scratch), p)
        # an instance whose HOME is its own fixture: the normal paths, which are inside it
        import customizations
        with patch.dict(os.environ, {"DISPATCH_SESSION_ROOT": real}), patch.object(customizations.D, "HOME", self.home):
            self.assertIsNone(M.instance_home())
            self.assertEqual(M.paths()["claude-code"], self.claude)

    def test_cli_parses_the_command_after_double_dash(self):
        env = dict(os.environ, HOME=self.home, PYTHONDONTWRITEBYTECODE="1")
        out = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "add", "cli-srv", "--engine", "codex", "--json", "--", "npx", "-y", "pkg"],
                             capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
        self.assertEqual(json.loads(out.stdout)["changed"][0]["engine"], "codex")
        self.assertEqual(CX.mcp_servers(open(self.codex).read())["cli-srv"]["args"], ["-y", "pkg"])
        bad = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "add", "x", "--json"],
                             capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(bad.returncode, 2)
        self.assertIn("--url", json.loads(bad.stdout)["message"])

    def test_a_preset_needs_no_url_and_says_how_to_sign_in(self):
        env = dict(os.environ, HOME=self.home, PYTHONDONTWRITEBYTECODE="1")
        out = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "add", "higgsfield", "--json"],
                             capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
        r = json.loads(out.stdout)
        self.assertEqual(sorted(c["engine"] for c in r["changed"]), ["claude-code", "codex", "gemini", "opencode"])
        self.assertEqual(r["signin"]["codex"], "codex mcp login higgsfield")
        self.assertEqual(json.load(open(self.claude))["mcpServers"]["higgsfield"]["url"], "https://mcp.higgsfield.ai/mcp")
        self.assertEqual(CX.mcp_servers(open(self.codex).read())["higgsfield"]["url"], "https://mcp.higgsfield.ai/mcp")
        self.assertEqual(json.load(open(self.opencode))["mcp"]["higgsfield"]["url"], "https://mcp.higgsfield.ai/mcp")
        listed = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "mcp", "presets"], capture_output=True, text=True, env=env, timeout=60)
        self.assertIn("higgsfield: Higgsfield", listed.stdout)


if __name__ == "__main__":
    unittest.main()


def rd(path):
    with open(path) as f:
        return f.read()


class ProjectTools(unittest.TestCase):
    """One project's switches (task-gsmh): each engine's own per-project place, other projects untouched."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = os.path.realpath(self.tmp.name)
        env = {"HOME": self.home, "CODEX_HOME": os.path.join(self.home, ".codex"),
               "XDG_CONFIG_HOME": os.path.join(self.home, ".config"), "CLAUDE_CONFIG_DIR": ""}
        p = patch.dict(os.environ, env)
        p.start(); self.addCleanup(p.stop)
        os.environ.pop("DISPATCH_SESSION_ROOT", None)
        self.proj = os.path.join(self.home, "Projects", "shop")
        os.makedirs(self.proj)
        os.makedirs(os.path.join(self.home, ".codex"))
        os.makedirs(os.path.join(self.home, ".config", "opencode"))
        self.write(".claude.json", {"mcpServers": {"github": {"type": "stdio", "command": "npx", "args": ["gh"]}},
                                    "projects": {"/elsewhere": {"disabledMcpServers": ["github"]}}})
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as f:
            f.write('[mcp_servers.github]\ncommand = "npx"\nargs = ["gh"]\n\n[projects."%s"]\ntrust_level = "trusted"\n' % self.proj)
        self.write(".config/opencode/opencode.json", {"mcp": {"github": {"type": "local", "command": ["npx", "gh"], "enabled": True}}})
        with open(os.path.join(self.proj, ".mcp.json"), "w") as f:
            json.dump({"mcpServers": {"db": {"command": "db-mcp"}}}, f)
        os.makedirs(os.path.join(self.proj, ".cursor"))
        with open(os.path.join(self.proj, ".cursor", "mcp.json"), "w") as f:
            json.dump({"mcpServers": {"figma": {"url": "https://figma.example/mcp"}}}, f)

    def write(self, rel, data):
        path = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f)

    def tool(self, name):
        return next(t for t in M.project_tools(self.proj)["tools"] if t["name"] == name)

    def test_lists_what_each_agent_gets_here(self):
        r = M.project_tools(self.proj)
        self.assertTrue(r["codex_trusted"])
        self.assertEqual([t["name"] for t in r["tools"]], ["db", "github", "figma"])
        gh = self.tool("github")
        self.assertEqual(gh["from"], "everyone")
        self.assertEqual({e: v["state"] for e, v in gh["engines"].items()}, {"claude-code": "on", "codex": "on", "opencode": "on"})
        db = self.tool("db")
        self.assertEqual(db["from"], "project")
        self.assertEqual(db["engines"]["claude-code"]["state"], "ask")  # Claude Code asks about .mcp.json the first time
        self.assertFalse(db["engines"]["codex"]["has"])
        figma = self.tool("figma")
        self.assertEqual(figma["from"], "cursor")
        self.assertFalse(any(v["has"] for v in figma["engines"].values()))

    def test_off_and_on_in_this_project_only(self):
        for engine in ("claude-code", "codex", "opencode"):
            M.set_project_tool(self.proj, "github", engine, False)
        gh = self.tool("github")
        self.assertEqual({e: v["on"] for e, v in gh["engines"].items()}, {"claude-code": False, "codex": False, "opencode": False})
        claude = json.loads(rd(os.path.join(self.home, ".claude.json")))
        self.assertEqual(claude["projects"][self.proj]["disabledMcpServers"], ["github"])
        self.assertEqual(claude["projects"]["/elsewhere"], {"disabledMcpServers": ["github"]})
        self.assertIn("enabled = false", rd(os.path.join(self.proj, ".codex", "config.toml")))
        self.assertEqual(json.loads(rd(os.path.join(self.proj, "opencode.json")))["mcp"], {"github": {"enabled": False}})
        # the user's own files keep the server on everywhere else
        self.assertNotIn("enabled", rd(os.path.join(self.home, ".codex", "config.toml")))
        for engine in ("claude-code", "codex", "opencode"):
            M.set_project_tool(self.proj, "github", engine, True)
        gh = self.tool("github")
        self.assertTrue(all(v["on"] for v in gh["engines"].values()))
        # nothing of ours is left in the folder once everything is as the user had it
        self.assertFalse(os.path.exists(os.path.join(self.proj, ".codex", "config.toml")))
        self.assertNotIn("mcp", json.loads(rd(os.path.join(self.proj, "opencode.json"))))

    def test_mcp_json_server_is_approved_or_refused_like_claude_does(self):
        M.set_project_tool(self.proj, "db", "claude-code", True)
        self.assertEqual(self.tool("db")["engines"]["claude-code"]["state"], "on")
        M.set_project_tool(self.proj, "db", "claude-code", False)
        proj = json.loads(rd(os.path.join(self.home, ".claude.json")))["projects"][self.proj]
        self.assertEqual((proj["enabledMcpjsonServers"], proj["disabledMcpjsonServers"]), ([], ["db"]))

    def test_codex_keeps_the_rest_of_the_project_file_and_says_when_untrusted(self):
        os.makedirs(os.path.join(self.proj, ".codex"))
        with open(os.path.join(self.proj, ".codex", "config.toml"), "w") as f:
            f.write('model = "o3"\n\n[mcp_servers.github]\nenabled = true\n')
        M.set_project_tool(self.proj, "github", "codex", False)
        text = rd(os.path.join(self.proj, ".codex", "config.toml"))
        self.assertTrue(text.startswith('model = "o3"'))
        self.assertEqual(text.count("enabled"), 1)
        with open(os.path.join(self.home, ".codex", "config.toml"), "w") as f:
            f.write('[mcp_servers.github]\ncommand = "npx"\n')
        r = M.set_project_tool(self.proj, "github", "codex", True)
        self.assertIn("trusts this folder", r["note"])
        self.assertEqual(rd(os.path.join(self.proj, ".codex", "config.toml")).strip(), 'model = "o3"')

    def test_refuses_what_is_not_set_up(self):
        with self.assertRaises(ValueError):
            M.set_project_tool(self.proj, "figma", "claude-code", False)
        with self.assertRaises(ValueError):
            M.set_project_tool(self.proj, "db", "codex", False)
        with self.assertRaises(ValueError):
            M.set_project_tool(self.proj, "github", "cursor", False)
