# -*- coding: utf-8 -*-
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

WINDOWS_READY = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import code_search as C  # noqa: E402

DIMS = 16


def fake_vec(text):
    """Bag of words hashed into 16 buckets: texts sharing words point the same way."""
    v = [0.0] * DIMS
    for w in re.findall(r"[a-z_]{3,}", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIMS] += 1.0
    return v if any(v) else [1.0] + [0.0] * (DIMS - 1)


class FakeEmbed(object):
    def __init__(self):
        self.calls = []

    def __call__(self, texts, key, timeout=None):
        self.calls.append(list(texts))
        return [fake_vec(t) for t in texts], sum(len(t) // 4 for t in texts)

    @property
    def texts(self):
        return [t for c in self.calls for t in c]


PY = '''import os


def load_settings(path):
    """Read the settings file."""
    with open(path) as f:
        return f.read()


class Server(object):
    def start(self, port):
        return "listening on %d" % port

    def stop(self):
        return "stopped"


def to_adapter(sess, text):
    """Prepend the pending system notes to what the agent gets."""
    notes = sess.notes
    return "".join("[system] " + n for n in notes) + text
'''

MD = "# Guide\n\nSome intro.\n\n## Install\n\nRun the installer.\n\n## Usage\n\nCall the thing.\n"


def git(root, *args):
    subprocess.run(["git", "-C", root] + list(args), check=True, capture_output=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dd = os.path.join(self.tmp, "dispatch")
        self.root = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(self.root, "src"))
        self.env = mock.patch.dict(os.environ, {"DISPATCH_DIR": self.dd, "OPENAI_API_KEY": "sk-test"})
        self.env.start()
        self.fake = FakeEmbed()
        self.emb = mock.patch.object(C, "embed", self.fake)
        self.emb.start()
        self.rec = mock.patch.object(C, "_record_use", lambda tokens: None)
        self.rec.start()

    def tearDown(self):
        self.rec.stop()
        self.emb.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, text, mode="w"):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, mode) as f:
            f.write(text)
        return p

    def bump(self, rel):
        """A new mtime even on file systems with coarse timestamps."""
        p = os.path.join(self.root, rel)
        t = time.time() + 5
        os.utime(p, (t, t))


class ChunkTest(unittest.TestCase):
    def test_python_cut_at_definitions_and_packed(self):
        chunks = C.chunk_text(PY, "a.py")
        self.assertTrue(chunks)
        # everything fits in one chunk (small file): packed, starts at line 1
        self.assertEqual(chunks[0][0], 1)
        big = PY + "\n".join("def f%d(x):\n    return x + %d\n" % (i, i) + "    # " + "pad " * 60 for i in range(40))
        chunks = C.chunk_text(big, "a.py")
        self.assertGreater(len(chunks), 3)
        for s, e, text in chunks:
            self.assertLessEqual(len(text), C.MAX_CHUNK_CHARS)
            self.assertLessEqual(s, e)
        starts = [s for s, _, _ in chunks[1:]]
        lines = big.split("\n")
        # later chunks begin at a def (or a comment right above one)
        self.assertTrue(all(re.match(r"\s*(def|class|#)", lines[s - 1]) for s in starts))

    def test_long_function_gets_overlapping_windows(self):
        body = "def huge():\n" + "".join("    x%d = %d\n" % (i, i) for i in range(300))
        chunks = C.chunk_text(body, "h.py")
        self.assertGreater(len(chunks), 3)
        for (s1, e1, _), (s2, e2, _) in zip(chunks, chunks[1:]):
            self.assertLess(s2, e1 + 1, "windows overlap")
            self.assertGreater(s2, s1)
        self.assertEqual(chunks[-1][1], 301)

    def test_markdown_headings_and_unknown_language(self):
        chunks = C.chunk_text(MD, "g.md")
        self.assertEqual(chunks[0][0], 1)
        plain = "\n".join("line %d" % i for i in range(200))
        chunks = C.chunk_text(plain, "notes.txt")
        self.assertTrue(all(e - s < C.WINDOW_LINES for s, e, _ in chunks))
        self.assertEqual(C.chunk_text("", "x.py"), [])

    def test_decorator_stays_with_its_function(self):
        text = "x = 1\n" + "y = 2\n" * 5 + "@decorator\ndef f():\n    pass\n" + "z = 3\n" * 80
        chunks = C.chunk_text(text, "d.py")
        starts = [s for s, _, _ in chunks]
        lines = text.split("\n")
        self.assertFalse(any(lines[s - 1].startswith("def f") for s in starts), "def f is not split from @decorator")


