"""Exercise sign.sh without a certificate, Apple's service, or an Electron build."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


IDENTITY = "Developer ID Application: Test (TEAM)"
TOOL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['SIGN_TEST_ROOT'])
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps([name, *args]) + '\n')
if name == 'fnm' and any(a.endswith('sign.mjs') for a in args):
    (root / 'osx-sign.txt').write_text(os.environ.get('DISPATCH_OSX_SIGN', ''))
if name == 'security':
    print('1) ABC "Developer ID Application: Test (TEAM)"')
elif name == 'codesign' and '--force' in args:
    if os.environ.get('SIGN_TEST_BINARY_FAIL'):
        sys.exit(1)
    with pathlib.Path(args[-1]).open('ab') as f:
        f.write(b'SIGNED')
elif name == 'ditto':
    pathlib.Path(args[-1]).write_bytes(b'zip')
elif name == 'xcrun':
    if args[:2] == ['notarytool', 'submit']:
        # Apple's real submit response acknowledges the upload without a status field.
        print(json.dumps({'id': 'submission-test', 'message': 'Successfully uploaded file'}))
    elif args[:2] == ['notarytool', 'info']:
        if os.environ.get('SIGN_TEST_INFO_FAIL'):
            sys.exit(69)
        print(json.dumps({'id': 'submission-test', 'status': 'In Progress'}))
    elif args[:2] == ['notarytool', 'wait']:
        status = os.environ.get('SIGN_TEST_STATUS', 'Accepted')
        if status == 'timeout':
            sys.exit(69)
        print(json.dumps({'id': 'submission-test', 'status': status}))
    elif args[:2] == ['notarytool', 'log']:
        pathlib.Path(args[-1]).write_text('{"issues": []}')
    elif args[:2] == ['stapler', 'staple'] and os.environ.get('SIGN_TEST_STAPLE_FAIL'):
        sys.exit(1)
'''


class Signing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dispatch-sign-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        shutil.copy2(Path(__file__).with_name("sign.sh"), self.root / "sign.sh")
        (self.root / "vscode").mkdir()
        (self.root / "vscode/.nvmrc").write_text("22")
        (self.root / "vscode/build").mkdir()
        (self.root / "vscode/build/package-lock.json").write_text(json.dumps(
            {"packages": {"node_modules/@electron/osx-sign": {"version": "2.0.0"}}}))
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        # Pin this interpreter; the fixture must not depend on /usr/bin/python3.
        import sys
        for name in ("security", "codesign", "fnm", "ditto", "xcrun", "spctl"):
            p = bin_dir / name
            p.write_text(TOOL.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
            p.chmod(0o755)
        self.app = self.root / "App with spaces.app"
        self.archive = self.app / "Contents/Resources/app/server/dispatch-ide-server-darwin-arm64.tar.gz"
        self.archive.parent.mkdir(parents=True)
        with tarfile.open(self.archive, "w:gz") as tf:
            for name, mode, data in (("server/node", 0o755, b"\xcf\xfa\xed\xfeNODE"),
                                     ("server/module with spaces.node", 0o644, b"\xca\xfe\xba\xbeFAT"),
                                     ("server/README", 0o640, b"unchanged"),
                                     ("server/._README", 0o644, b"AppleDouble metadata")):
                info = tarfile.TarInfo(name)
                info.mode, info.uid, info.gid, info.mtime = mode, 501, 20, 123456789
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            link = tarfile.TarInfo("server/node-link")
            link.type, link.linkname = tarfile.SYMTYPE, "node"
            tf.addfile(link)
        self.before = self.members()
        self.result = self.root / "notary.json"
        self.env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                        SIGN_TEST_ROOT=str(self.root), DISPATCH_SIGNING_IDENTITY=IDENTITY,
                        DISPATCH_NOTARIZE="1", DISPATCH_NOTARIZE_REQUIRED="1", DISPATCH_NOTARY_RESULT=str(self.result))

    def run_sign(self, **env):
        return subprocess.run(["bash", str(self.root / "sign.sh"), str(self.app)],
                              env=dict(self.env, **env), text=True, capture_output=True, timeout=30)

    def members(self):
        with tarfile.open(self.archive) as tf:
            return [(m.name, m.mode, m.uid, m.gid, m.mtime, m.type, m.linkname,
                     tf.extractfile(m).read() if m.isfile() else None) for m in tf]

    def calls(self):
        return [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]

    def test_archive_signed_before_app_with_metadata_and_links_preserved(self):
        p = self.run_sign()
        self.assertEqual(p.returncode, 0, p.stderr)
        after = self.members()
        self.assertEqual([m[:7] for m in after], [m[:7] for m in self.before])
        self.assertEqual([m[7] for m in after], [self.before[0][7] + b"SIGNED", self.before[1][7] + b"SIGNED",
                                               b"unchanged", b"AppleDouble metadata", None])
        calls = self.calls()
        signed = [(i, c) for i, c in enumerate(calls) if c[0] == "codesign" and "--force" in c]
        self.assertEqual(len(signed), 2)  # the symlink must not sign its target twice
        for i, c in signed:
            self.assertLess(i, next(j for j, c in enumerate(calls) if c[0] == "fnm"))
            self.assertIn("--timestamp", c)
            self.assertEqual(c[c.index("--options") + 1], "runtime")
            self.assertTrue(c[c.index("--entitlements") + 1].endswith("/server-entitlements.plist"))
        result = json.loads(self.result.read_text())
        self.assertEqual((result["status"], result["id"], result["signed"], result["stapled"]),
                         ("Accepted", "submission-test", True, True))

    def test_osx_sign_from_the_checkout_else_its_own_copy(self):
        # a checkout that never ran npm ci (it only signs builds fetched from the mini): the pinned version, once, in .cache
        self.assertEqual(self.run_sign(DISPATCH_NOTARIZE="0").returncode, 0)
        cache = str(self.root / ".cache/osx-sign-2.0.0")
        self.assertIn(["fnm", "exec", "--using", "22", "npm", "install", "--prefix", cache, "--no-save", "--no-audit", "--no-fund",
                       "--silent", "@electron/osx-sign@2.0.0"], self.calls())
        self.assertEqual((self.root / "osx-sign.txt").read_text(), cache + "/node_modules/@electron/osx-sign")
        # VS Code's build dependencies installed in the checkout: those
        own = self.root / "vscode/build/node_modules/@electron/osx-sign"
        (own / "dist").mkdir(parents=True)
        (own / "dist/index.js").write_text("")
        self.assertEqual(self.run_sign(DISPATCH_NOTARIZE="0").returncode, 0)
        self.assertEqual((self.root / "osx-sign.txt").read_text(), str(own))

    def test_invalid_fails_and_keeps_submission_and_log(self):
        p = self.run_sign(SIGN_TEST_STATUS="Invalid")
        self.assertNotEqual(p.returncode, 0)
        result = json.loads(self.result.read_text())
        self.assertEqual((result["status"], result["id"], result["stapled"]), ("Invalid", "submission-test", False))
        self.assertTrue(Path(result["log"]).is_file())
        self.assertFalse(any(c[:2] == ["xcrun", "stapler"] for c in self.calls()))

    def test_timeout_preserves_submission_for_followup(self):
        p = self.run_sign(SIGN_TEST_STATUS="timeout")
        self.assertNotEqual(p.returncode, 0)
        result = json.loads(self.result.read_text())
        self.assertEqual((result["status"], result["id"]), ("In Progress", "submission-test"))

    def test_unavailable_info_keeps_uploaded_submission(self):
        p = self.run_sign(SIGN_TEST_STATUS="timeout", SIGN_TEST_INFO_FAIL="1")
        self.assertNotEqual(p.returncode, 0)
        result = json.loads(self.result.read_text())
        self.assertEqual((result["status"], result["id"], result["stapled"]),
                         ("Submitted", "submission-test", False))

    def test_no_notarize_never_calls_notarytool(self):
        p = self.run_sign(DISPATCH_NOTARIZE="0")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(self.result.read_text())["status"], "Not requested")
        self.assertFalse(any(c[0] == "xcrun" for c in self.calls()))

    def test_stapling_failure_keeps_accepted_but_not_stapled(self):
        p = self.run_sign(SIGN_TEST_STAPLE_FAIL="1")
        self.assertNotEqual(p.returncode, 0)
        result = json.loads(self.result.read_text())
        self.assertEqual((result["status"], result["stapled"]), ("Accepted", False))

    def test_binary_failure_preserves_archive_and_clears_old_result(self):
        old_archive = self.archive.read_bytes()
        self.result.write_text('{"status":"Accepted","id":"old","stapled":true}')
        p = self.run_sign(SIGN_TEST_BINARY_FAIL="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.archive.read_bytes(), old_archive)
        result = json.loads(self.result.read_text())
        self.assertFalse(result["signed"])
        self.assertEqual(result["status"], "Not submitted")
        self.assertNotIn("id", result)


if __name__ == "__main__":
    unittest.main()
