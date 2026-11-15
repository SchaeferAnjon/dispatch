# -*- coding: utf-8 -*-
"""net.py: this Mac's proxy (macOS settings, PAC, environment, Dispatch's own setting), the reachability check, the
connection-error test chatd and the Agents window retry on, and the Chinese models list. No network is used here: the
check runs with a scripted probe, the proxy tunnel against local sockets."""
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

import net

WINDOWS_READY = True

SCUTIL_CLASH = """<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
    3 : 192.168/16
    4 : *.example.cn
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
"""
SCUTIL_OFF = """<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
"""
SCUTIL_PAC = """<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:33331/pac
}
"""
PAC = """function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, "anthropic.com") || dnsDomainIs(host, "openai.com")) return "PROXY 127.0.0.1:7890; DIRECT";
  if (shExpMatch(host, "*.google.com")) return "SOCKS5 127.0.0.1:7891";
  return "DIRECT";
}"""


def run_out(text, code=0):
    return lambda argv, **kw: SimpleNamespace(returncode=code, stdout=text, stderr="")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.tmp.name})
        p.start()
        self.addCleanup(p.stop)
        net._memo.clear()
        net._pac_cache.clear()

    def sysp(self, text):
        return net.system_proxy(run=run_out(text))


class ScutilParsing(Base):
    def test_reads_web_socks_and_exceptions(self):
        sp = self.sysp(SCUTIL_CLASH)
        self.assertEqual(sp["https"], "http://127.0.0.1:7890")
        self.assertEqual(sp["http"], "http://127.0.0.1:7890")
        self.assertEqual(sp["socks"], "socks5h://127.0.0.1:7891")
        self.assertEqual(sp["pac"], "")
        self.assertEqual(sp["exceptions"], ["127.0.0.1", "localhost", "*.local", "192.168/16", "*.example.cn"])
        self.assertTrue(sp["simple_direct"])

    def test_everything_off(self):
        sp = self.sysp(SCUTIL_OFF)
        self.assertEqual((sp["http"], sp["https"], sp["socks"], sp["pac"]), ("", "", "", ""))

    def test_pac_address(self):
        self.assertEqual(self.sysp(SCUTIL_PAC)["pac"], "http://127.0.0.1:33331/pac")

    def test_scutil_failing_reads_as_no_proxy(self):
        def boom(argv, **kw):
            raise OSError("no scutil")
        sp = net.system_proxy(run=boom)
        self.assertEqual(sp["https"], "")

    def test_exception_entries_for_no_proxy(self):
        self.assertEqual(net.no_proxy_entry("*.local"), ".local")
        self.assertEqual(net.no_proxy_entry("192.168/16"), "192.168.0.0/16")
        self.assertEqual(net.no_proxy_entry("example.com"), "example.com")
        self.assertEqual(net.no_proxy_entry("*"), "")