class QueryTest(unittest.TestCase):
    def test_stop_words_and_short_terms_dropped(self):
        q = C.fts_query("chatd 怎么给 Agent 前置 system note")
        self.assertIn('"chatd"', q)
        self.assertIn('"system"', q)
        self.assertNotIn("怎么", q)
        self.assertNotIn("前置", q)

    def test_chinese_runs_become_trigrams_and_identifiers_split(self):
        q = C.fts_query("回滚检查点 to_adapter")
        self.assertIn('"检查点"', q)
        self.assertIn('"to_adapter"', q)
        self.assertIn('"adapter"', q)
        self.assertEqual(C.fts_query("怎么 的"), "")

    def test_unicode61_uses_prefix_terms(self):
        self.assertIn('"id"*', C.fts_query("id lookup", "unicode61"))

    def test_rrf(self):
        ranked = C.fuse([[1, 2, 3], [3, 4]])
        self.assertEqual(ranked[0][0], 3)
        self.assertEqual({r[0] for r in ranked}, {1, 2, 3, 4})


class IndexTest(Base):
    def setUp(self):
        Base.setUp(self)
        self.write("src/app.py", PY)
        self.write("README.md", MD)
        self.write("node_modules/dep/index.js", "module.exports = 1\n")
        self.write("logo.png", "\x89PNG fake", "w")
        self.write("package-lock.json", "{}")
        self.write("blob.dat", "x")
        with open(os.path.join(self.root, "bin.txt"), "wb") as f:
            f.write(b"abc\0def")
        git(self.root, "init", "-q")
        self.write(".gitignore", "ignored/\n")
        self.write("ignored/secret.py", "SECRET = 1\n")

    def test_first_index_then_incremental(self):
        r = C.index(self.root)
        self.assertTrue(r["fresh"])
        self.assertEqual(r["mode"], "hybrid")
        paths = {p for (p,) in sqlite(r["db"], "SELECT path FROM files")}
        self.assertEqual(paths, {"src/app.py", "README.md", ".gitignore"})
        self.assertEqual(r["embedded"], r["chunks"])
        self.assertGreater(r["tokens"], 0)
        # nothing changed: nothing re-read, nothing embedded
        n_calls = len(self.fake.calls)
        r2 = C.index(self.root)
        self.assertFalse(r2["fresh"])
        self.assertEqual(r2["changed_files"], 0)
        self.assertEqual(r2["embedded"], 0)
        self.assertEqual(len(self.fake.calls), n_calls)
        # one file changed: only its new chunks are embedded
        self.write("src/app.py", PY + "\n\ndef brand_new_helper():\n    return 42\n")
        self.bump("src/app.py")
        r3 = C.index(self.root)
        self.assertEqual(r3["changed_files"], 1)
        self.assertGreaterEqual(r3["embedded"], 1)
        self.assertLessEqual(r3["embedded"], 2)
        self.assertTrue(all(t.startswith("src/app.py") for t in self.fake.calls[-1]))
        # touched but same content: sha matches, no new chunks
        self.bump("README.md")
        r4 = C.index(self.root)
        self.assertEqual(r4["changed_files"], 0)
        self.assertEqual(r4["new_chunks"], 0)
        # deleted: gone from the index
        os.unlink(os.path.join(self.root, "README.md"))
        r5 = C.index(self.root)
        self.assertEqual(r5["removed_files"], 1)
        self.assertNotIn("README.md", {p for (p,) in sqlite(r5["db"], "SELECT path FROM files")})
        self.assertEqual(sqlite(r5["db"], "SELECT count(*) FROM fts")[0][0], r5["chunks"])

    def test_single_file_update(self):
        C.index(self.root)
        self.write("src/other.py", "def other_thing():\n    return 'other'\n")
        r = C.index(self.root, files=[os.path.join(self.root, "src/other.py")])
        self.assertEqual(r["changed_files"], 1)
        self.assertIn("src/other.py", {p for (p,) in sqlite(r["db"], "SELECT path FROM files")})
        # the file list is not re-walked, so nothing else was dropped
        self.assertEqual(r["removed_files"], 0)
        self.assertEqual(r["files"], 4)

    def test_search_hybrid_then_keyword_without_key(self):
        C.index(self.root)
        res = C.search("how are system notes put in front for the agent", self.root)
        self.assertEqual(res["mode"], "hybrid")
        self.assertTrue(res["results"])
        self.assertIn("to_adapter", "".join(r["text"] for r in res["results"][:3]))
        top = res["results"][0]
        self.assertEqual(set(top), {"path", "start", "end", "score", "via", "text"})
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            res = C.search("to_adapter system notes", self.root)
        self.assertEqual(res["mode"], "keyword")
        self.assertEqual(res["reason"], "no_key")
        self.assertEqual(res["results"][0]["path"], "src/app.py")

    def test_keyword_flag_and_embed_failure(self):
        C.index(self.root)
        res = C.search("to_adapter", self.root, keyword=True)
        self.assertEqual(res["mode"], "keyword")
        self.assertTrue(res["results"])

        def boom(texts, key, timeout=None):
            raise C.SearchError("embed_failed", "offline")
        with mock.patch.object(C, "embed", boom):
            res = C.search("to_adapter", self.root)
        self.assertEqual(res["mode"], "keyword")
        self.assertEqual(res["reason"], "embed_failed")
        self.assertTrue(res["results"])

    def test_no_key_builds_keyword_index_and_embeds_later(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            r = C.index(self.root)
        self.assertEqual(r["mode"], "keyword")
        self.assertEqual(r["unembedded"], r["chunks"])
        self.assertEqual(self.fake.calls, [])
        r2 = C.index(self.root)
        self.assertEqual(r2["embedded"], r["chunks"])
        self.assertEqual(r2["mode"], "hybrid")

    def test_model_change_reembeds(self):
        r = C.index(self.root)
        with mock.patch.object(C, "EMBED_DIMS", DIMS + 1):
            r2 = C.index(self.root)
        self.assertEqual(r2["embedded"], r["chunks"])

    def test_embed_failure_keeps_chunks_for_next_run(self):
        def boom(texts, key, timeout=None):
            raise C.SearchError("embed_failed", "429")
        with mock.patch.object(C, "embed", boom):
            r = C.index(self.root)
        self.assertEqual(r["reason"], "embed_failed")
        self.assertEqual(r["embedded"], 0)
        self.assertGreater(r["chunks"], 0)
        r2 = C.index(self.root)
        self.assertEqual(r2["embedded"], r["chunks"])

    def test_refresh_only_updates_existing_index(self):
        self.assertIsNone(C.refresh(self.root))
        self.assertFalse(os.path.exists(C.db_path(self.root)))
        C.index(self.root)
        self.write("src/new.py", "def fresh():\n    pass\n")
        r = C.refresh(self.root)
        self.assertEqual(r["changed_files"], 1)
        self.assertIsNone(C.refresh(os.path.join(self.tmp, "missing")))

    def test_busy_lock_skips(self):
        C.index(self.root)
        with C.Lock(C.resolve_root(self.root)) as lk:
            self.assertTrue(lk.held)
            self.assertEqual(C.index(self.root, wait=0)["skipped"], "busy")
            res = C.search("to_adapter", self.root)
            self.assertTrue(res.get("indexing"))
            self.assertTrue(res["results"])
        # a lock left by a dead process is taken over
        with open(C.db_path(C.resolve_root(self.root)) + ".lock", "w") as f:
            f.write("999999")
        self.assertNotIn("skipped", C.index(self.root, wait=0))

    def test_status(self):
        s = C.status(self.root)
        self.assertFalse(s["exists"])
        C.index(self.root)
        s = C.status(self.root)
        self.assertTrue(s["exists"])
        self.assertEqual(s["embedded"], s["chunks"])
        self.assertEqual(s["mode"], "hybrid")
        self.assertIsNone(s["building"])
        C._progress(C.resolve_root(self.root), "embed", 3, 10)
        self.assertEqual(C.status(self.root)["building"]["done"], 3)

    def test_projects_do_not_share_an_index(self):
        other = os.path.join(self.tmp, "proj2")
        os.makedirs(other)
        self.assertNotEqual(C.db_path(C.resolve_root(self.root)), C.db_path(other))


class WalkTest(Base):
    def test_non_git_folder_skips_dependencies_binaries_and_big_files(self):
        self.write("main.rs", "fn main() {\n    println!(\"hi\");\n}\n")
        self.write("node_modules/x/y.js", "x")
        self.write("target/debug/out.rs", "fn x() {}\n")
        self.write(".hidden/secret.py", "x = 1\n")
        self.write("Cargo.lock", "lock")
        self.write("big.py", "x = 1\n" * 200000)
        self.write("min.js", "var a=1;" * 600 + "\n")
        rels, cut = C.list_files(self.root)
        self.assertFalse(cut)
        self.assertIn("main.rs", rels)
        self.assertNotIn("node_modules/x/y.js", rels)
        self.assertNotIn("target/debug/out.rs", rels)
        self.assertNotIn(".hidden/secret.py", rels)
        self.assertNotIn("Cargo.lock", rels)
        r = C.index(self.root)
        paths = {p for (p,) in sqlite(r["db"], "SELECT path FROM files")}
        self.assertEqual(paths, {"main.rs"})


class SecretTest(Base):
    """Secrets stay out of the embedding requests and out of the index file."""

    def setUp(self):
        Base.setUp(self)
        git(self.root, "init", "-q")
        self.write("app.py", PY + '\nOPENAI = "sk-live-SECRET0abcdefghijklmnopqrstuv"\nDB_PASSWORD = "SECRET9-hunter2"\n')
        self.write(".env", "OPENAI_API_KEY=sk-live-SECRET1\n")
        self.write(".env.production", "TOKEN=SECRET2\n")
        self.write(".env.example", "OPENAI_API_KEY=\n")
        self.write("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET3\n-----END OPENSSH PRIVATE KEY-----\n")
        self.write("credentials.json", '{"key": "SECRET4"}\n')
        self.write("notes/deploy.txt", "the key:\n-----BEGIN RSA PRIVATE KEY-----\nSECRET8\n-----END RSA PRIVATE KEY-----\n")
        self.write(".envrc", "export API=SECRET10\n")
        git(self.root, "add", "credentials.json", "app.py")
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "creds.txt"), "w") as f:
            f.write("SECRET5\n")
        os.symlink(os.path.join(outside, "creds.txt"), os.path.join(self.root, "link.txt"))
        os.symlink("app.py", os.path.join(self.root, "inside-link.py"))

    def assert_clean(self, db):
        sent = "\n".join(self.fake.texts)
        blob = b""
        for p in (db, db + "-wal"):
            if os.path.exists(p):
                blob += open(p, "rb").read()
        for n in range(11):
            self.assertNotIn("SECRET%d" % n, sent)
            self.assertNotIn(b"SECRET%d" % n, blob)

    def test_secret_files_links_and_values_never_leave(self):
        r = C.index(self.root)
        paths = {p for (p,) in sqlite(r["db"], "SELECT path FROM files")}
        self.assertEqual(paths, {"app.py", ".env.example", "inside-link.py"})
        self.assert_clean(r["db"])
        self.assertIn(C.REDACTED, "\n".join(self.fake.texts))
        # the index folder and files are private (POSIX modes; Windows has ACLs instead)
        if os.name != "nt":
            self.assertEqual(os.stat(C.index_dir()).st_mode & 0o777, 0o700)
            for p in (r["db"], r["db"] + "-wal"):
                if os.path.exists(p):
                    self.assertEqual(os.stat(p).st_mode & 0o777, 0o600, p)
        # naming a secret file explicitly does not index it either
        C.index(self.root, files=[".env", "id_ed25519", "link.txt"])
        self.assert_clean(r["db"])
        self.assertEqual({p for (p,) in sqlite(r["db"], "SELECT path FROM files")}, paths)

    def test_index_from_before_the_filter_is_cleaned(self):
        with mock.patch.object(C, "secret_path", lambda rel: False), mock.patch.object(C, "redact", lambda t: t):
            r = C.index(self.root)
        self.assertIn(".env", {p for (p,) in sqlite(r["db"], "SELECT path FROM files")})
        import sqlite3
        db = sqlite3.connect(r["db"])
        db.execute("DELETE FROM meta WHERE k='filter'")
        db.commit()
        db.close()
        self.fake.calls[:] = []
        r = C.index(self.root)
        self.assertEqual({p for (p,) in sqlite(r["db"], "SELECT path FROM files")}, {"app.py", ".env.example", "inside-link.py"})
        for (text,) in sqlite(r["db"], "SELECT text FROM chunks"):
            self.assertNotIn("SECRET", text)

    def test_names(self):
        for rel in (".env", ".env.local", "prod.env", "id_rsa", "id_ed25519.pub", "a/.ssh/config", "server.pem", "x.p12",
                    "credentials.json", "config/client_secret_1.json", "secrets.yaml", ".npmrc", ".netrc", ".envrc", "terraform.tfstate"):
            self.assertTrue(C.secret_path(rel), rel)
        for rel in (".env.example", "app.py", "src/secret_store.rs", "tokens.ts", "environment.ts", ".github/workflows/ci.yml", "README.md"):
            self.assertFalse(C.secret_path(rel), rel)
        self.assertEqual(C.redact("token = config.token\nmax_tokens = 1000\n"), "token = config.token\nmax_tokens = 1000\n")
        self.assertEqual(C.redact('aws = AKIAABCDEFGHIJKLMNOP'), "aws = " + C.REDACTED)


