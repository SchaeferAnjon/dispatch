# -*- coding: utf-8 -*-
import unittest
from unittest.mock import patch

import os
import dplatform as P
from remote_screen import endpoint_from_config, tailscale_cli

WINDOWS_READY = True


def serve_config(proxy="http://127.0.0.1:6080", port=443):
    return {"TCP": {str(port): {"HTTPS": True}}, "Web": {
        f"mac.example.ts.net:{port}": {"Handlers": {"/": {"Proxy": proxy}}}}}


class SecureScreenEndpoint(unittest.TestCase):
    def test_loopback_proxy_uses_https_and_alternate_port(self):
        self.assertEqual(endpoint_from_config(serve_config(port=8443)),
                         "https://mac.example.ts.net:8443/vnc.html?autoconnect=1&resize=scale&show_dot=1")

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
        with patch.object(P, "IS_WIN", False), patch("remote_screen.shutil.which", return_value="/bad/tailscale"), \
                patch("remote_screen.subprocess.run", side_effect=[
                    subprocess.CompletedProcess([], 1, "", "GUI failed"),
                    subprocess.CompletedProcess([], 0, "{}", "")]):
            self.assertEqual(tailscale_cli()[0], "/opt/homebrew/bin/tailscale")


class WindowsTailscale(unittest.TestCase):
    def test_program_files_install_is_found(self):
        import subprocess
        with patch.object(P, "IS_WIN", True), patch.dict(os.environ, {"ProgramFiles": "C:\\Program Files"}), \
                patch("remote_screen.shutil.which", return_value=None), \
                patch("remote_screen.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "{}", "")) as run:
            self.assertEqual(tailscale_cli()[0], os.path.join("C:\\Program Files", "Tailscale", "tailscale.exe"))
        self.assertEqual(run.call_args.kwargs["creationflags"], P.CREATE_NO_WINDOW)


if __name__ == "__main__":
    unittest.main()