class Resolve(Base):
    def test_system_web_proxy_goes_to_every_engine_variable(self):
        r = net.resolve(env={}, cfg={"proxy": "auto"}, sysproxy=self.sysp(SCUTIL_CLASH))
        self.assertEqual(r["source"], "system")
        self.assertEqual(r["proxy"], "http://127.0.0.1:7890")
        for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"):
            self.assertEqual(r["env_set"][k], "http://127.0.0.1:7890")
        no = r["env_set"]["NO_PROXY"].split(",")
        self.assertIn(".local", no)
        self.assertIn(".example.cn", no)
        self.assertIn("192.168.0.0/16", no)
        self.assertFalse(r["socks_only"])

    def test_socks_only_sets_all_proxy_and_says_so(self):
        only_socks = SCUTIL_CLASH.replace("HTTPEnable : 1", "HTTPEnable : 0").replace("HTTPSEnable : 1", "HTTPSEnable : 0")
        r = net.resolve(env={}, cfg={"proxy": "auto"}, sysproxy=self.sysp(only_socks))
        self.assertTrue(r["socks_only"])
        self.assertEqual(r["env_set"]["ALL_PROXY"], "socks5h://127.0.0.1:7891")
        self.assertNotIn("HTTPS_PROXY", r["env_set"])
        self.assertIn("HTTPS_PROXY", r["env_unset"])
        self.assertIn("Claude Code and OpenCode", r["note"])

    def test_no_proxy_anywhere(self):
        r = net.resolve(env={}, cfg={"proxy": "auto"}, sysproxy=self.sysp(SCUTIL_OFF))
        self.assertEqual((r["source"], r["proxy"], r["env_set"]), ("none", "", {}))

    def test_a_shell_proxy_is_kept_as_it_is(self):
        env = {"HTTPS_PROXY": "http://10.0.0.2:3128", "NO_PROXY": "api.openai.com"}
        r = net.resolve(env=env, cfg={"proxy": "auto"}, sysproxy=self.sysp(SCUTIL_CLASH))
        self.assertEqual(r["source"], "environment")
        self.assertEqual(r["env_set"], {})
        self.assertEqual(r["per_host"]["api.anthropic.com"], "http://10.0.0.2:3128")
        self.assertEqual(r["per_host"]["api.openai.com"], "")

    def test_off_removes_inherited_variables(self):
        env = {"HTTPS_PROXY": "http://x:1", "https_proxy": "http://x:1", "ALL_PROXY": "socks5://x:2", "PATH": "/bin"}
        r = net.resolve(env=env, cfg={"proxy": "off"})
        self.assertEqual(r["source"], "off")
        out = net.apply(dict(env), r)
        self.assertEqual(out, {"PATH": "/bin"})

    def test_custom_address(self):
        r = net.resolve(env={"HTTPS_PROXY": "http://ignored:1"}, cfg={"proxy": "http://10.1.1.1:8080"})
        self.assertEqual(r["source"], "custom")
        self.assertEqual(r["env_set"]["HTTPS_PROXY"], "http://10.1.1.1:8080")

    def test_pac_runs_for_the_engine_servers(self):
        answers = {"api.anthropic.com": "PROXY 127.0.0.1:7890; DIRECT", "api.openai.com": "PROXY 127.0.0.1:7890",
                   "open.bigmodel.cn": "DIRECT", "api.deepseek.com": "DIRECT"}
        r = net.resolve(env={}, cfg={"proxy": "auto"}, sysproxy=self.sysp(SCUTIL_PAC), fetch=lambda url: PAC,
                        run_pac_fn=lambda script, hosts: {h: answers.get(h, "DIRECT") for h in hosts})
        self.assertEqual(r["source"], "system-pac")
        self.assertEqual(r["proxy"], "http://127.0.0.1:7890")
        self.assertEqual(r["per_host"]["registry.npmjs.org"], "")
        self.assertEqual(r["per_host"]["api.openai.com"], "http://127.0.0.1:7890")
        # Chinese model servers the PAC sends direct go direct for the engines too
        self.assertIn("open.bigmodel.cn", r["no_proxy"].split(","))
        self.assertIn("api.deepseek.com", r["no_proxy"].split(","))

    def test_unreadable_pac_means_direct_with_a_note(self):
        r = net.resolve(env={}, cfg={"proxy": "auto"}, sysproxy=self.sysp(SCUTIL_PAC), fetch=lambda url: "")
        self.assertEqual(r["proxy"], "")
        self.assertIn("could not be read", r["note"])

    def test_apply_never_raises(self):
        with mock.patch.object(net, "current", side_effect=RuntimeError("x")):
            self.assertEqual(net.apply({"A": "1"}), {"A": "1"})


