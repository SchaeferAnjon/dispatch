import unittest
from unittest.mock import patch

from remote_screen import endpoint_from_config, tailscale_cli


def serve_config(proxy="http://127.0.0.1:6080", port=443):
    return {"TCP": {str(port): {"HTTPS": True}}, "Web": {
        f"mac.example.ts.net:{port}": {"Handlers": {"/": {"Proxy": proxy}}}}}


class SecureScreenEndpoint(unittest.TestCase):
    def test_loopback_proxy_uses_https_and_alternate_port(self):
        self.assertEqual(endpoint_from_config(serve_config(port=8443)),
                         "https://mac.example.ts.net:8443/vnc.html?autoconnect=1&resize=scale")

    def test_existing_tailnet_binding_supported_during_upgrade(self):
        config = serve_config("http://100.64.0.1:6080")
        self.assertTrue(endpoint_from_config(config, "100.64.0.1").startswith("https://"))
        self.assertEqual(endpoint_from_config(config, "100.64.0.2"), "")

    def test_http_only_and_unrelated_service_not_advertised(self):
        config = serve_config()
        config["TCP"]["443"] = {"HTTP": True}
        self.assertEqual(endpoint_from_config(config), "")
        self.assertEqual(endpoint_from_config(serve_config("http://127.0.0.1:7799")), "")
        self.assertEqual(endpoint_from_config({}), "")

    def test_subpath_is_not_mistaken_for_root_proxy(self):
        config = serve_config()
        handlers = config["Web"]["mac.example.ts.net:443"]["Handlers"]
        handlers["/screen"] = handlers.pop("/")
        self.assertEqual(endpoint_from_config(config), "")

    def test_cli_falls_back_when_installed_gui_cannot_reach_daemon(self):
        import subprocess
        with patch("remote_screen.shutil.which", return_value="/bad/tailscale"), \
                patch("remote_screen.subprocess.run", side_effect=[
                    subprocess.CompletedProcess([], 1, "", "GUI failed"),
                    subprocess.CompletedProcess([], 0, "{}", "")]):
            self.assertEqual(tailscale_cli()[0], "/opt/homebrew/bin/tailscale")
