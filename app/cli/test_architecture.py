# -*- coding: utf-8 -*-
"""ARCHITECTURE.md is the map agents read instead of searching the code. It goes stale the moment a module is
added, removed or renamed without it, so this checks both directions: every module the map is meant to name is
named, and every path or file name it mentions still exists. .githooks/pre-commit runs it before every commit."""
import os
import re
import subprocess
import unittest

WINDOWS_READY = True

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VS = "ide/vscode/src/vs/"
FEATURE = re.compile(r"^ide/vscode/src/vs/(?:sessions|workbench)/contrib/(dispatch[A-Z]\w*)/")
SHORT_ROOTS = ("sessions/", "workbench/", "platform/", "base/", "code/")


def tracked():
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, timeout=60, check=True)
    return out.stdout.splitlines()


def mentions(doc, name):
    return re.search(r"(?<![\w.-])" + re.escape(name) + r"(?![\w-])", doc) is not None


def mentions_dir(doc, path):
    return re.search(r"(?<![\w/])" + re.escape(path) + r"/?(?![\w/])", doc) is not None


def is_test(path):
    base = os.path.basename(path)
    return "/test/" in path or "/testkit/" in path or base.startswith("test_") or ".test." in base


class Architecture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "ARCHITECTURE.md"), encoding="utf-8") as f:
            cls.doc = f.read()
        cls.files = tracked()

    def missing(self, wanted, found):
        return sorted(w for w in wanted if not found(self.doc, w))

    def test_every_cli_module_is_named(self):
        wanted = {os.path.basename(p) for p in self.files
                  if p.startswith("app/cli/") and p.endswith(".py") and not is_test(p)}
        self.assertEqual(self.missing(wanted, mentions), [], "add these CLI modules to ARCHITECTURE.md")

    def test_every_bridge_file_is_named(self):
        wanted = {os.path.basename(p) for p in self.files if re.match(r"^app/ide-ext/src/[^/]+\.ts$", p)}
        self.assertEqual(self.missing(wanted, mentions), [], "add these dispatch-bridge files to ARCHITECTURE.md")

    def test_every_ide_feature_folder_is_named(self):
        wanted = {m.group(1) for m in map(FEATURE.match, self.files) if m}
        self.assertEqual(self.missing(wanted, mentions), [], "add these Dispatch IDE feature folders to ARCHITECTURE.md")

    def test_every_folder_with_our_files_inside_vscode_is_named(self):
        wanted = set()
        for p in self.files:
            if not p.startswith("ide/vscode/") or FEATURE.match(p) or is_test(p) or "/media/" in p:
                continue
            if p.endswith((".css", ".svg", ".ttf")):
                continue
            parts = p.split("/")
            hit = next((i for i, s in enumerate(parts) if s.startswith("dispatch")), None)
            if hit is not None:
                folder = "/".join(parts[:hit])
                wanted.add(folder[len(VS):] if folder.startswith(VS) else folder)
        self.assertEqual(self.missing(wanted, mentions_dir), [], "name these folders (our dispatch* files in VS Code's tree)")

    def test_every_top_folder_is_named(self):
        wanted = {"/".join(p.split("/")[:2]) for p in self.files
                  if p.split("/")[0] in ("app", "agent", "ide") and p.count("/") >= 2}
        self.assertEqual(self.missing(wanted, mentions_dir), [], "add these folders to ARCHITECTURE.md")

    def test_named_paths_exist(self):
        dirs = {p[:i] for p in self.files for i in [m.start() for m in re.finditer("/", p)]}
        known = set(self.files) | dirs
        stale = []
        for token in re.findall(r"`([^`\s<>*{}]+/[^`\s<>*{}]*)`", self.doc):
            path = token.rstrip("/")
            if path.startswith(SHORT_ROOTS):
                path = VS + path
            if path.startswith(("app/", "agent/", "ide/", "docs/", ".githooks/")) and path not in known:
                stale.append(token)
        self.assertEqual(stale, [], "these paths in ARCHITECTURE.md do not exist")

    def test_named_files_exist(self):
        bases = {os.path.basename(p) for p in self.files}
        stems = {os.path.splitext(s)[0] for p in self.files for s in p.split("/")}
        stale = [n for n in re.findall(r"(?<![\w.-])([\w-]+\.(?:py|ts))(?![\w-])", self.doc) if n not in bases]
        stale += [n for n in re.findall(r"(?<![\w])(dispatch[A-Z]\w*)", self.doc)
                  if not any(s.startswith(n) for s in stems)]
        self.assertEqual(sorted(set(stale)), [], "these names in ARCHITECTURE.md match no file")


if __name__ == "__main__":
    unittest.main()