class Pac(Base):
    def test_entries(self):
        self.assertEqual(net.pac_entry("PROXY 127.0.0.1:7890; DIRECT"), "http://127.0.0.1:7890")
        self.assertEqual(net.pac_entry("SOCKS5 127.0.0.1:7891"), "socks5h://127.0.0.1:7891")
        self.assertEqual(net.pac_entry("SOCKS 10.0.0.1:1080"), "socks5h://10.0.0.1:1080")
        self.assertEqual(net.pac_entry("HTTPS proxy.corp:443"), "https://proxy.corp:443")
        self.assertEqual(net.pac_entry("DIRECT"), "")
        self.assertEqual(net.pac_entry(""), "")

    def test_fallback_when_javascript_is_not_there(self):
        def boom(argv, **kw):
            raise OSError("no osascript")
        out = net.run_pac(PAC, ["api.anthropic.com", "x.cn"], run=boom)
        self.assertEqual(out["api.anthropic.com"], "PROXY 127.0.0.1:7890")

    @unittest.skipUnless(sys.platform == "darwin", "macOS runs PAC files with osascript")
    def test_runs_the_file_with_macos_javascript(self):
        out = net.run_pac(PAC, ["api.anthropic.com", "www.google.com", "open.bigmodel.cn"], resolve=lambda hosts: {})
        self.assertEqual(net.pac_entry(out["api.anthropic.com"]), "http://127.0.0.1:7890")
        self.assertEqual(net.pac_entry(out["www.google.com"]), "socks5h://127.0.0.1:7891")
        self.assertEqual(net.pac_entry(out["open.bigmodel.cn"]), "")

    def test_pac_file_address(self):
        with open(os.path.join(self.tmp.name, "p.pac"), "w") as f:
            f.write(PAC)
        url = "file://" + os.path.join(self.tmp.name, "p.pac")
        self.assertTrue(net.is_pac_address(url))
        self.assertTrue(net.is_pac_address("http://127.0.0.1:33331/proxy.pac"))
        self.assertFalse(net.is_pac_address("http://127.0.0.1:7890"))
        self.assertEqual(net.fetch_pac(url), PAC)


class Settings(Base):
    def test_defaults_and_saving(self):
        self.assertEqual(net.load(), {"proxy": "auto", "mirror": "auto"})
        net.save(proxy="127.0.0.1:7890")
        self.assertEqual(net.load()["proxy"], "http://127.0.0.1:7890")
        net.save(proxy="socks5://127.0.0.1:7891", mirror="china")
        self.assertEqual(net.load(), {"proxy": "socks5://127.0.0.1:7891", "mirror": "china"})
        net.save(proxy="off")
        self.assertEqual(net.load()["proxy"], "off")

    def test_bad_values_are_refused(self):
        for bad in ("ftp://x:1", "http://nohost", "nonsense words"):
            with self.assertRaises(ValueError):
                net.save(proxy=bad)
        with self.assertRaises(ValueError):
            net.save(mirror="moon")
        self.assertEqual(net.load()["proxy"], "auto")

    def test_password_never_shown(self):
        self.assertEqual(net._safe_address("http://me:secret@10.0.0.1:3128"), "http://10.0.0.1:3128")


class NetworkErrors(unittest.TestCase):
    def test_connection_errors_of_each_engine(self):
        for text in ("API Error: Connection error.", "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
                     "Unable to connect. Is the computer able to access the url?", "read ECONNRESET", "connect ETIMEDOUT 104.18.1.1:443",
                     "getaddrinfo ENOTFOUND api.anthropic.com", "socket hang up", "fetch failed", "Request timed out.",
                     "Claude 进程退出了（退出码 1）：Error: Connection error.", "The socket connection was closed unexpectedly",
                     "tunneling socket could not be established, cause=connect ECONNREFUSED 127.0.0.1:9"):
            self.assertTrue(net.is_network_error(text), text)

    def test_other_errors_are_not_retried(self):
        for text in ("", None, "API Error: 401 invalid x-api-key", "Invalid API key · Please run /login", "API Error: 529 Overloaded",
                     "rate limit exceeded", "Prompt is too long", "403 Forbidden: Request not allowed", "the model refused"):
            self.assertFalse(net.is_network_error(text), text)