class MoreSecretsTest(Base):
    """The forms the first filter let through: Bearer headers, KEY=value # comment, .dev.vars,
    Stripe whsec_, a "pwd" key. Keyword search (no embeddings) must not print them either."""

    def setUp(self):
        Base.setUp(self)
        git(self.root, "init", "-q")
        self.write("app/.dev.vars", "STRIPE=whsec_1234567890abcdefghijkl\n")
        self.write("config.local.json", '{"host": "db", "pwd": "hunter2hunter2X9"}\n')
        self.write("client.py", "def call_payment_gateway():\n"
                   "    headers = {'Authorization': 'Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0zz'}\n"
                   "API_KEY=abc123def456ghi789 # prod key\n"
                   "WEBHOOK = 'whsec_abcdefghijklmnop1234'\n"
                   "STRIPE_KEY = sk_live_abcdefghijklmnop1234\n")

    def test_none_of_it_reaches_the_results_or_the_index(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            r = C.search("call_payment_gateway Authorization STRIPE pwd", self.root, keyword=True)
        out = json.dumps(r)
        for secret in ("whsec_1234567890", "hunter2hunter2X9", "9f8e7d6c5b4a39281706", "abc123def456ghi789", "whsec_abcdefghijklmnop", "sk_live_abcdefghijklmnop"):
            self.assertNotIn(secret, out, secret)
        self.assertIn("call_payment_gateway", out)
        self.assertNotIn(".dev.vars", out)
        db = C.db_path(self.root)
        blob = b"".join(open(p, "rb").read() for p in (db, db + "-wal") if os.path.exists(p))
        for secret in (b"whsec_1234567890", b"hunter2hunter2X9", b"9f8e7d6c5b4a39281706", b"abc123def456ghi789"):
            self.assertNotIn(secret, blob)

    def test_ordinary_code_stays_readable(self):
        for line in ("token = config.token", "max_tokens = 1000", "author = 'someone1234567'", "compass = 123456789012345",
                     "const auth = `Bearer ${this.key}`", "password = get_pass()"):
            self.assertEqual(C.redact(line), line)
        self.assertTrue(C.secret_path("worker/.dev.vars"))
        self.assertTrue(C.secret_path(".dev.vars.staging"))
        self.assertFalse(C.secret_path(".dev.vars.example"))


class RootTest(Base):
    def test_outside_git_needs_root_and_sends_nothing(self):
        plain = os.path.join(self.tmp, "fakehome", "Documents")
        os.makedirs(plain)
        with open(os.path.join(plain, "finance.txt"), "w") as f:
            f.write("SECRET6 hello\n")
        cwd = os.getcwd()
        os.chdir(plain)
        try:
            for fn in (lambda: C.search("hello", ""), lambda: C.index(None), lambda: C.status(None)):
                with self.assertRaises(C.SearchError) as cm:
                    fn()
                self.assertEqual(cm.exception.code, "not_a_repo")
        finally:
            os.chdir(cwd)
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(os.path.exists(C.index_dir()) and os.listdir(C.index_dir()))

    def test_home_and_above_are_refused(self):
        home = os.path.join(self.tmp, "fakehome")
        os.makedirs(os.path.join(home, "sub"))
        git(home, "init", "-q")  # a dotfiles repo at ~ must not turn into "index my whole home"
        with mock.patch.object(C.P, "HOME", home):
            for root in (home, self.tmp, "/"):
                with self.assertRaises(C.SearchError) as cm:
                    C.resolve_root(root)
                self.assertEqual(cm.exception.code, "root_too_broad")
            cwd = os.getcwd()
            os.chdir(os.path.join(home, "sub"))
            try:
                with self.assertRaises(C.SearchError) as cm:
                    C.search("hello", "")
                self.assertEqual(cm.exception.code, "root_too_broad")
            finally:
                os.chdir(cwd)
            self.assertEqual(C.resolve_root(os.path.join(home, "sub")), os.path.realpath(os.path.join(home, "sub")))
        self.assertEqual(self.fake.calls, [])


class CliTest(Base):
    def run_main(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = C.main(list(argv))
        return code, buf.getvalue()

    def test_index_status_query_json(self):
        self.write("src/app.py", PY)
        code, out = self.run_main("index", "--root", self.root, "--json")
        self.assertEqual(code, 0)
        r = json.loads(out)
        self.assertGreater(r["chunks"], 0)
        code, out = self.run_main("status", "--root", self.root, "--json")
        self.assertTrue(json.loads(out)["exists"])
        code, out = self.run_main("to_adapter", "notes", "--root", self.root, "--json", "-n", "2")
        r = json.loads(out)
        self.assertEqual(r["query"], "to_adapter notes")
        self.assertLessEqual(len(r["results"]), 2)
        code, out = self.run_main("search", "index", "--root", self.root, "--json")
        self.assertEqual(json.loads(out)["query"], "index")
        code, out = self.run_main("to_adapter", "--root", self.root)
        self.assertIn("src/app.py:", out)

    def test_errors(self):
        code, out = self.run_main("--root", self.root, "--json")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["error"], "usage")
        code, out = self.run_main("status", "--root", os.path.join(self.tmp, "nope"), "--json")
        self.assertEqual(json.loads(out)["error"], "no_root")

    def test_dispatch_hands_over(self):
        self.write("src/app.py", PY)
        env = dict(os.environ, OPENAI_API_KEY="")
        r = subprocess.run([sys.executable, os.path.join(HERE, "dispatch.py"), "code-search", "to_adapter", "--root", self.root, "--json"],
                           capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertEqual(d["mode"], "keyword")
        self.assertEqual(d["results"][0]["path"], "src/app.py")


def sqlite(path, q):
    import sqlite3
    db = sqlite3.connect(path)
    try:
        return db.execute(q).fetchall()
    finally:
        db.close()


if __name__ == "__main__":
    unittest.main()