class Check(Base):
    def resolved(self):
        return {"source": "custom", "proxy": "http://127.0.0.1:9", "per_host": {t["host"]: "http://127.0.0.1:9" for t in net.TARGETS.values()}}

    def test_results_are_cached_per_proxy(self):
        calls = []

        def probe(host, path, via):
            calls.append((host, via))
            return {"ok": host != "api.anthropic.com", "status": 200, "ms": 1, "why": "" if host != "api.anthropic.com" else "refused"}
        r = self.resolved()
        c1 = net.check(probe_fn=probe, resolved=r, now=1000)
        self.assertFalse(c1["results"]["anthropic"]["ok"])
        self.assertTrue(c1["results"]["openai"]["ok"])
        self.assertEqual(len(calls), len(net.TARGETS))
        net.check(probe_fn=probe, resolved=r, now=1100)
        self.assertEqual(len(calls), len(net.TARGETS))  # cached
        net.check(probe_fn=probe, resolved=dict(r, proxy="", per_host={}), now=1100)
        self.assertEqual(len(calls), 2 * len(net.TARGETS))  # another proxy: asked again
        self.assertEqual(net.blocked(now=1200), {"anthropic": True, "openai": False})

    def test_blocked_reads_only_the_cache(self):
        self.assertEqual(net.blocked(), {"anthropic": None, "openai": None})
        net.check(probe_fn=lambda h, p, v: {"ok": False, "status": 0, "ms": 0, "why": "timed out"}, resolved=self.resolved(), now=1000)
        self.assertEqual(net.blocked(now=1001), {"anthropic": True, "openai": True})

    def test_region_answer_counts_as_not_reachable(self):
        body = b'HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{"error":{"type":"forbidden","message":"Request not allowed"}}'
        self.assertFalse(net.interpret(body)["ok"])
        self.assertIn("region", net.interpret(body)["why"])
        self.assertTrue(net.interpret(b"HTTP/1.1 401 Unauthorized\r\n\r\n{}")["ok"])
        self.assertTrue(net.interpret(b"HTTP/2 404 Not Found\r\n\r\n")["ok"])
        self.assertFalse(net.interpret(b"")["ok"])

    def test_recommend(self):
        self.assertEqual(net.recommend({"anthropic": True, "openai": True}, ["claude", "codex"]), "opencode")
        self.assertEqual(net.recommend({"anthropic": True, "openai": False}, ["claude", "codex"]), "")
        self.assertEqual(net.recommend({"anthropic": True, "openai": False}, ["claude"]), "opencode")
        self.assertEqual(net.recommend({"anthropic": None, "openai": None}, ["claude"]), "")
        self.assertEqual(net.recommend({"anthropic": True, "openai": True}, []), "opencode")


class NpmMirrorForEngines(Base):
    """`dispatch net env` also tells the Agents window's engines npm's registry when downloads go to the mirrors in
    China: OpenCode installs plugins and language servers from npm itself (task-lj06.13)."""

    def checked(self, npm_ok, now=1000):
        net._write(net.check_path(), {"checked_at": now, "results": {"npm": {"ok": npm_ok}}})

    def test_auto_uses_the_mirror_only_when_the_last_check_found_npm_out_of_reach(self):
        self.assertEqual(net.npm_mirror_env(env={}, now=1000), {})  # never checked: the official registry
        self.checked(True)
        self.assertEqual(net.npm_mirror_env(env={}, now=1001), {})
        self.checked(False)
        self.assertEqual(net.npm_mirror_env(env={}, now=1001), {"npm_config_registry": "https://registry.npmmirror.com"})
        self.assertEqual(net.npm_mirror_env(env={}, now=1000 + 25 * 3600), {})  # a day later that is not known any more

    def test_the_setting_decides_when_set(self):
        self.checked(False)
        net.save(mirror="official")
        self.assertEqual(net.npm_mirror_env(env={}, now=1001), {})
        net.save(mirror="china")
        self.assertEqual(net.npm_mirror_env(env={}, now=1001), {"npm_config_registry": "https://registry.npmmirror.com"})

    def test_a_registry_the_person_set_stays(self):
        net.save(mirror="china")
        self.assertEqual(net.npm_mirror_env(env={"npm_config_registry": "https://npm.example.com"}), {})
        self.assertEqual(net.npm_mirror_env(env={"NPM_CONFIG_REGISTRY": "https://npm.example.com"}), {})

    def test_net_env_carries_it_next_to_the_proxy(self):
        net.save(mirror="china")
        with mock.patch.object(net, "current", return_value={"env_set": {"HTTPS_PROXY": "http://127.0.0.1:7890"}, "env_unset": [], "source": "custom", "proxy": "http://127.0.0.1:7890"}):
            out = net.env_for_host(env={})
        self.assertEqual(out["set"], {"HTTPS_PROXY": "http://127.0.0.1:7890", "npm_config_registry": "https://registry.npmmirror.com"})


class Tunnel(unittest.TestCase):
    """The probe's way through a proxy, against local sockets."""

    def serve(self, answer):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        self.addCleanup(srv.close)
        got = []

        def run():
            try:
                c, _ = srv.accept()
                got.append(c.recv(4096))
                c.sendall(answer)
                c.close()
            except OSError:
                pass
        threading.Thread(target=run, daemon=True).start()
        return srv.getsockname()[1], got

    def test_http_proxy_refusing_connect(self):
        port, got = self.serve(b"HTTP/1.1 403 Forbidden\r\n\r\n")
        res = net.probe("api.anthropic.com", "/v1/models", f"http://127.0.0.1:{port}", timeout=3)
        self.assertFalse(res["ok"])
        self.assertIn("403", res["why"])
        self.assertTrue(got and got[0].startswith(b"CONNECT api.anthropic.com:443 HTTP/1.1"))

    def test_dead_proxy(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        res = net.probe("api.anthropic.com", "/", f"http://127.0.0.1:{port}", timeout=2)
        self.assertFalse(res["ok"])

    def test_socks5_handshake(self):
        port, got = self.serve(b"\x05\xff")  # no acceptable method
        res = net.probe("api.openai.com", "/", f"socks5h://127.0.0.1:{port}", timeout=3)
        self.assertFalse(res["ok"])
        self.assertEqual(got[0], b"\x05\x01\x00")


class ChinaModels(Base):
    def test_ready_when_opencode_has_a_key(self):
        fake = SimpleNamespace(providers=lambda env=None: [{"id": "zhipuai-coding-plan", "name": "Zhipu", "sources": []}])
        with mock.patch.dict(sys.modules, {"opencode_engine": fake}):
            rows = {m["id"]: m for m in net.china_models()}
        self.assertTrue(rows["zhipu"]["ready"])
        self.assertEqual(rows["zhipu"]["ready_provider"], "zhipuai-coding-plan")
        self.assertFalse(rows["deepseek"]["ready"])
        for m in rows.values():
            self.assertTrue(m["key_url"].startswith("https://"))
            self.assertNotRegex(json.dumps(m), r"sk-[A-Za-z0-9]{8,}")  # never a key

    def test_status_puts_it_together(self):
        def check(refresh=False, resolved=None, d=None):
            return {"checked_at": 5, "results": {"anthropic": {"ok": False, "why": "timed out", "label": "A"}, "openai": {"ok": False, "why": "x", "label": "O"},
                                                 "npm": {"ok": False, "why": "x", "label": "npm"}}}
        with mock.patch.object(net, "current", return_value={"mode": "auto", "source": "none", "proxy": "", "socks_only": False, "note": ""}):
            s = net.status(check_fn=check, engines_here=["claude", "codex", "opencode"])
        self.assertEqual(s["recommend"], "opencode")
        self.assertEqual(s["blocked"], {"anthropic": True, "openai": True})
        self.assertEqual(s["mirror"]["use"], "china")
        self.assertEqual(len(s["china_models"]), 4)


if __name__ == "__main__":
    unittest.main()
